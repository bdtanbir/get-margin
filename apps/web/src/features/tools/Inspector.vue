<script setup lang="ts">
import { computed } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { ChevronLeft } from 'lucide-vue-next'
import { fieldsFor, toDisplay, fromDisplay, type Field } from './inspectorFields'
import { toHex, fromHex } from './colorInput'
import TabOrderList from './TabOrderList.vue'
import LayersPanel from '@/features/layers/LayersPanel.vue'
import PageStyleBar from '@/features/pages/PageStyleBar.vue'
import { usePageSelectionStore } from '@/stores/pageSelection'
import { layerLabel } from '@/features/layers/layerLabel'

/**
 * `back` is false on the mobile sheet, which renders this component ONLY
 * while something is selected: there is no layers list behind it there, so
 * a Back button would dismiss the sheet while promising a list the phone
 * never shows.
 */
const props = withDefaults(defineProps<{ back?: boolean }>(), { back: true })

const edits = useEditsStore()
const doc = useDocumentStore()
const pageSelection = usePageSelectionStore()

const selected = computed(() => {
  const id = edits.selection[0]
  return id ? edits.doc.objects[id] : undefined
})

const fields = computed(() => (selected.value ? fieldsFor(selected.value) : []))

const valueOf = (key: string): unknown =>
  (selected.value as unknown as Record<string, unknown> | undefined)?.[key]

function write(key: string, value: unknown): void {
  const o = selected.value
  if (!o || o.locked) return
  edits.applyOp({ type: 'updateObject', id: o.id, patch: { [key]: value } as never }, 'Edit')
}

/**
 * A slider or a colour picker emits an `input` per pixel of travel and one
 * `change` when the pointer is released. Without coalescing, dragging
 * opacity from 1 to 0 is thirty undo steps.
 *
 * This uses beginTransaction/endTransaction rather than withTransaction
 * because the two ends of the gesture arrive as SEPARATE DOM events --
 * withTransaction's callback is synchronous and would close the transaction
 * before the second `input` ever fired. `dragging` is a plain module-scope
 * flag, not reactive state: nothing renders from it.
 */
let dragging = false

function onInput(key: string, value: unknown): void {
  if (!dragging) {
    dragging = true
    edits.beginTransaction('Edit')
  }
  write(key, value)
}

/**
 * The options list, edited as a whole.
 *
 * Each change writes the entire array rather than patching an index: the
 * op is `updateObject` with a partial, and a partial naming `options`
 * replaces it. Reading, editing a copy, and writing it back is what keeps
 * that honest -- and it is one undo step per change, which is what the user
 * would expect from clicking "remove".
 */
function optionsOf(key: string): string[] {
  const v = valueOf(key)
  return Array.isArray(v) ? (v as string[]) : []
}

function addOption(key: string): void {
  write(key, [...optionsOf(key), `Option ${optionsOf(key).length + 1}`])
}

function removeOption(key: string, index: number): void {
  write(key, optionsOf(key).filter((_, i) => i !== index))
}

function replaceOption(key: string, index: number, value: string): void {
  write(key, optionsOf(key).map((o, i) => (i === index ? value : o)))
}

/**
 * `field` is passed so a text field's `normalize` runs here rather than on
 * every keystroke: normalising mid-typing fights the caret, and validating
 * mid-typing rejects every prefix of a valid URL.
 */
function onCommit(field?: Field): void {
  if (field?.type === 'text' && field.normalize) {
    const o = selected.value
    const raw = valueOf(field.key)
    if (o && typeof raw === 'string') {
      try {
        write(field.key, field.normalize(raw))
      } catch (e) {
        // Revert to what was there before this edit opened, so the document
        // never holds a value the validator rejects.
        edits.endTransaction()
        dragging = false
        edits.undo()
        doc.error = e instanceof Error ? e.message : 'That value is not valid.'
        return
      }
    }
  }
  if (!dragging) return
  dragging = false
  edits.endTransaction()
}

function readInput(field: Field, target: HTMLInputElement | HTMLSelectElement): unknown {
  if (field.type === 'number') return fromDisplay(field, Number(target.value))
  if (field.type === 'color') return fromHex(target.value)
  return target.value
}

function handleInput(field: Field, e: Event): void {
  onInput(field.key, readInput(field, e.target as HTMLInputElement))
}
</script>

<template>
  <aside
    class="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-surface p-3"
    :aria-label="selected ? 'Properties' : 'Layers'"
  >
    <!--
      Two states, never both: what is on the document, and one object's
      properties. Selecting anywhere -- a row here or the object itself on
      the page -- swaps to properties, and clearing the selection (Back,
      Escape, a click on bare page) swaps back, so the sidebar always agrees
      with what is selected rather than being a third place to look.

      Selecting a PAGE is a third thing, and it does not swap: the page is
      what the layers are on, so its properties sit above the list rather
      than replacing it, and what is on the page stays readable while its
      background is being changed.
    -->
    <template v-if="!selected">
      <PageStyleBar v-if="pageSelection.count > 0" />
      <LayersPanel />
    </template>

    <template v-else>
      <button
        v-if="props.back"
        data-layers-back
        type="button"
        class="flex min-h-8 items-center gap-1 self-start rounded-control pr-2 text-[13px] text-text-muted hover:text-text"
        @click="edits.clearSelection()"
      >
        <ChevronLeft :size="16" :stroke-width="1.5" />
        Layers
      </button>
      <h2 class="truncate text-[13px] font-medium text-text">{{ layerLabel(selected) }}</h2>

      <!--
        Spec 2.1. This copy is load-bearing, not decoration: people white out
        SSNs and account numbers believing the data is gone, and it is not --
        write/objects/whiteout.ts draws a cover and whiteout.test.ts asserts
        the text underneath is still extractable. Saying so plainly, at the
        moment the tool is in use, is the whole mitigation. Never soften this
        to "hides", and never label the tool "redact".
      -->
      <p
        v-if="selected.kind === 'whiteout'"
        data-whiteout-notice
        class="rounded-control border border-border bg-surface-sunken p-2 text-[12px] text-text-muted"
      >
        Whiteout covers content — it does not delete it. The text underneath can
        still be copied out of the file. To remove text so it cannot be
        recovered, select it and use <strong>Redact</strong>.
      </p>

      <!--
        Shown while a field is selected, because that is when the user is
        thinking about the form. It is a PAGE property rather than an object
        one, so it sits outside the per-property loop.
      -->
      <TabOrderList v-if="selected.kind === 'field'" :page-id="selected.pageId" />

      <div
        v-for="f in fields"
        :key="f.key"
        :data-field="f.key"
        class="flex items-center justify-between gap-2"
      >
        <label :for="`insp-${f.key}`" class="text-[13px] text-text-muted">{{ f.label }}</label>

        <select
          v-if="f.type === 'select'"
          :id="`insp-${f.key}`"
          class="min-h-8 rounded-control border border-border bg-surface-sunken px-2 text-[13px]"
          :disabled="selected.locked"
          :value="valueOf(f.key)"
          @change="(e) => { onInput(f.key, (e.target as HTMLSelectElement).value); onCommit(f) }"
        >
          <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>

        <input
          v-else-if="f.type === 'color'"
          :id="`insp-${f.key}`"
          type="color"
          class="size-8 rounded-control border border-border bg-surface-sunken"
          :disabled="selected.locked"
          :value="toHex(valueOf(f.key) as [number, number, number] | null)"
          @input="(e) => handleInput(f, e)"
          @change="() => onCommit(f)"
          @blur="() => onCommit(f)"
        />

        <input
          v-else-if="f.type === 'number'"
          :id="`insp-${f.key}`"
          type="number"
          class="min-h-8 w-24 rounded-control border border-border bg-surface-sunken px-2 text-[13px]"
          :disabled="selected.locked"
          :min="f.min"
          :max="f.max"
          :step="f.step"
          :value="toDisplay(f, valueOf(f.key))"
          @input="(e) => handleInput(f, e)"
          @change="() => onCommit(f)"
          @blur="() => onCommit(f)"
        />

        <!--
          Static guidance, not a control. A signature FIELD is a place for a
          signature, and saying so where the user is configuring it is the
          only thing standing between them and believing this app signs
          documents.
        -->
        <p
          v-else-if="f.type === 'note'"
          class="rounded-control border border-border bg-surface-sunken p-2 text-[12px] text-text-muted"
        >{{ f.text }}</p>

        <input
          v-else-if="f.type === 'boolean'"
          :id="`insp-${f.key}`"
          type="checkbox"
          class="size-4 accent-accent"
          :disabled="selected.locked"
          :checked="valueOf(f.key) === true"
          @change="(e) => { onInput(f.key, (e.target as HTMLInputElement).checked); onCommit(f) }"
        />

        <!--
          One option per line, edited in place. A comma-separated string
          would be simpler and wrong: option values legitimately contain
          commas, and a user typing "Yes, please" as an option would
          silently get two.
        -->
        <div v-else-if="f.type === 'list'" class="flex w-40 flex-col gap-1">
          <div v-for="(opt, i) in (valueOf(f.key) as string[])" :key="i" class="flex gap-1">
            <input
              type="text"
              class="min-h-8 w-full rounded-control border border-border bg-surface-sunken px-2 text-[13px]"
              :disabled="selected.locked"
              :value="opt"
              :aria-label="`Option ${i + 1}`"
              @change="(e) => replaceOption(f.key, i, (e.target as HTMLInputElement).value)"
            />
            <button
              type="button"
              class="min-h-8 rounded-control border border-border px-2 text-[12px]"
              :disabled="selected.locked"
              :aria-label="`Remove option ${i + 1}`"
              :data-remove-option="i"
              @click="removeOption(f.key, i)"
            >&times;</button>
          </div>
          <button
            type="button"
            class="min-h-8 rounded-control border border-border px-2 text-[12px]"
            :disabled="selected.locked"
            data-add-option
            @click="addOption(f.key)"
          >Add option</button>
        </div>

        <input
          v-else
          :id="`insp-${f.key}`"
          type="text"
          class="min-h-8 w-40 rounded-control border border-border bg-surface-sunken px-2 text-[13px]"
          :disabled="selected.locked"
          :value="valueOf(f.key)"
          @input="(e) => handleInput(f, e)"
          @change="() => onCommit(f)"
          @blur="() => onCommit(f)"
        />
      </div>
    </template>
  </aside>
</template>
