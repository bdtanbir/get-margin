<script setup lang="ts">
import { computed } from 'vue'
import { ArrowUp, ArrowDown } from 'lucide-vue-next'
import type { FieldObject } from '@margin/pdf-core'
import { useEditsStore } from '@/stores/edits'
import { useFieldsStore } from '@/stores/fields'

const props = defineProps<{ pageId: string }>()

const edits = useEditsStore()
const fields = useFieldsStore()

/**
 * Every field on the page, by name: the ones the user created and the ones
 * the source document already had.
 *
 * By NAME because that is the only identity those two share -- created
 * fields have object ids the source knows nothing about, and source fields
 * have keys no object carries. A radio group appears once, since its
 * buttons are one field.
 */
const names = computed<string[]>(() => {
  // The EDIT store's page entry, not the document store's: it carries the
  // same sourceId and sourceIndex, and reading it here means this component
  // depends on one store instead of two for the same two numbers.
  const page = edits.doc.pages[props.pageId]
  const created = Object.values(edits.doc.objects)
    .filter((o): o is FieldObject => o.kind === 'field' && o.pageId === props.pageId)
    .sort((a, b) => a.z - b.z)
    .map((f) => f.name)
  const source = page ? fields.fields(page.sourceId, page.sourceIndex).map((f) => f.name) : []

  const seen = new Set<string>()
  const all: string[] = []
  for (const n of [...source, ...created]) {
    if (n === '' || seen.has(n)) continue
    seen.add(n)
    all.push(n)
  }

  // Stored order first, then anything it does not mention -- the same rule
  // the writer applies, so the list shows what the export will do.
  const stored = edits.doc.pages[props.pageId]?.tabOrder ?? []
  const known = stored.filter((n) => seen.has(n))
  return [...known, ...all.filter((n) => !known.includes(n))]
})

/**
 * Up and down buttons rather than drag-and-drop.
 *
 * The plan called for reusing Phase 3's useDragReorder. Buttons won on two
 * counts: dragging inside a narrow inspector column is fiddly at the sizes
 * this list actually gets, and tab order is a KEYBOARD feature -- offering
 * it only to people who can drag would be a poor joke. Each press is one
 * undo step, which is also what a press should cost.
 */
function move(index: number, by: -1 | 1): void {
  const next = [...names.value]
  const to = index + by
  if (to < 0 || to >= next.length) return
  const [moved] = next.splice(index, 1)
  next.splice(to, 0, moved!)
  edits.applyOp({ type: 'setTabOrder', pageId: props.pageId, order: next }, 'Reorder fields')
}
</script>

<template>
  <div v-if="names.length > 1" data-tab-order class="flex flex-col gap-1">
    <p class="text-[13px] text-text-muted">Tab order</p>
    <ol class="flex flex-col gap-1">
      <li
        v-for="(name, i) in names"
        :key="name"
        :data-tab-field="name"
        class="flex items-center gap-1 rounded-control border border-border bg-surface-sunken px-2 py-1"
      >
        <span class="min-w-4 text-[12px] text-text-subtle">{{ i + 1 }}</span>
        <span class="flex-1 truncate text-[12px]">{{ name }}</span>
        <button
          type="button"
          class="rounded-control p-1 disabled:opacity-40"
          :disabled="i === 0"
          :aria-label="`Move ${name} earlier`"
          :data-move-up="name"
          @click="move(i, -1)"
        ><ArrowUp :size="13" :stroke-width="1.5" /></button>
        <button
          type="button"
          class="rounded-control p-1 disabled:opacity-40"
          :disabled="i === names.length - 1"
          :aria-label="`Move ${name} later`"
          :data-move-down="name"
          @click="move(i, 1)"
        ><ArrowDown :size="13" :stroke-width="1.5" /></button>
      </li>
    </ol>
  </div>
</template>
