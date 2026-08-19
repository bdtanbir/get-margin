<script setup lang="ts">
import { ref, computed } from 'vue'
import { useFocusTrap } from '@/lib/useFocusTrap'
import Button from '@/ui/Button.vue'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { parseRanges } from '@/lib/pageRanges'
import { FONTS } from '@/lib/fonts'
import { toHex, fromHex } from '@/features/tools/colorInput'
import {
  PRESETS, PRESET_LABELS, PRESET_ORDER, type StampKind, type StampPosition, type StampSettings,
} from './stampPresets'
import { buildStamps } from './buildStamps'

const emit = defineEmits<{ close: [] }>()

const doc = useDocumentStore()
const edits = useEditsStore()
const surface = ref<HTMLElement | null>(null)
useFocusTrap(surface, { onEscape: () => emit('close') })

const kind = ref<StampKind>('watermark')
const settings = ref<StampSettings>({ ...PRESETS.watermark })
const range = ref('')
const error = ref('')

/**
 * Switching preset replaces the settings wholesale rather than merging.
 *
 * A half-merged state -- a watermark's 60pt rotated text at a footer's
 * bottom-centre position -- is not a thing anyone asked for, and it is what
 * merging produces the moment two presets disagree about a field.
 */
function choose(next: StampKind): void {
  kind.value = next
  settings.value = { ...PRESETS[next] }
}

const POSITIONS: StampPosition[] = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]

/** The pages this will apply to. Empty input means every page. */
const targetPages = computed(() => {
  const all = doc.pageOrder.map((id) => doc.pages[id]).filter((p) => !!p)
  if (!range.value.trim()) return all
  try {
    const groups = parseRanges(range.value, all.length)
    const indices = new Set(groups.flat())
    return all.filter((_, i) => indices.has(i))
  } catch {
    return []
  }
})

const rangeError = computed(() => {
  if (!range.value.trim()) return ''
  try {
    parseRanges(range.value, doc.pageCount)
    return ''
  } catch (e) {
    return e instanceof Error ? e.message : 'That page range is not valid.'
  }
})

/** What the first stamped page will actually say, tokens resolved. */
const preview = computed(() => {
  const pages = targetPages.value
  if (pages.length === 0) return ''
  const stamps = buildStamps(
    settings.value, pages.slice(0, 1), pages, doc.fileName || 'document.pdf',
    new Date().toLocaleDateString(), () => 1,
  )
  return stamps[0]?.text ?? ''
})

function apply(): void {
  const pages = targetPages.value
  if (pages.length === 0) {
    error.value = 'That range selects no pages.'
    return
  }
  const all = doc.pageOrder.map((id) => doc.pages[id]).filter((p) => !!p)
  const stamps = buildStamps(
    settings.value, pages, all, doc.fileName || 'document.pdf',
    new Date().toLocaleDateString(), () => edits.nextZ(),
  )

  // ONE history entry for the whole run. Stamping 300 pages should cost one
  // Cmd+Z, not three hundred.
  edits.withTransaction(`Add ${PRESET_LABELS[kind.value].toLowerCase()}`, () => {
    for (const stamp of stamps) {
      edits.applyOp({ type: 'addObject', object: stamp }, 'Add stamp')
    }
  })
  emit('close')
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Watermark and page marks"
    data-stamp-dialog
    @click.self="emit('close')"
  >
    <div
      ref="surface"
      tabindex="-1"
      class="my-8 flex w-full max-w-md flex-col gap-4 rounded-panel bg-surface p-5 shadow-high"
    >
      <h2 class="text-[17px] font-medium">Watermark and page marks</h2>

      <div class="flex flex-wrap gap-1" role="group" aria-label="Kind">
        <button
          v-for="k in PRESET_ORDER"
          :key="k"
          type="button"
          class="rounded-control border px-2 py-1 text-[12px]"
          :class="kind === k ? 'border-accent bg-accent/10 text-accent' : 'border-border'"
          :data-preset="k"
          :aria-pressed="kind === k"
          @click="choose(k)"
        >{{ PRESET_LABELS[k] }}</button>
      </div>

      <label class="flex flex-col gap-1">
        <span class="text-[13px] text-text-muted">Text</span>
        <input
          v-model="settings.template"
          type="text"
          data-stamp-template
          class="min-h-9 rounded-control border border-border bg-surface-sunken px-2 text-[13px]"
        >
        <!--
          The tokens are named where they are typed. A template language
          nobody can see is a template language nobody uses.
        -->
        <span class="text-[12px] text-text-subtle">
          {n} page number · {total} page count · {filename} · {date} · {bates}
        </span>
      </label>

      <p v-if="preview" data-stamp-preview class="text-[13px] text-text-muted">
        First page reads: <strong class="text-text">{{ preview }}</strong>
      </p>

      <div v-if="kind === 'bates'" class="grid grid-cols-2 gap-2" data-bates-settings>
        <label class="flex flex-col gap-1">
          <span class="text-[12px] text-text-muted">Start at</span>
          <input v-model.number="settings.bates.start" type="number" min="0" data-bates-start
                 class="min-h-8 rounded-control border border-border bg-surface-sunken px-2 text-[13px]">
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[12px] text-text-muted">Step</span>
          <input v-model.number="settings.bates.step" type="number" min="1" data-bates-step
                 class="min-h-8 rounded-control border border-border bg-surface-sunken px-2 text-[13px]">
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[12px] text-text-muted">Digits</span>
          <input v-model.number="settings.bates.digits" type="number" min="1" max="12" data-bates-digits
                 class="min-h-8 rounded-control border border-border bg-surface-sunken px-2 text-[13px]">
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[12px] text-text-muted">Prefix</span>
          <input v-model="settings.bates.prefix" type="text" data-bates-prefix
                 class="min-h-8 rounded-control border border-border bg-surface-sunken px-2 text-[13px]">
        </label>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-[13px] text-text-muted">Position</span>
          <select v-model="settings.position" data-stamp-position
                  class="min-h-9 rounded-control border border-border bg-surface-sunken px-2 text-[13px]">
            <option v-for="p in POSITIONS" :key="p" :value="p">{{ p.replace('-', ' ') }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[13px] text-text-muted">Font</span>
          <select v-model="settings.fontFamily" data-stamp-font
                  class="min-h-9 rounded-control border border-border bg-surface-sunken px-2 text-[13px]">
            <option v-for="f in FONTS" :key="f.family" :value="f.family">{{ f.family }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[13px] text-text-muted">Size</span>
          <input v-model.number="settings.fontSize" type="number" min="4" max="200" data-stamp-size
                 class="min-h-9 rounded-control border border-border bg-surface-sunken px-2 text-[13px]">
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[13px] text-text-muted">Rotation</span>
          <input v-model.number="settings.rotation" type="number" min="-180" max="180" data-stamp-rotation
                 class="min-h-9 rounded-control border border-border bg-surface-sunken px-2 text-[13px]">
        </label>
        <label class="flex items-center gap-2">
          <span class="text-[13px] text-text-muted">Colour</span>
          <input
            type="color"
            data-stamp-color
            class="size-8 rounded-control border border-border bg-surface-sunken"
            :value="toHex(settings.color)"
            @input="(e) => { const c = fromHex((e.target as HTMLInputElement).value); if (c) settings.color = c }"
          >
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[13px] text-text-muted">Opacity</span>
          <input v-model.number="settings.opacity" type="number" min="0.05" max="1" step="0.05"
                 data-stamp-opacity
                 class="min-h-9 rounded-control border border-border bg-surface-sunken px-2 text-[13px]">
        </label>
      </div>

      <!--
        Both orders are wanted and neither is obviously right, so it is a
        choice rather than a default the code picks: a header belongs on
        top, a watermark usually beneath what it marks.
      -->
      <label class="flex items-center gap-2 text-[13px] text-text-muted">
        <input v-model="settings.behind" type="checkbox" data-stamp-behind class="accent-accent">
        Draw underneath the page content
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-[13px] text-text-muted">Pages</span>
        <input
          v-model="range"
          type="text"
          placeholder="All pages — or 1-3, 7"
          data-stamp-range
          class="min-h-9 rounded-control border border-border bg-surface-sunken px-2 text-[13px]"
        >
        <span v-if="rangeError" data-stamp-range-error class="text-[12px] text-danger">
          {{ rangeError }}
        </span>
        <span v-else class="text-[12px] text-text-subtle" data-stamp-count>
          {{ targetPages.length }} {{ targetPages.length === 1 ? 'page' : 'pages' }}
        </span>
      </label>

      <p v-if="error" data-stamp-error class="text-[13px] text-danger">{{ error }}</p>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" data-stamp-cancel @click="emit('close')">Cancel</Button>
        <Button
          variant="primary"
          data-stamp-apply
          :disabled="targetPages.length === 0 || !!rangeError"
          @click="apply"
        >Apply</Button>
      </div>
    </div>
  </div>
</template>
