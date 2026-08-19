<script setup lang="ts">
import { computed } from 'vue'
import { useEditsStore } from '@/stores/edits'
import { fieldsFor, type Field } from './inspectorFields'
import { toHex, fromHex } from './colorInput'

const edits = useEditsStore()

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

function onCommit(): void {
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
          @change="(e) => { onInput(f.key, (e.target as HTMLSelectElement).value); onCommit() }"
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
          @change="onCommit"
          @blur="onCommit"
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
          @change="onCommit"
          @blur="onCommit"
        />

        <input
          v-else
          :id="`insp-${f.key}`"
          type="text"
          class="min-h-8 w-40 rounded-control border border-border bg-surface-sunken px-2 text-[13px]"
          :disabled="selected.locked"
          :value="valueOf(f.key)"
          @input="(e) => handleInput(f, e)"
          @change="onCommit"
          @blur="onCommit"
        />
      </div>
    </template>
  </aside>
</template>
