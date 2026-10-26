<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { Bold, Italic } from 'lucide-vue-next'
import IconButton from '@/ui/IconButton.vue'
import { pageViewSize } from '@margin/transform'
import type { PageState } from '@/stores/document'
import type {
  Color, EditObject, PageQuadIndex, TextPatchObject,
} from '@margin/pdf-core'
import { isBoldWeight, patchRuns, runsAdvance, weightOf } from '@margin/pdf-core'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { useViewportStore } from '@/stores/viewport'
import { getPdfClient } from '@/workers/pdfClient'
import {
  fontsForExport, measureText, cssFamily, cssWeight, cssStyle, faceKey, loadFont,
  DEFAULT_FAMILY,
} from '@/lib/fonts'
import { familyForLine, needsReplacementChoice, rememberReplacement } from '@/lib/fontMatch'
import FontReplacementDialog from './FontReplacementDialog.vue'
import { rgb } from '@/features/overlay/objects/svgPaint'
import { noZoomTextSize } from '@/lib/textFieldZoom'
import { sampleBackground, CONFIDENT_ENOUGH } from './sampleBackground'
import {
  buildLinePatch, documentStyle, lineBox, patchOnLine, plainColor,
} from './linePatch'
import { lineTargetRect } from './editTargets'
import {
  mergeRuns, readRuns, renderRuns, restyleRange, runsIn, selectOffsets, selectionOffsets,
  textOf, toPatchFields, type EditRun,
} from './richLine'
import { sameSpans } from './linePatch'
import { fitStyle, hasItalic } from '@/lib/fonts'

const props = defineProps<{
  page: PageState
  zoom: number
  index: PageQuadIndex | undefined
}>()

const edits = useEditsStore()
const tools = useToolsStore()
const vp = useViewportStore()

/** Which line is being edited, by index into the page's extraction. */
const editing = ref<number | undefined>(undefined)
/**
 * The patch already on the line being edited, if there is one.
 *
 * Editing a line that has been edited before must CHANGE that patch, not
 * add a second one on top. Adding a second one is what used to happen:
 * both covered the same line and both drew their own text, so the second
 * edit came out overlapping the first -- two strings of glyphs printed
 * over each other, in the export as well as on screen.
 */
const editingId = ref<string | undefined>(undefined)

/**
 * The patch on a given line, if the user has already edited it. Shared with
 * the selection toolbar, which can style the same line without ever opening
 * this editor -- and a second answer to "which patch covers this line"
 * would let the two of them add one each.
 */
const patchOn = (lineIndex: number): TextPatchObject | undefined =>
  patchOnLine(Object.values(edits.doc.objects), props.page.id, lineIndex)
const draft = ref('')
/**
 * The weight the replacement will be drawn in: CSS 100 to 800.
 *
 * Seeded from the line's OWN font, not from a default. The extraction
 * reads the weight off the embedded font program and `buildQuadIndex`
 * carries it through, so retyping a bold heading stays bold and a Medium
 * one stays Medium. It used to come out regular every time -- the patch
 * hardcoded the default face -- which read as the editor having thrown
 * away formatting it could see perfectly well.
 *
 * Held here rather than read off `line` at commit time so that re-editing a
 * patch resumes from the weight the user chose, not from the weight the
 * document started with.
 */
const weight = ref(400)
/**
 * The family the replacement is drawn in: the one the line's own font is,
 * when it is in our set, and Inter when it is not. The patch's own family
 * once it has one, read live from the store, so a change made in the
 * inspector while the field is open is the family typed in.
 */
const seededFamily = ref(DEFAULT_FAMILY)
const family = computed(() => {
  const stored = editingId.value ? edits.doc.objects[editingId.value] : undefined
  return (stored && 'fontFamily' in stored && stored.fontFamily) || seededFamily.value
})
/**
 * The size the replacement will be set in, in page units.
 *
 * Seeded from the line's OWN size, which MuPDF reports per run, rather than
 * from a guess at the relationship between a glyph box and a font size. It
 * used to be stored as 0 -- "ask the writer to work it out at export" --
 * which was fine while nobody could change it and useless the moment
 * somebody could: an inspector cannot put a number in a box when the
 * document holds a sentinel.
 */
const size = ref(0)
/**
 * The colour the replacement will be filled with.
 *
 * Seeded from the line's own fill, which MuPDF reports per run. It used to
 * be hardcoded black, so replacing a word in a grey label turned that row
 * black -- the edit announced itself by being the only thing on the line in
 * the wrong colour, which is the opposite of what a text edit should look
 * like.
 */
const color = ref<Color>([0, 0, 0])
/**
 * Whether the replacement is set on a slant, inherited the same way the
 * weight is. `isItalic()` is reliable on embedded TrueType, which is what
 * real documents contain -- unlike `isSerif()`, which is not, and which is
 * why the FAMILY is still the user's choice rather than a guess.
 */
const italic = ref(false)
/**
 * What happens when the replacement is wider than the line it replaces.
 *
 * Defaults to letting it run, and there is no longer a control for it.
 * Shrinking was the old default and it silently made the user's text
 * smaller than everything around it; every inline editor people have used
 * lets typed text simply extend, and surprising them with a size change is
 * worse than a long line.
 *
 * The other modes are still honoured by the writer and still stored on the
 * object -- only the picker is gone, so restoring one is a UI change rather
 * than a format change.
 */
const fit = ref<'shrink' | 'overflow' | 'truncate'>('overflow')
/**
 * The letter spacing the patch already carries, in points, so the field
 * types at the width the committed line will be drawn at. Set from the
 * inspector, never here: the field has no control for it, and a commit
 * leaves it alone.
 */
const spacing = ref(0)
const missing = ref<string[]>([])
/**
 * The line waiting on the font-replacement dialog, if one is.
 *
 * Set when the user clicks a line whose font we do not carry and has not
 * edited before: nothing is created until they choose, so Cancel leaves
 * the page exactly as it was.
 */
const asking = ref<number | undefined>(undefined)
const askingLine = computed(() =>
  asking.value === undefined ? undefined : props.index?.lines[asking.value],
)
const askingBox = computed(() => {
  const l = askingLine.value
  return l && l.chars.length > 0 ? lineBox(l) : undefined
})
const input = ref<HTMLElement | null>(null)

/**
 * The line being typed, as styled runs: a bold name stays bold in the
 * field and in the stored patch. See richLine.ts.
 *
 * `draft`, `weight`, `italic` and `color` above are kept as the FIRST
 * run's, which is what the patch stores as its own style; the other runs
 * are stored as overrides of it.
 */
const runs = ref<EditRun[]>([])
/** The styles the field's spans were last rendered with, by index. */
let rendered: EditRun[] = []

const fallbackRun = (): EditRun => ({
  text: '', weight: weight.value, italic: italic.value, scale: 1, rise: 0,
  color: plainColor(color.value),
})

function syncFromRuns(): void {
  draft.value = textOf(runs.value)
  const first = runs.value[0]
  if (first) {
    weight.value = first.weight
    italic.value = first.italic
    color.value = first.color
  }
}

/** Re-render the field from `next`, keeping the selection where it was. */
function showRuns(next: EditRun[], selection?: [number, number]): void {
  runs.value = mergeRuns(next)
  syncFromRuns()
  const el = input.value
  if (!el) return
  rendered = renderRuns(el, runs.value)
  if (selection) selectOffsets(el, selection[0], selection[1])
}

/**
 * The field's element, bound as Vue creates it -- and filled, selected and
 * focused right then, in the same render, rather than after the fonts have
 * loaded. Filling it later left a window where the field was on screen
 * and empty: an Enter pressed in it committed nothing.
 */
let bound: HTMLElement | null = null
function bindField(el: unknown): void {
  const field = el instanceof HTMLElement ? el : null
  input.value = field
  if (!field || field === bound) { if (!field) bound = null; return }
  bound = field
  rendered = renderRuns(field, runs.value)
  // Focus and selection only take on an element in the document, and when
  // this editor itself is mounting, its field is bound before the editor
  // is inserted. So those two wait a tick when they have to.
  const activate = (): void => {
    if (bound !== field || !field.isConnected) return
    field.focus()
    selectOffsets(field, 0, [...draft.value].length)
    updateFieldSelection()
  }
  if (field.isConnected) activate()
  else void nextTick(activate)
}

/** What the browser did to the field, read back into runs. */
function onInput(): void {
  const el = input.value
  if (!el) return
  runs.value = readRuns(el, rendered, fallbackRun())
  syncFromRuns()
}

/** Pasted text arrives as plain text on one line, in the style at the caret. */
function onPaste(e: ClipboardEvent): void {
  e.preventDefault()
  const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/[\r\n]+/g, ' ')
  if (text) document.execCommand('insertText', false, text)
}

/** The browser's own formatting and line breaks are not this field's: it is one line, styled by us. */
function onBeforeInput(e: InputEvent): void {
  if (e.inputType.startsWith('format') || e.inputType === 'insertParagraph' ||
      e.inputType === 'insertLineBreak') {
    e.preventDefault()
  }
}

/**
 * The characters selected in the field, and where that selection is on
 * screen -- so a Bold / Italic bar can sit above it. Undefined when nothing
 * is selected.
 *
 * The reported question was "in Edit text mode, how do I make text bold?":
 * Ctrl+B worked and nothing on screen said so. The bar is the visible way,
 * and it appears for the selection the field opens with too, so it is
 * there to be found the moment a line is clicked.
 */
const layer = ref<HTMLElement | null>(null)
const fieldSelection = ref<{ start: number; end: number; left: number; top: number } | undefined>()

function updateFieldSelection(): void {
  const el = input.value
  const sel = el ? selectionOffsets(el) : undefined
  if (!el || !sel || sel[1] <= sel[0]) { fieldSelection.value = undefined; return }
  const range = el.ownerDocument.getSelection()?.getRangeAt(0)
  const at = range?.getBoundingClientRect?.()
  const origin = layer.value?.getBoundingClientRect()
  const field = el.getBoundingClientRect()
  // jsdom has no layout and reports zeros; the field's own corner is the
  // fallback, which is also where the bar belongs for a whole-line selection.
  const left = at && at.width > 0 ? at.left : field.left
  const top = at && at.height > 0 ? at.top : field.top
  fieldSelection.value = {
    start: sel[0], end: sel[1],
    left: left - (origin?.left ?? 0),
    top: top - (origin?.top ?? 0),
  }
}

onMounted(() => document.addEventListener('selectionchange', updateFieldSelection))
onBeforeUnmount(() => document.removeEventListener('selectionchange', updateFieldSelection))

/** Whether every visible selected run is already bold / italic: the buttons' pressed state. */
function selectionHas(axis: 'bold' | 'italic'): boolean {
  const s = fieldSelection.value
  if (!s) return false
  const inRange = runsIn(runs.value, s.start, s.end)
  const visible = inRange.filter((r) => r.text.trim() !== '')
  const judged = visible.length > 0 ? visible : inRange
  return judged.length > 0 &&
    judged.every((r) => (axis === 'bold' ? isBoldWeight(r.weight) : r.italic))
}
const selectionBold = computed(() => selectionHas('bold'))
const selectionItalic = computed(() => selectionHas('italic'))
const canItalic = computed(() => hasItalic(family.value))

/** Load every face the runs use, so the field shows the real bold, not a faked one. */
function loadRunFaces(): Promise<unknown> {
  return Promise.all(runs.value.map((r) => loadFont(family.value, r).catch(() => {})))
}

const line = computed(() => (editing.value === undefined ? undefined : props.index?.lines[editing.value]))

const originalText = computed(() =>
  line.value ? line.value.chars.map((c) => c.char).join('') : '',
)

/**
 * The line's box in MuPDF page space, from its character quads.
 *
 * The box in the SOURCE, which is the box the cover is painted over and
 * stays put however far the replacement has been dragged. Anything about
 * what is UNDER the line -- the background sample below -- has to use this
 * one. Anything about where the text the user can see IS has to use
 * `drawnAt`.
 */
const box = computed(() => {
  const l = line.value
  return l && l.chars.length > 0 ? lineBox(l) : undefined
})

/** How far a line's patch has dragged it from where the document put it. */
function offsetOf(lineIndex: number): { dx: number; dy: number } {
  const patch = patchOn(lineIndex)
  return { dx: patch?.offset?.dx ?? 0, dy: patch?.offset?.dy ?? 0 }
}

const offset = computed(() =>
  editing.value === undefined ? { dx: 0, dy: 0 } : offsetOf(editing.value),
)

const isMoved = computed(() => offset.value.dx !== 0 || offset.value.dy !== 0)

/**
 * Where the line is actually drawn -- its source box plus whatever the
 * user has dragged it by.
 *
 * Everything the user POINTS AT or LOOKS AT goes through this: the field,
 * the warnings hanging off it, and the click target. They were all reading
 * `box`, so after a move they stayed behind at the empty space the line had
 * left. The text the user could see had no target at all, and clicking the
 * gap where it used to be opened a field for it somewhere else entirely.
 */
const drawnAt = computed(() => {
  const b = box.value
  if (!b) return undefined
  return { ...b, x: b.x + offset.value.dx, y: b.y + offset.value.dy }
})

/**
 * What is behind this line, sampled from the page as rendered.
 *
 * Done here rather than in the writer because the app already has the
 * pixels; the writer would have to rasterise a page per patch to learn the
 * same thing.
 */
const background = computed(() => {
  const b = box.value
  if (!b) return undefined
  const bitmap = vp.bitmapFor(props.page.id)
  // The bitmap is rendered at its own scale, which is not the zoom: a 2x
  // device pixel ratio doubles it again.
  return sampleBackground(bitmap, b, bitmap ? bitmap.scale : 1)
})

const risky = computed(() => (background.value?.confidence ?? 0) < CONFIDENT_ENOUGH)

/**
 * The size the field draws at, in page units.
 *
 * `size` once a line is open; the box-height approximation only as a floor
 * for the moment before it is, and for a line the extraction gave no size
 * for at all.
 */
const editSize = computed(() =>
  size.value > 0 ? size.value : box.value ? box.value.h * 0.8 : 0,
)

/**
 * How wide the input has to be to show what is being typed.
 *
 * It used to be the ORIGINAL line's width. That is the right box for the
 * cover the writer paints, and the wrong box for an editor: type anything
 * longer than the text you are replacing and a single-line <input> scrolls,
 * so the start of your own sentence disappears off the left edge while you
 * are still writing it. Replacing "Notes" with "something" showed
 * "nething".
 *
 * So the field grows with its content, and the dashed guide underneath goes
 * on showing where the original line ended -- which is the thing the fit
 * setting is actually about, and which the field's own width was never
 * communicating anyway.
 *
 * Capped at the page's right edge: past that the input would hang off the
 * paper, and horizontal scrolling inside the field is the lesser evil.
 */
/** The face being typed in, as the one object every consumer below reads. */
const face = computed(() => ({ weight: weight.value, italic: italic.value }))

const inputWidth = computed(() => {
  const b = drawnAt.value
  if (!b) return 0
  const measured = runs.value.length === 0
    ? measureText(' ', family.value, editSize.value, face.value)
    : runsAdvance(runs.value, editSize.value, 0, (r, at) => measureText(r.text, family.value, at, r))
  // A little slack so the caret at the end of the text is never against the
  // border, and a floor so an emptied field stays clickable.
  const wanted = Math.max(b.w, measured + editSize.value, 40)
  const pageWidth = pageViewSize(props.page.geometry, 1).width
  // Against the DRAWN x: a line dragged towards the right margin has less
  // room left than its source position had, and capping against the source
  // would hang the field off the paper.
  return Math.min(wanted, Math.max(40, pageWidth - b.x))
})

/**
 * The page's own colour behind this line -- the exact colour the committed
 * patch will paint, so the field looks like the result.
 *
 * NOT a theme token. The field used to carry `bg-surface`, which is
 * near-black under a dark theme, while its text colour was correctly taken
 * from the line being replaced. On a phone in dark mode that meant black
 * text on a black field: the page underneath is white paper whatever the
 * interface is wearing. White is the fallback for the same reason
 * `buildLinePatch` uses it -- an unsampled page is assumed to be paper.
 */
const fieldBackground = computed(() =>
  rgb(background.value ? plainColor(background.value.color) : [1, 1, 1]),
)

/** How large the replacement should APPEAR, before iOS gets a say. */
const drawnFontSize = computed(() => editSize.value * props.zoom)

/**
 * The font iOS is actually told about, and the scale that undoes it.
 * See lib/textFieldZoom.ts for why this is not simply `drawnFontSize`.
 */
const fieldSize = computed(() => noZoomTextSize(drawnFontSize.value))

/** The field's size ON SCREEN, which is what the warning panel hangs off. */
const drawnBox = computed(() => {
  const b = drawnAt.value
  if (!b) return { width: 0, height: 0 }
  return { width: inputWidth.value * props.zoom, height: b.h * props.zoom }
})

const style = computed(() => {
  const b = drawnAt.value
  if (!b) return {}
  const { fontSize, scale } = fieldSize.value
  return {
    left: `${b.x * props.zoom}px`,
    top: `${b.y * props.zoom}px`,
    // Divided by the scale, because the transform below shrinks the box
    // along with the text in it. These two and `fontSize` are the only
    // values here that the scale touches.
    width: `${drawnBox.value.width / scale}px`,
    height: `${drawnBox.value.height / scale}px`,
    // An <input> centres its line; an editable block puts it at the top.
    // A line-height of the full box puts it back in the middle.
    lineHeight: `${drawnBox.value.height / scale}px`,
    fontSize: `${fontSize}px`,
    // In the same zoom-compensated pixels as the size, so the caret lands
    // between the letters where the export will put them.
    letterSpacing: `${(spacing.value * props.zoom) / scale}px`,
    transform: `scale(${scale})`,
    // From the top-left corner, so the field stays over the line it
    // replaces. The default centre origin would slide it up and left by
    // half the shrinkage.
    transformOrigin: 'top left',
    backgroundColor: fieldBackground.value,
    // The family AND weight the export will use, so what is typed is the
    // width it will be measured at rather than whatever the UI font happens
    // to be. Bold glyphs are wider; typing into a regular field and getting
    // bold on commit would move the text you were just looking at.
    fontFamily: cssFamily(family.value),
    fontWeight: cssWeight(weight.value),
    fontStyle: cssStyle(italic.value),
    // The line's own colour, not the UI's text colour. What is being typed
    // has to look like what will be committed, and the page underneath is
    // rendered as-is -- so a grey label is typed in grey even in dark mode.
    color: rgb(color.value),
  }
})

/** Where the original line ended, so the guide can show it while typing. */
const originalWidth = computed(() => (box.value ? box.value.w : 0))

/**
 * Where each line is drawn, and so where its click target goes.
 *
 * Not computed here: `editTargets` owns it, because a double-click under
 * the select tool asks the same question without this component being
 * mounted, and two answers would send the two routes to DIFFERENT lines.
 *
 * A line the extraction found no characters on gets no target at all --
 * there is nothing to point at, and its box would be infinite.
 */
const targets = computed(() =>
  (props.index?.lines ?? []).map((l, i) =>
    l.chars.length === 0 ? undefined : lineTargetRect(l, patchOn(i)),
  ),
)

/**
 * A click on a line MAKES ITS LAYER, before anything is typed.
 *
 * The patch used to exist only once the text or the style had changed: a
 * line the user clicked and left alone recorded nothing. That meant a line
 * could not be restyled from the inspector without first retyping it --
 * there was no object to select, so no Font, Weight, Size or Colour to
 * offer -- and the layers list had nothing to show for a line the user had
 * plainly reached for. The reported case was a heading whose weight and
 * colour were the whole point.
 *
 * So the patch is created here, carrying the line's own words and the
 * style the document set it in, and SELECTED, so the inspector shows its
 * controls while the field is still open. What it costs is honest: a
 * pristine patch covers the line and redraws it in the default family,
 * which is a visible change on a page set in something else. That is the
 * same change every edit already makes, now made by the click that asks
 * for it -- and one Undo, or the layer's own delete, takes it back.
 */
function ensurePatch(lineIndex: number, chosen?: string): TextPatchObject | undefined {
  const existing = patchOn(lineIndex)
  if (existing) return existing
  const l = props.index?.lines[lineIndex]
  if (!l || l.chars.length === 0) return undefined
  const fontFamily = chosen ?? familyForLine(l.font)
  const object = buildLinePatch({
    pageId: props.page.id,
    lineIndex,
    line: l,
    fontFamily,
    style: documentStyle(l, fontFamily),
    background: background.value,
    z: edits.nextZ(),
    fit: 'overflow',
  })
  edits.applyOp({ type: 'addObject', object: object as EditObject }, 'Edit text')
  return object
}

async function begin(lineIndex: number, chosen?: string): Promise<void> {
  // A line in a font we do not carry, never edited before: ask which of
  // ours to draw it in, rather than quietly turning it into Inter.
  const target = props.index?.lines[lineIndex]
  if (
    chosen === undefined && target && !patchOn(lineIndex) &&
    needsReplacementChoice(target.font)
  ) {
    asking.value = lineIndex
    return
  }
  editing.value = lineIndex
  // The line's layer, made now if the line had none, and selected so the
  // inspector offers its style while the field is open. The draft is what
  // the user last typed if they have edited this line before -- otherwise
  // the line as the document has it. Loading the original over an existing
  // edit made every re-edit start from scratch, which read as the edit
  // having been lost.
  const existing = ensurePatch(lineIndex, chosen)
  editingId.value = existing?.id
  seededFamily.value = chosen ?? familyForLine(props.index?.lines[lineIndex]?.font ?? '')
  if (existing) edits.select([existing.id])
  draft.value = existing ? existing.text : originalText.value
  const line = props.index?.lines[lineIndex]
  // An existing patch's own weight, otherwise the weight the DOCUMENT set
  // this line in.
  weight.value = existing ? weightOf(existing) : line?.weight ?? 400
  italic.value = existing ? existing.italic === true : line?.italic === true
  // The patch's own colour once it has one, otherwise the line's.
  //
  // Deliberately NOT copied here, because copying here would achieve
  // nothing and read as though it did: `color` is a `ref`, and a ref holding
  // an array hands back a reactive Proxy on every read whatever was
  // assigned to it. The copy that matters is at the point the value enters
  // the edit document -- see plainColor and its two call sites below.
  color.value = existing?.color ?? line?.color ?? [0, 0, 0]
  // Likewise the size -- and a patch stored by an older build carries 0,
  // the "work it out at export" sentinel, so re-opening one heals it to the
  // real number rather than showing the sentinel back to the user.
  size.value = (existing && existing.fontSize > 0 ? existing.fontSize : line?.size) ?? 0
  fit.value = existing ? existing.fit : 'overflow'
  spacing.value = existing?.letterSpacing ?? 0
  missing.value = []
  // The face the field is about to be styled with, so the caret sits
  // against its real metrics rather than the fallback's -- the same reason
  // TextEditor loads before focusing. Bold makes this matter more: without
  // the file the browser fakes the weight by stroking whatever it does
  // have, and the fake is a different width from the one that will be
  // exported.
  // The line as styled runs: the patch's own, which `ensurePatch` seeded
  // from the line's pieces -- so a bold name opens bold. Set BEFORE the
  // field renders: `bindField` fills it from these.
  runs.value = mergeRuns(existing
    ? patchRuns(existing)
    : [{ ...fallbackRun(), text: draft.value }])
  // The faces the field is styled with, so its glyphs are the real ones
  // rather than the browser's fake bold -- which is a different width from
  // the one that will be exported. The field is already up and typeable;
  // it re-lays itself out when they arrive.
  await Promise.all([loadFont(family.value, face.value).catch(() => {}), loadRunFaces()])
}

/** The dialog's answer: remember it if asked to, then open the line in it. */
function onReplacementChosen(family: string, always: boolean): void {
  const at = asking.value
  const l = askingLine.value
  asking.value = undefined
  if (at === undefined || !l) return
  if (always) rememberReplacement(l.font, family)
  void begin(at, family)
}

/**
 * Ctrl+B / Ctrl+I over the SELECTION when there is one, otherwise over the
 * whole line -- which is also what the field opens with selected, so
 * pressing Ctrl+B straight away still means "make this line bold".
 *
 * The direction is decided by every visible run in range, as the toolbar
 * decides it: a selection that is partly bold goes bold. A shortcut is a
 * switch, so Bold moves between the two weights the words mean; the other
 * six are one select away in the inspector.
 */
function toggleAxis(axis: 'bold' | 'italic'): void {
  const el = input.value
  const length = [...draft.value].length
  if (length === 0 || runs.value.length === 0) {
    if (axis === 'bold') weight.value = isBoldWeight(weight.value) ? 400 : 700
    else italic.value = !italic.value
    return
  }
  const selection = el ? selectionOffsets(el) : undefined
  const [a, b] = selection && selection[1] > selection[0] ? selection : [0, length]
  const inRange = runsIn(runs.value, a, b)
  const visible = inRange.filter((r) => r.text.trim() !== '')
  const judged = visible.length > 0 ? visible : inRange
  if (axis === 'italic' && !hasItalic(family.value)) return
  const on = judged.every((r) => (axis === 'bold' ? isBoldWeight(r.weight) : r.italic))
  showRuns(
    restyleRange(runs.value, a, b, (r) => {
      if (axis === 'italic') return { italic: !on }
      const target = on ? 400 : 700
      return { weight: fitStyle(family.value, { weight: target, italic: r.italic }).weight ?? target }
    }),
    selection ?? [a, b],
  )
  updateFieldSelection()
  void loadRunFaces()
}

function cancel(): void {
  editing.value = undefined
  editingId.value = undefined
  draft.value = ''
  runs.value = []
  rendered = []
  fieldSelection.value = undefined
  weight.value = 400
  italic.value = false
  size.value = 0
  color.value = [0, 0, 0]
  spacing.value = 0
  missing.value = []
}

/**
 * Which characters the chosen font cannot draw.
 *
 * Checked as the user types, because finding out at export time means
 * finding out after they have stopped thinking about it. MuPDF returns
 * .notdef rather than failing, so without this a patch silently becomes a
 * row of empty boxes.
 */
watch([draft, weight, italic, family], async ([text]) => {
  if (text === '') { missing.value = []; return }
  try {
    // The FACE that will actually be drawn: a bold file is a different font
    // program with its own coverage, so checking the regular would answer a
    // question nobody asked.
    const key = faceKey(family.value, face.value)
    const bytes = (await fontsForExport([key])).get(key)
    if (!bytes) { missing.value = []; return }
    missing.value = await getPdfClient().missingGlyphs(bytes, key, text)
  } catch {
    // A font that cannot be checked is not a reason to block an edit.
    missing.value = []
  }
})

function commit(): void {
  const l = line.value
  const b = box.value
  const at = editing.value
  if (!l || !b || at === undefined) return

  const existing = editingId.value
  // The field as it is NOW, in case the browser changed it without an
  // input event reaching us.
  if (input.value) {
    runs.value = readRuns(input.value, rendered, fallbackRun())
    syncFromRuns()
  }
  const fields = toPatchFields(runs.value, {
    weight: weight.value, italic: italic.value, color: plainColor(color.value),
  })

  /**
   * Committing UPDATES the patch the click made -- which is every commit,
   * since `begin` makes one -- and never deletes it.
   *
   * It used to: typing the original back with the document's own style
   * was read as a request to undo the edit, and the patch was removed. Now
   * that the click itself makes the layer, a patch drawing exactly what the
   * document draws is the layer the user asked for by clicking, not a
   * leftover, and it stays until they delete it or undo. Typing the
   * original back simply leaves the layer saying the original.
   *
   * `originalText` and `originalHash` are deliberately left alone: they
   * describe the line in the source document, which has not changed, and
   * they are what the writer checks before applying anything. Recomputing
   * them from the current draft would make that guard compare the edit
   * against itself.
   *
   * `originalText` and `originalHash` are deliberately left alone: they
   * describe the line in the source document, which has not changed, and
   * they are what the writer checks before applying anything. Recomputing
   * them from the current draft would make that guard compare the edit
   * against itself.
   */
  if (existing) {
    // Nothing to record when the field closes as it opened: an update
    // that changes nothing would still be an undo step, so Ctrl+Z after
    // a click-and-leave would revert the no-op and leave the layer, when
    // what the user means is "take back the click".
    const stored = patchOn(at)
    if (
      stored && stored.text === fields.text && stored.fit === fit.value &&
      stored.fontSize === size.value && weightOf(stored) === fields.weight &&
      (stored.italic === true) === fields.italic &&
      stored.color.every((channel, i) => channel === fields.color[i]) &&
      sameSpans(stored.spans, fields.spans)
    ) {
      cancel()
      return
    }
    edits.applyOp(
      {
        type: 'updateObject',
        id: existing,
        patch: {
          text: fields.text, fit: fit.value, fontSize: size.value,
          weight: fields.weight, italic: fields.italic,
          spans: fields.spans,
          // Defensive rather than load-bearing, and the distinction is
          // worth stating: reaching this path means the line already had a
          // patch, so the colour was seeded from the STORE, and immer
          // deep-freezes what it produces while Vue declines to proxy a
          // frozen object -- so `color.value` happens to be plain here.
          // That is a conclusion about two libraries' internals, not about
          // this code, and it stops being true the day auto-freeze is
          // turned off. Everything else in this patch is a primitive.
          color: plainColor(fields.color),
        },
      },
      'Edit text',
    )
    cancel()
    return
  }

  const object = buildLinePatch({
    pageId: props.page.id,
    lineIndex: at,
    line: l,
    fontFamily: family.value,
    style: {
      weight: fields.weight, italic: fields.italic, fontSize: size.value, color: fields.color,
    },
    background: background.value,
    z: edits.nextZ(),
    text: fields.text,
    fit: fit.value,
    spans: fields.spans ?? [],
  })

  // Only reachable when `begin` could not make the layer, which it can
  // for every line that has a target. Kept so a commit never loses text.
  edits.applyOp({ type: 'addObject', object: object as EditObject }, 'Edit text')
  cancel()
}

/**
 * A double-click on the page enters this tool ALREADY POINTING at a line.
 *
 * The decision is made in `PageOverlay`, which owns the pointer coordinates
 * and the extraction; all this tool is told is which line, and by which
 * page. Answering to the page matters: every mounted page runs its own copy
 * of this component, and an unaddressed request would open an editor on all
 * of them.
 *
 * Watched rather than read once on mount because the extraction is fetched
 * per page and may not have landed when the tool switches. Dropping the
 * request in that window would make a double-click work or not depending on
 * how warm the cache happened to be.
 */
watch(
  () => [tools.pendingPatch, props.index] as const,
  ([request, index]) => {
    if (!request || request.pageId !== props.page.id || !index) return
    // Consumed whether or not it can be honoured: a request naming a line
    // this page does not have is not going to become honourable later, and
    // leaving it would fire on the next page to mount.
    tools.clearPendingPatch()
    if (index.lines[request.lineIndex]) void begin(request.lineIndex)
  },
  { immediate: true },
)

defineExpose({ begin })
</script>

<template>
  <div ref="layer" class="pointer-events-none absolute inset-0" data-patch-layer>
    <!--
      Teleported: the page overlay is transformed for zoom, and a fixed
      element inside a transformed one is fixed to IT, not to the window.
    -->
    <Teleport to="body">
      <FontReplacementDialog
        v-if="askingLine"
        :font-name="askingLine.font"
        :text="askingLine.text"
        :weight="askingLine.weight"
        :italic="askingLine.italic"
        :bitmap="vp.bitmapFor(props.page.id)"
        :box="askingBox"
        @choose="onReplacementChosen"
        @cancel="asking = undefined"
      />
    </Teleport>

    <!--
      One target per line, shown only while the tool is active. Marked by
      confidence BEFORE the user commits: a line over a photograph can be
      patched, but the flat cover will show, and finding that out in the
      exported file is finding out too late.
    -->
    <template v-if="editing === undefined">
      <template v-for="(t, i) in targets" :key="i">
        <button
          v-if="t"
          type="button"
          class="pointer-events-auto absolute cursor-text border border-dashed
                 border-accent/40 hover:bg-accent/10"
          :style="{
            left: `${t.x * props.zoom}px`,
            top: `${t.y * props.zoom}px`,
            width: `${t.w * props.zoom}px`,
            height: `${t.h * props.zoom}px`,
          }"
          :data-patch-target="i"
          :aria-label="`Edit line ${i + 1}`"
          @click="begin(i)"
        />
      </template>
    </template>

    <template v-else>
      <!--
        Where the original line ended.
        
        The input used to be exactly this wide, which meant its edge doubled
        as the "will it fit" guide. Now that the field grows with what is
        typed, that information would simply be gone -- so it is drawn
        explicitly. It is what the fit setting below is about: text past this
        mark is what gets shrunk, cut, or allowed to run.

        Not drawn for a line that has been MOVED. The fit rules measure
        against the box the line came from, and a moved patch always
        overflows precisely because it is no longer in that box -- so the
        mark would claim a constraint that has stopped applying, at a
        position the text is not at.
      -->
      <div
        v-if="originalWidth > 0 && !isMoved"
        data-patch-guide
        aria-hidden="true"
        class="pointer-events-none absolute border-r-2 border-dashed border-accent/50"
        :style="{
          left: `${(box?.x ?? 0) * props.zoom}px`,
          top: `${(box?.y ?? 0) * props.zoom}px`,
          width: `${originalWidth * props.zoom}px`,
          height: `${(box?.h ?? 0) * props.zoom}px`,
        }"
      />

      <!--
        Ctrl/Cmd+B and Ctrl/Cmd+I while typing, and nothing on screen for
        either.
        
        Both are already correct on entry -- they are inherited from the
        line being replaced -- so visible toggles would be chrome in front
        of someone who asked to type a word, which is exactly the panel this
        editor deliberately does not have. The shortcuts are there for the
        rarer case of wanting a different style from the original, and the
        inspector shows both checkboxes once the patch exists.
      -->
      <!--
        An editable element rather than an <input>, because an <input> can
        show only one style -- see richLine.ts. Its children are rendered
        by `showRuns`, never by the template, so Vue does not reset what the
        user has typed when this component re-renders.
      -->
      <div
        :ref="bindField"
        contenteditable="true"
        role="textbox"
        aria-multiline="false"
        spellcheck="false"
        data-patch-input
        aria-label="Replacement text"
        class="pointer-events-auto absolute box-border overflow-hidden whitespace-pre
               border border-accent px-0.5 focus:outline-none"
        :style="style"
        @input="onInput"
        @paste="onPaste"
        @drop.prevent
        @beforeinput="onBeforeInput"
        @keydown.enter.prevent="commit()"
        @keydown.esc.prevent="cancel()"
        @keydown.ctrl.b.prevent="toggleAxis('bold')"
        @keydown.meta.b.prevent="toggleAxis('bold')"
        @keydown.ctrl.i.prevent="toggleAxis('italic')"
        @keydown.meta.i.prevent="toggleAxis('italic')"
        @blur="commit()"
      />

      <!--
        Bold and Italic for the selected text, above the selection.

        mousedown is prevented so pressing a button does not take focus
        from the field: losing focus is what COMMITS an edit, and the
        selection the button acts on would be gone with it.
      -->
      <div
        v-if="fieldSelection"
        data-patch-format-bar
        class="pointer-events-auto absolute z-20 flex items-center gap-0.5 rounded-control
               border border-border bg-surface-raised px-1 py-0.5 shadow-high"
        :style="{ left: `${fieldSelection.left}px`, top: `${fieldSelection.top}px`,
                  transform: 'translateY(calc(-100% - 6px))' }"
        @mousedown.prevent
        @pointerdown.prevent.stop
      >
        <IconButton
          size="sm"
          label="Bold"
          data-patch-bold
          :active="selectionBold"
          @click="toggleAxis('bold')"
        >
          <Bold :size="16" :stroke-width="1.5" />
        </IconButton>
        <IconButton
          v-if="canItalic"
          size="sm"
          label="Italic"
          data-patch-italic
          :active="selectionItalic"
          @click="toggleAxis('italic')"
        >
          <Italic :size="16" :stroke-width="1.5" />
        </IconButton>
      </div>

      <!--
        Warnings only, and only when there are any.
        
        This used to be a panel carrying a three-way "if it does not fit"
        picker and Replace/Cancel buttons, shown on every single click. It
        put a form in front of someone who had asked to type a word. Enter
        or clicking away commits, Escape cancels, and text simply runs on
        -- which is what every inline editor does and what people already
        expect.
        
        What is NOT dropped is the honesty. Both warnings below are things
        the user can only act on before committing, and finding either out
        in the exported file is finding out too late.
      -->
      <div
        v-if="risky || missing.length"
        class="pointer-events-none absolute z-10 max-w-64 rounded-panel border border-border
               bg-surface-raised p-2 text-[12px] text-warning shadow-high"
        :style="{ left: style.left, top: `calc(${style.top} + ${drawnBox.height}px)` }"
        data-patch-warnings
        role="status"
      >
        <p v-if="risky" data-patch-risky>
          The area behind this line is not a flat colour, so the patch will
          leave a visible mark. Covering a photograph or a gradient rarely
          looks right.
        </p>

        <p v-if="missing.length" data-patch-missing>
          This font cannot draw {{ missing.join(' ') }} — those characters
          would come out blank.
        </p>
      </div>

    </template>
  </div>
</template>
