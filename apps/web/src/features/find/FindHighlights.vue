<script setup lang="ts">
import { computed } from 'vue'
import type { PageState } from '@/stores/document'
import { useFindStore } from '@/stores/find'

const props = defineProps<{ page: PageState }>()
const find = useFindStore()

/**
 * Matches on THIS page, with the current one marked.
 *
 * Keyed by source index: a match carries the page it was found on in the
 * source document, which is what this page was rendered from.
 */
const marks = computed(() =>
  find.onPage(props.page.sourceIndex).map((match) => ({
    current: match === find.active,
    polygons: match.quads.map(
      (q) => `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}`,
    ),
  })),
)
</script>

<template>
  <!--
    Outside the overlay's flipped root <g>, like the markup layer: these
    quads are already MuPDF page space.

    Two colours, because "found 40 matches" and "you are looking at this
    one" are different pieces of information and a single colour makes the
    second unanswerable without counting.
  -->
  <g v-if="marks.length" data-find-highlights aria-hidden="true">
    <template v-for="(mark, i) in marks" :key="i">
      <polygon
        v-for="(points, j) in mark.polygons"
        :key="j"
        :points="points"
        :fill="mark.current ? 'rgb(249,115,22)' : 'rgb(250,204,21)'"
        :fill-opacity="mark.current ? 0.55 : 0.35"
        :data-find-mark="mark.current ? 'current' : 'other'"
      />
    </template>
  </g>
</template>
