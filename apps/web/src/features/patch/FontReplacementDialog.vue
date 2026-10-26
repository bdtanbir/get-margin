<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useFocusTrap } from '@/lib/useFocusTrap'
import Button from '@/ui/Button.vue'
import { cssFamily, cssStyle, cssWeight, fitStyle, loadFont } from '@/lib/fonts'
import { similarFonts } from '@/lib/fontMatch'
import type { Bitmap } from './sampleBackground'

/**
 * Asked when a line the user clicks is set in a font we do not carry.
 *
 * The editor redraws every line it edits in one of OUR faces, because those
 * are the bytes it can embed. When the document's font is not one of them
 * the old behaviour was to pick Inter without saying so, which turned a
 * Cambria letterhead into a sans-serif the moment a date was clicked. This
 * shows the original as the page draws it, the closest faces we have set in
 * the same words, and lets the user choose.
 */
const props = defineProps<{
  /** The PostScript name, as the document has it: `BCDFEE+Cambria-Bold`. */
  fontName: string
  text: string
  weight: number
  italic: boolean
  /** The page as rendered, for the picture of the original line. */
  bitmap: (Bitmap & { scale: number }) | undefined
  /** The line's box in page space. */
  box: { x: number; y: number; w: number; h: number } | undefined
}>()

const emit = defineEmits<{
  choose: [family: string, always: boolean]
  cancel: []
}>()

const surface = ref<HTMLElement | null>(null)
useFocusTrap(surface, { onEscape: () => emit('cancel') })

const suggestions = computed(() => similarFonts(props.fontName))
const chosen = ref(suggestions.value[0]?.family ?? '')
const always = ref(false)

/** The name without its subset tag would be friendlier, but Sejda shows it whole -- and it is what a user would search for. */
const shownName = computed(() => props.fontName)

/** The face each suggestion is previewed in: the line's own style, snapped to what that family has. */
function faceFor(family: string): { weight: number; italic: boolean } {
  const fitted = fitStyle(family, { weight: props.weight, italic: props.italic })
  return { weight: fitted.weight ?? props.weight, italic: fitted.italic ?? props.italic }
}

function previewStyle(family: string): Record<string, string> {
  const face = faceFor(family)
  return {
    fontFamily: cssFamily(family),
    fontWeight: cssWeight(face.weight),
    fontStyle: cssStyle(face.italic),
  }
}

/** Loaded so each row is drawn in its real face, not the browser's fallback. */
onMounted(() => {
  for (const s of suggestions.value) void loadFont(s.family, faceFor(s.family)).catch(() => {})
})

/**
 * The original line, cut out of the rendered page.
 *
 * A picture rather than text, because the whole point is that we cannot
 * draw this font ourselves -- the page bitmap is the only place it exists.
 */
const original = ref<HTMLCanvasElement | null>(null)
const hasPicture = computed(() => !!props.bitmap && !!props.box && props.box.w > 0)

function drawOriginal(): void {
  const canvas = original.value
  const bitmap = props.bitmap
  const box = props.box
  if (!canvas || !bitmap || !box) return
  const pad = box.h * 0.15
  const sx = Math.max(0, Math.floor((box.x - pad) * bitmap.scale))
  const sy = Math.max(0, Math.floor((box.y - pad) * bitmap.scale))
  const sw = Math.min(bitmap.width - sx, Math.ceil((box.w + pad * 2) * bitmap.scale))
  const sh = Math.min(bitmap.height - sy, Math.ceil((box.h + pad * 2) * bitmap.scale))
  if (sw <= 0 || sh <= 0) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  canvas.width = sw
  canvas.height = sh
  const pixels = new Uint8ClampedArray(sw * sh * 4)
  for (let row = 0; row < sh; row++) {
    const from = ((sy + row) * bitmap.width + sx) * 4
    pixels.set(bitmap.rgba.subarray(from, from + sw * 4), row * sw * 4)
  }
  ctx.putImageData(new ImageData(pixels, sw, sh), 0, 0)
}

onMounted(drawOriginal)
watch(() => [props.bitmap, props.box], drawOriginal)

function replace(): void {
  if (chosen.value) emit('choose', chosen.value, always.value)
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="font-replacement-title"
    data-font-replacement
    @click.self="emit('cancel')"
  >
    <div
      ref="surface"
      tabindex="-1"
      class="my-8 flex w-full max-w-lg flex-col gap-4 rounded-panel bg-surface p-5 shadow-high"
    >
      <h2 id="font-replacement-title" class="text-[17px] font-medium">Font replacement</h2>

      <p class="text-[13px] text-text-muted">
        This text uses a font that isn't available for editing. Pick the
        closest match to use instead.
      </p>

      <div class="flex flex-col gap-1 rounded-control border border-border p-3" data-font-original>
        <span class="text-[12px] text-text-subtle">{{ shownName }}</span>
        <!-- Always on white: it is a crop of the paper, whatever the theme. -->
        <div v-if="hasPicture" class="overflow-hidden rounded-sm bg-white">
          <canvas
            ref="original"
            class="block h-auto max-h-16 max-w-full"
            aria-hidden="true"
          />
        </div>
        <span v-else class="truncate text-[18px]">{{ text }}</span>
      </div>

      <div class="flex flex-col gap-1">
        <span class="text-[13px] font-medium">Choose a replacement font</span>
        <div
          class="flex max-h-[45vh] flex-col gap-1 overflow-y-auto"
          role="radiogroup"
          aria-label="Replacement font"
        >
          <label
            v-for="s in suggestions"
            :key="s.family"
            class="flex cursor-pointer items-center gap-3 rounded-control border p-3"
            :class="chosen === s.family ? 'border-accent bg-accent/5' : 'border-border'"
            :data-font-option="s.family"
          >
            <input
              v-model="chosen"
              type="radio"
              name="font-replacement"
              class="accent-accent"
              :value="s.family"
            >
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="flex items-center gap-2 text-[12px] text-text-subtle">
                {{ s.family }}
                <span
                  v-if="s.verySimilar"
                  class="rounded-full bg-[#1f9d63]/10 px-1.5 py-px text-[11px] font-medium text-[#1f9d63]"
                  data-very-similar
                >Very similar</span>
              </span>
              <!-- Black on white: this is how it will look on the paper. -->
              <span
                class="truncate rounded-sm bg-white px-1 text-[20px] leading-tight text-black"
                :style="previewStyle(s.family)"
              >{{ text }}</span>
            </span>
          </label>
        </div>
      </div>

      <label class="flex items-center gap-2 text-[13px]">
        <input v-model="always" type="checkbox" class="accent-accent" data-font-always>
        Always use this font for {{ shownName.replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0] }}
      </label>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" data-font-cancel @click="emit('cancel')">Cancel</Button>
        <Button variant="primary" data-font-replace :disabled="!chosen" @click="replace">
          Replace
        </Button>
      </div>
    </div>
  </div>
</template>
