<script setup lang="ts">
import { ref } from 'vue'
import { CircleHelp, PanelLeftClose, PanelLeftOpen } from 'lucide-vue-next'
import Tooltip from '@/ui/Tooltip.vue'
import { cn } from '@/ui/cn'
import { useToolsStore } from '@/stores/tools'
import { useDialogsStore } from '@/stores/dialogs'
import ToolPreview from './ToolPreview.vue'
import { TOOLS } from './toolList'
import { PREVIEW_HINTS } from './toolPreviews'

const tools = useToolsStore()
const dialogs = useDialogsStore()

/**
 * Whether the rail shows each tool's NAME beside its icon.
 *
 * Open every time the app loads, like WordPress's admin menu: twenty icons
 * are a lot to learn, and a name is the quickest way to learn them.
 * "Collapse menu" at the bottom folds it to icons for this session only --
 * deliberately not remembered, so everyone starts from the named menu.
 */
const expanded = ref(true)

/**
 * One layout for every row, FOLDED OR NOT. The two states differ only in
 * the rail's width, which is what animates.
 *
 * Switching rows between "centred icon" and "icon plus label" made the
 * icons jump to the middle and back while the width was still moving. So
 * a row is always icon-then-label, left-aligned, at the same padding: the
 * icon never moves, and the label is clipped by the narrowing rail and
 * faded out, rather than removed.
 *
 * The numbers are chosen so the folded rail looks as it always did: 64px
 * wide, 16px of padding each side, a 32px-square row, and the 18px icon
 * 7px into it -- centred in the folded rail, and still at that spot when
 * the rail is open.
 */
const row = (active: boolean): string =>
  cn(
    'flex h-8 w-full shrink-0 items-center gap-3 overflow-hidden rounded-control px-[7px]',
    'text-left text-[13px] transition-colors duration-fast',
    active
      ? 'bg-accent text-accent-fg'
      : 'text-text-muted hover:bg-surface-sunken hover:text-text',
  )

/** The label: always there, faded with the width rather than added and removed. */
const label = (): string =>
  cn(
    'truncate whitespace-nowrap transition-opacity duration-200 motion-reduce:transition-none',
    expanded.value ? 'opacity-100' : 'opacity-0',
  )
</script>

<template>
  <nav
    class="flex shrink-0 flex-col items-stretch overflow-x-hidden border-r border-border
           bg-surface px-4 py-2 transition-[width] duration-200 ease-out
           motion-reduce:transition-none"
    :class="expanded ? 'w-48' : 'w-16'"
    aria-label="Tools"
    :data-rail-expanded="expanded"
  >
    <!--
      The tools scroll; the buttons below do not. Twenty tools overflow this
      rail on a short window, and a button appended to the scrolling list
      would sit below the twentieth -- off-screen, which is exactly where a
      guide to the tools must not be. `min-h-0` is what lets this shrink
      inside the flex column rather than pushing the buttons out of the nav.
    -->
    <div class="flex min-h-0 flex-1 flex-col items-stretch gap-1 overflow-y-auto scrollbar-none">
      <Tooltip v-for="t in TOOLS" :key="t.id" :content="t.label" side="right">
        <template #preview><ToolPreview :tool="t.id" /></template>
        <template #hint>{{ PREVIEW_HINTS[t.id] }}</template>
        <button
          type="button"
          :class="row(tools.active === t.id)"
          :aria-label="t.label"
          :aria-pressed="tools.active === t.id ? 'true' : 'false'"
          data-tool
          @click="tools.setTool(t.id)"
        >
          <component :is="t.icon" :size="18" :stroke-width="1.5" class="shrink-0" />
          <span :class="label()" data-rail-label :aria-hidden="expanded ? undefined : 'true'">{{ t.label }}</span>
        </button>
      </Tooltip>
    </div>

    <div class="mt-1 flex shrink-0 flex-col items-stretch gap-1 border-t border-border pt-1.5">
      <!--
        The only visible way into the tool guide while a document is open.
        Everything else that opens it -- the command palette, the help panel
        -- is itself behind the palette, so without this the documentation
        for these icons was reachable only by someone who already knew the
        keyboard shortcut for a menu they had never seen.
      -->
      <Tooltip content="What each tool does" side="right">
        <button
          type="button"
          :class="row(false)"
          aria-label="What each tool does"
          data-open-tools-guide-rail
          @click="dialogs.show('tools-guide')"
        >
          <CircleHelp :size="18" :stroke-width="1.5" class="shrink-0" />
          <span :class="label()" data-rail-label :aria-hidden="expanded ? undefined : 'true'">Tools guide</span>
        </button>
      </Tooltip>

      <Tooltip :content="expanded ? 'Collapse menu' : 'Expand menu'" side="right">
        <button
          type="button"
          :class="row(false)"
          :aria-label="expanded ? 'Collapse menu' : 'Expand menu'"
          :aria-expanded="expanded ? 'true' : 'false'"
          data-rail-toggle
          @click="expanded = !expanded"
        >
          <component
            :is="expanded ? PanelLeftClose : PanelLeftOpen"
            :size="18" :stroke-width="1.5" class="shrink-0"
          />
          <span :class="label()" data-rail-label :aria-hidden="expanded ? undefined : 'true'">Collapse menu</span>
        </button>
      </Tooltip>
    </div>
  </nav>
</template>
