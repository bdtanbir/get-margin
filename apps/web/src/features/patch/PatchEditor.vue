<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { nanoid } from 'nanoid'
import { pageViewSize } from '@margin/transform'
import type { PageState } from '@/stores/document'
import type {
  Color, EditObject, LineRun, PageQuadIndex, TextPatchObject,
} from '@margin/pdf-core'
import { hashText } from '@margin/pdf-core'
import { useEditsStore } from '@/stores/edits'
import { useViewportStore } from '@/stores/viewport'
import { getPdfClient } from '@/workers/pdfClient'
import {
  fontsForExport, measureText, cssFamily, cssWeight, cssStyle, faceKey, loadFont,
  DEFAULT_FAMILY,
} from '@/lib/fonts'
import { rgb } from '@/features/overlay/objects/svgPaint'
import { sampleBackground, CONFIDENT_ENOUGH } from './sampleBackground'

const props = defineProps<{
  page: PageState
  zoom: number
  index: PageQuadIndex | undefined
}>()

const edits = useEditsStore()
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

/** The patch on a given line, if the user has already edited it. */
function patchOn(lineIndex: number): TextPatchObject | undefined {
  return Object.values(edits.doc.objects).find(
    (o): o is TextPatchObject =>
      o.kind === 'textPatch' && o.pageId === props.page.id && o.lineIndex === lineIndex,
  )
}
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
 * Taken from the CHARS rather than the stored bbox so it matches exactly
 * what the writer will re-derive at export -- the two must agree or the
 * cover lands somewhere the user did not see it.
 */
const box = computed(() => {
  const l = line.value
  if (!l || l.chars.length === 0) return undefined
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const c of l.chars) {
    for (let i = 0; i < 8; i += 2) {
      x0 = Math.min(x0, c.quad[i]!); x1 = Math.max(x1, c.quad[i]!)
      y0 = Math.min(y0, c.quad[i + 1]!); y1 = Math.max(y1, c.quad[i + 1]!)
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
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
  const b = box.value
  if (!b) return 0
  const measured = measureText(draft.value || ' ', DEFAULT_FAMILY, editSize.value, face.value)
  // A little slack so the caret at the end of the text is never against the
  // border, and a floor so an emptied field stays clickable.
  const wanted = Math.max(b.w, measured + editSize.value, 40)
  const pageWidth = pageViewSize(props.page.geometry, 1).width
  return Math.min(wanted, Math.max(40, pageWidth - b.x))
})

const style = computed(() => {
  const b = box.value
  if (!b) return {}
  return {
    left: `${b.x * props.zoom}px`,
    top: `${b.y * props.zoom}px`,
    width: `${inputWidth.value * props.zoom}px`,
    height: `${b.h * props.zoom}px`,
    fontSize: `${editSize.value * props.zoom}px`,
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
 * How wide a line's clickable target has to be.
 *
 * The extraction's own width describes the ORIGINAL line, so once a patch
 * ran past it the tail of the user's own text was not clickable -- the one
 * part of the line they had just written could not be edited again.
 *
 * Measured the way the patch is drawn, so the target covers exactly what
 * is on screen.
 */
function targetWidth(lineIndex: number, lineWidth: number, lineHeight: number): number {
  const patch = patchOn(lineIndex)
  if (!patch || patch.text === '') return lineWidth
  const size = patch.fontSize > 0 ? patch.fontSize : lineHeight * 0.8
  // 'shrink' and 'truncate' both keep the text inside the original line, so
  // only 'overflow' can make the target wider than the extraction says.
  if (patch.fit !== 'overflow') return lineWidth
  return Math.max(lineWidth, measureText(patch.text, patch.fontFamily, size, patch))
}

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
  color.value = existing ? existing.color : line?.color ?? [0, 0, 0]
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
  return (
    bold.value === l.bold &&
    italic.value === l.italic &&
    size.value === l.size &&
    l.color.every((channel, i) => channel === color.value[i])
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
   * With no existing patch there is simply nothing to record. With one,
   * leaving it in place would keep painting a cover over text identical to
   * what is underneath -- a visible flat rectangle achieving nothing.
   */
  if (draft.value === originalText.value && matchesDocument(l)) {
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
          bold: bold.value, italic: italic.value, color: color.value,
        },
      },
      'Edit text',
    )
    cancel()
    return
  }

  const sample = background.value
  const object: EditObject = {
    id: nanoid(10),
    pageId: props.page.id,
    kind: 'textPatch',
    lineIndex: at,
    // Hashed HERE, from what the user was actually looking at. That is
    // what makes the export's guard meaningful rather than circular.
    originalHash: hashText(originalText.value),
    originalText: originalText.value,
    text: draft.value,
    fontFamily: DEFAULT_FAMILY,
    bold: bold.value,
    italic: italic.value,
    fontSize: size.value,
    // The pen position on the line being replaced, so the overlay draws the
    // replacement where the export will put it. See TextPatchObject.baseline.
    baseline: l.baseline,
    color: color.value,
    background: sample?.color ?? [1, 1, 1],
    backgroundConfidence: sample?.confidence ?? 0,
    fit: fit.value,
    rect: { x: b.x, y: b.y, w: b.w, h: b.h },
    rotation: 0,
    z: edits.nextZ(),
    locked: false,
    opacity: 1,
  } as EditObject

  edits.applyOp({ type: 'addObject', object }, 'Edit text')
  cancel()
}

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
      <button
        v-for="(l, i) in props.index?.lines ?? []"
        :key="i"
        type="button"
        class="pointer-events-auto absolute cursor-text border border-dashed"
        :class="(props.index?.lines[i]?.chars.length ?? 0) === 0
          ? 'hidden'
          : 'border-accent/40 hover:bg-accent/10'"
        :style="{
          left: `${Math.min(...l.chars.map((c) => c.quad[0])) * props.zoom}px`,
          top: `${Math.min(...l.chars.map((c) => c.quad[1])) * props.zoom}px`,
          width: `${targetWidth(
            i,
            Math.max(...l.chars.map((c) => c.quad[2])) - Math.min(...l.chars.map((c) => c.quad[0])),
            Math.max(...l.chars.map((c) => c.quad[5])) - Math.min(...l.chars.map((c) => c.quad[1])),
          ) * props.zoom}px`,
          height: `${(Math.max(...l.chars.map((c) => c.quad[5])) - Math.min(...l.chars.map((c) => c.quad[1]))) * props.zoom}px`,
        }"
        :data-patch-target="i"
        :aria-label="`Edit line ${i + 1}`"
        @click="begin(i)"
      />
    </template>

    <template v-else>
      <!--
        Where the original line ended.
        
        The input used to be exactly this wide, which meant its edge doubled
        as the "will it fit" guide. Now that the field grows with what is
        typed, that information would simply be gone -- so it is drawn
        explicitly. It is what the fit setting below is about: text past this
        mark is what gets shrunk, cut, or allowed to run.
      -->
      <div
        v-if="originalWidth > 0"
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
        class="pointer-events-auto absolute box-border border border-accent bg-surface px-0.5
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
        :style="{ left: style.left, top: `calc(${style.top} + ${style.height})` }"
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
