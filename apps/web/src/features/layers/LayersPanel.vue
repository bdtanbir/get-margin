<script setup lang="ts">
import { computed } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import type { EditObject } from '@margin/pdf-core'
import { useDocumentStore } from '@/stores/document'
import { useEditsStore } from '@/stores/edits'
import { useViewportStore } from '@/stores/viewport'
import { objectViewRect } from '@/features/overlay/objectViewRect'
import { layerLabel, layerIcon } from './layerLabel'

const doc = useDocumentStore()
const edits = useEditsStore()
const vp = useViewportStore()

/**
 * Every object the user has added, grouped by the page it sits on.
 *
 * Pages come in DISPLAY order rather than object order, and a page with
 * nothing on it is left out entirely -- a heading over an empty group tells
 * the reader nothing and makes a long document's list mostly headings.
 *
 * Within a page the topmost object comes first, which is how every design
 * tool stacks a layer list: the thing painted over everything else is the
 * thing at the top.
 */
const groups = computed(() => {
  const byPage = new Map<string, EditObject[]>()
  for (const o of Object.values(edits.doc.objects)) {
    const list = byPage.get(o.pageId)
    if (list) list.push(o)
    else byPage.set(o.pageId, [o])
  }
  return doc.pageOrder.flatMap((id, index) => {
    const objects = byPage.get(id)
    if (!objects) return []
    return [{ id, label: `Page ${index + 1}`, index, objects: [...objects].sort((a, b) => b.z - a.z) }]
  })
})

const total = computed(() => Object.keys(edits.doc.objects).length)

/**
 * Select the object AND bring it into view.
 *
 * The scroll offset is the object's own top edge in view pixels, via
 * objectViewRect -- which knows that a text patch's rect is page space
 * while everything else's is PDF space. The panel does no coordinate
 * arithmetic of its own (spec 1.4), exactly like the overlay.
 */
function go(object: EditObject, pageIndex: number): void {
  edits.select([object.id])
  const geometry = doc.pages[object.pageId]?.geometry
  if (!geometry) return vp.goToPage(pageIndex)
  vp.goToPage(pageIndex, objectViewRect(object, geometry, vp.zoom).y)
}

/**
 * Deleting is not selecting. Without stopping the click here it would also
 * run the row's own handler, dragging the viewport to an object that is
 * about to stop existing.
 */
function remove(id: string): void {
  edits.applyOp({ type: 'deleteObject', id }, 'Delete')
}
</script>

<template>
  <section class="flex min-h-0 flex-col gap-2" aria-label="Layers">
    <header class="flex items-baseline justify-between">
      <h2 class="text-[13px] font-medium text-text">Layers</h2>
      <span v-if="total" class="text-[12px] text-text-subtle">{{ total }}</span>
    </header>

    <p v-if="!total" data-layers-empty class="text-[13px] text-text-subtle">
      Nothing added yet. Text, images, signatures and shapes you add to the
      document will be listed here.
    </p>

    <div v-for="g in groups" :key="g.id" class="flex flex-col gap-1">
      <h3
        data-layer-group
        class="px-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-text-subtle"
      >
        {{ g.label }}
      </h3>

      <div
        v-for="o in g.objects"
        :key="o.id"
        :data-layer-row="o.id"
        role="button"
        tabindex="0"
        :aria-current="edits.selection[0] === o.id ? 'true' : undefined"
        class="group flex min-h-9 cursor-pointer items-center gap-2 rounded-control px-2 text-[13px] hover:bg-surface-sunken"
        :class="edits.selection[0] === o.id ? 'bg-surface-sunken ring-1 ring-accent' : ''"
        @click="go(o, g.index)"
        @keydown.enter.prevent="go(o, g.index)"
        @keydown.space.prevent="go(o, g.index)"
      >
        <component :is="layerIcon(o.kind)" :size="15" :stroke-width="1.5" class="shrink-0 text-text-muted" />
        <span class="min-w-0 flex-1 truncate">{{ layerLabel(o) }}</span>
        <button
          :data-layer-delete="o.id"
          type="button"
          :aria-label="`Delete ${layerLabel(o)}`"
          class="shrink-0 rounded-control p-1 text-text-subtle opacity-0 hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
          @click.stop="remove(o.id)"
        >
          <Trash2 :size="14" :stroke-width="1.5" />
        </button>
      </div>
    </div>
  </section>
</template>
