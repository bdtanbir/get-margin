<script setup lang="ts">
import IconButton from '@/ui/IconButton.vue'
import { useToolsStore } from '@/stores/tools'
import { TOOLS } from './toolList'

const tools = useToolsStore()
</script>

<template>
  <!--
    The mobile counterpart of ToolRail, reading the same TOOLS list. No
    Tooltip wrapper: a hover tooltip has no trigger on touch, and the
    accessible name IconButton already carries is what a screen reader
    announces either way.

    A LEFT COLUMN, not the horizontal strip this used to be. Vertical is
    what makes eighteen tools legible on a phone: a horizontal strip could
    show ten at a time and hid the remaining eight behind a sideways scroll
    with nothing on screen to suggest they existed. A column gives each
    tool the full width of the rail and scrolls in the direction people
    already expect a list to scroll.

    `w-12` is 48px, of which the 32px buttons leave 8px either side. The
    cost is real -- it is 12% of a 390px phone, and the page area re-fits
    smaller because of it -- and it is spent IN THE LAYOUT rather than
    floating: this nav is a `shrink-0` flex sibling of the page area, so
    the document is measured beside it and no page is ever drawn
    underneath it. Floating would have kept the width at the price of
    covering the left margin of every page, which is the same trade Task
    21 rejected for ZoomPill (see MobileShell.vue).
  -->
  <nav
    class="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border
           bg-surface py-2"
    aria-label="Tools"
  >
    <IconButton
      v-for="t in TOOLS"
      :key="t.id"
      size="sm"
      :label="t.label"
      :active="tools.active === t.id"
      @click="tools.setTool(t.id)"
    >
      <component :is="t.icon" :size="18" :stroke-width="1.5" />
    </IconButton>
  </nav>
</template>
