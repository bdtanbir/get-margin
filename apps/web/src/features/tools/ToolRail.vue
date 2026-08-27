<script setup lang="ts">
import { CircleHelp } from 'lucide-vue-next'
import IconButton from '@/ui/IconButton.vue'
import Tooltip from '@/ui/Tooltip.vue'
import { useToolsStore } from '@/stores/tools'
import { useDialogsStore } from '@/stores/dialogs'
import { TOOLS } from './toolList'

const tools = useToolsStore()
const dialogs = useDialogsStore()
</script>

<template>
  <nav
    class="flex w-16 shrink-0 flex-col items-center border-r border-border bg-surface py-2"
    aria-label="Tools"
  >
    <!--
      The tools scroll; the help button below does not. Eighteen tools
      overflow this rail on a short window, and a button appended to the
      scrolling list would sit below the eighteenth -- off-screen, which is
      exactly where a guide to the tools must not be. `min-h-0` is what lets
      this shrink inside the flex column rather than pushing the button out
      of the nav.
    -->
    <div class="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto scrollbar-none">
      <Tooltip v-for="t in TOOLS" :key="t.id" :content="t.label" side="right">
        <!--
          aria-pressed is left to IconButton, which derives it from `active`.
          Setting it here as well would make it a fallthrough attribute that
          overrides IconButton's own binding -- one control with two owners of
          the same attribute is how the two get to disagree.
        -->
        <IconButton
          size="sm"
          :label="t.label"
          :active="tools.active === t.id"
          @click="tools.setTool(t.id)"
        >
          <component :is="t.icon" :size="18" :stroke-width="1.5" />
        </IconButton>
      </Tooltip>
    </div>

    <!--
      The only visible way into the tool guide while a document is open.
      Everything else that opens it -- the command palette, the help panel --
      is itself behind the palette, so without this the documentation for
      these eighteen icons was reachable only by someone who already knew
      the keyboard shortcut for a menu they had never seen.

      At the end of the rail because that is what it documents.
    -->
    <div class="mt-1 shrink-0 border-t border-border pt-1.5">
      <Tooltip content="What each tool does" side="right">
        <IconButton
          size="sm"
          label="What each tool does"
          data-open-tools-guide-rail
          @click="dialogs.show('tools-guide')"
        >
          <CircleHelp :size="18" :stroke-width="1.5" />
        </IconButton>
      </Tooltip>
    </div>
  </nav>
</template>
