<script setup lang="ts">
import { computed } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { fieldsFor, type Field } from './inspectorFields'
import { toHex, fromHex } from './colorInput'

const edits = useEditsStore()
const doc = useDocumentStore()

const selected = computed(() => {
  const id = edits.selection[0]
  return id ? edits.doc.objects[id] : undefined
})

const fields = computed(() => (selected.value ? fieldsFor(selected.value.kind) : []))

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
  if (field.type === 'number') return Number(target.value)
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
    aria-label="Properties"
  >
    <p v-if="!selected" class="text-[13px] text-text-subtle">
      Select an object to edit its properties.
    </p>

    <template v-else>
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
        still be copied out of the file.
      </p>

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
          :value="valueOf(f.key)"
          @input="(e) => handleInput(f, e)"
          @change="() => onCommit(f)"
          @blur="() => onCommit(f)"
        />

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
