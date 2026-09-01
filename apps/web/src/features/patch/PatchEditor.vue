<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { pageViewSize } from '@margin/transform'
import type { PageState } from '@/stores/document'
import type {
  Color, EditObject, LineRun, PageQuadIndex, TextPatchObject,
} from '@margin/pdf-core'
import { useEditsStore } from '@/stores/edits'
import { useToolsStore } from '@/stores/tools'
import { useViewportStore } from '@/stores/viewport'
import { getPdfClient } from '@/workers/pdfClient'
import {
  fontsForExport, measureText, cssFamily, cssWeight, cssStyle, faceKey, loadFont,
  DEFAULT_FAMILY,
} from '@/lib/fonts'
import { rgb } from '@/features/overlay/objects/svgPaint'
import { noZoomTextSize } from '@/lib/textFieldZoom'
import { sampleBackground, CONFIDENT_ENOUGH } from './sampleBackground'
import {
  buildLinePatch, documentStyle, lineBox, patchOnLine, plainColor, sameStyle,
} from './linePatch'
import { lineTargetRect } from './editTargets'

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
 * The weight the replacement will be drawn in.
 *
 * Seeded from the line's OWN font, not from a default. MuPDF reports
 * `isBold()` per glyph run and `buildQuadIndex` carries it through, so
 * retyping a bold heading stays bold. It used to come out regular every
 * time -- the patch hardcoded the default face -- which read as the editor
 * having thrown away formatting it could see perfectly well.
 *
 * Held here rather than read off `line` at commit time so that re-editing a
 * patch resumes from the weight the user chose, not from the weight the
 * document started with.
 */
const bold = ref(false)
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
const missing = ref<string[]>([])
const input = ref<HTMLInputElement | null>(null)

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
const face = computed(() => ({ bold: bold.value, italic: italic.value }))

const inputWidth = computed(() => {
  const b = drawnAt.value
  if (!b) return 0
  const measured = measureText(draft.value || ' ', DEFAULT_FAMILY, editSize.value, face.value)
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
    fontSize: `${fontSize}px`,
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
    fontFamily: cssFamily(DEFAULT_FAMILY),
    fontWeight: cssWeight(bold.value),
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

async function begin(lineIndex: number): Promise<void> {
  editing.value = lineIndex
  // What the user last typed, if they have edited this line before --
  // otherwise the line as the document has it. Loading the original over
  // an existing edit made every re-edit start from scratch, which read as
  // the edit having been lost.
  const existing = patchOn(lineIndex)
  editingId.value = existing?.id
  draft.value = existing ? existing.text : originalText.value
  const line = props.index?.lines[lineIndex]
  // An existing patch's own weight, otherwise the weight the DOCUMENT set
  // this line in.
  bold.value = existing ? existing.bold === true : line?.bold === true
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
  missing.value = []
  // The face the field is about to be styled with, so the caret sits
  // against its real metrics rather than the fallback's -- the same reason
  // TextEditor loads before focusing. Bold makes this matter more: without
  // the file the browser fakes the weight by stroking whatever it does
  // have, and the fake is a different width from the one that will be
  // exported.
  await loadFont(DEFAULT_FAMILY, face.value)
  await nextTick()
  input.value?.focus()
  input.value?.select()
}

function cancel(): void {
  editing.value = undefined
  editingId.value = undefined
  draft.value = ''
  bold.value = false
  italic.value = false
  size.value = 0
  color.value = [0, 0, 0]
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
watch([draft, bold, italic], async ([text]) => {
  if (text === '') { missing.value = []; return }
  try {
    // The FACE that will actually be drawn: a bold file is a different font
    // program with its own coverage, so checking the regular would answer a
    // question nobody asked.
    const key = faceKey(DEFAULT_FAMILY, face.value)
    const bytes = (await fontsForExport([key])).get(key)
    if (!bytes) { missing.value = []; return }
    missing.value = await getPdfClient().missingGlyphs(bytes, key, text)
  } catch {
    // A font that cannot be checked is not a reason to block an edit.
    missing.value = []
  }
})

/**
 * Whether the style being committed is the one the line already has.
 *
 * Compared against the DOCUMENT's line rather than against any existing
 * patch: "undo the edit" means restore what the page itself draws, so that
 * is what the comparison has to be against.
 */
function matchesDocument(l: LineRun): boolean {
  return sameStyle(
    { bold: bold.value, italic: italic.value, fontSize: size.value, color: color.value },
    documentStyle(l),
  )
}

function commit(): void {
  const l = line.value
  const b = box.value
  const at = editing.value
  if (!l || !b || at === undefined) return

  const existing = editingId.value

  /**
   * Putting the line back exactly as the document has it is a request to
   * undo the edit.
   *
   * EXACTLY means the style too, and that used to be missing. The test was
   * `draft === originalText`, so changing only the weight or the slope --
   * pressing Ctrl+B on a line and touching nothing else -- looked like
   * typing the original back, and the edit was discarded on blur. The style
   * appeared while the field was open and vanished the moment it closed.
   *
   * AND THE POSITION, for the same reason and with a worse failure. A line
   * that has only been MOVED still has the document's own words and the
   * document's own style, so this matched it -- and merely opening the
   * field and clicking away deleted the patch, snapping the line back to
   * where it started with nothing on screen to say why. Where the line is
   * is part of "exactly as the document has it".
   *
   * With no existing patch there is simply nothing to record. With one,
   * leaving it in place would keep painting a cover over text identical to
   * what is underneath -- a visible flat rectangle achieving nothing.
   */
  if (draft.value === originalText.value && matchesDocument(l) && !isMoved.value) {
    if (existing) edits.applyOp({ type: 'deleteObject', id: existing }, 'Undo text edit')
    cancel()
    return
  }

  /**
   * Editing a line that already has a patch UPDATES it.
   *
   * `originalText` and `originalHash` are deliberately left alone: they
   * describe the line in the source document, which has not changed, and
   * they are what the writer checks before applying anything. Recomputing
   * them from the current draft would make that guard compare the edit
   * against itself.
   */
  if (existing) {
    edits.applyOp(
      {
        type: 'updateObject',
        id: existing,
        patch: {
          text: draft.value, fit: fit.value, fontSize: size.value,
          bold: bold.value, italic: italic.value,
          // Defensive rather than load-bearing, and the distinction is
          // worth stating: reaching this path means the line already had a
          // patch, so the colour was seeded from the STORE, and immer
          // deep-freezes what it produces while Vue declines to proxy a
          // frozen object -- so `color.value` happens to be plain here.
          // That is a conclusion about two libraries' internals, not about
          // this code, and it stops being true the day auto-freeze is
          // turned off. Everything else in this patch is a primitive.
          color: plainColor(color.value),
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
    fontFamily: DEFAULT_FAMILY,
    style: {
      bold: bold.value, italic: italic.value, fontSize: size.value, color: color.value,
    },
    background: background.value,
    z: edits.nextZ(),
    text: draft.value,
    fit: fit.value,
  })

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
  <div class="pointer-events-none absolute inset-0" data-patch-layer>
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
      <input
        ref="input"
        v-model="draft"
        type="text"
        data-patch-input
        aria-label="Replacement text"
        class="pointer-events-auto absolute box-border border border-accent px-0.5
               leading-none focus:outline-none"
        :style="style"
        @keydown.enter.prevent="commit()"
        @keydown.esc.prevent="cancel()"
        @keydown.ctrl.b.prevent="bold = !bold"
        @keydown.meta.b.prevent="bold = !bold"
        @keydown.ctrl.i.prevent="italic = !italic"
        @keydown.meta.i.prevent="italic = !italic"
        @blur="commit()"
      >

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
