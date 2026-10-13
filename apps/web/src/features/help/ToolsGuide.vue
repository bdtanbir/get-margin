<script setup lang="ts">
import { ref } from 'vue'
import { X } from 'lucide-vue-next'
import IconButton from '@/ui/IconButton.vue'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { TOOLS } from '@/features/tools/toolList'
import ToolPreview from '@/features/tools/ToolPreview.vue'
import { TOOL_DOCS } from './toolGuide'

/**
 * Every tool, in the order the rail shows them.
 *
 * Rendered by walking `TOOLS` rather than by walking the documentation, so
 * the guide is in the rail's order by construction and a tool can never be
 * listed here in a position it does not occupy on screen. The prose is
 * looked up per tool; `toolGuide.test.ts` guarantees the lookup cannot miss.
 *
 * Numbered, because "which one is the third icon down" is the question
 * someone reads this with the rail in front of them to answer.
 */
const emit = defineEmits<{ close: [] }>()

const surface = ref<HTMLElement | null>(null)
useFocusTrap(surface, { onEscape: () => emit('close') })
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 text-left"
    role="dialog"
    aria-modal="true"
    aria-label="Tools"
    data-tools-guide
    @click.self="emit('close')"
  >
    <div
      ref="surface"
      tabindex="-1"
      class="my-8 flex w-full max-w-2xl flex-col gap-5 rounded-panel bg-surface p-5 shadow-high"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="space-y-1">
          <h2 class="text-[17px] font-medium">Tools</h2>
          <p class="text-[13px] text-text-muted">
            Everything in the toolbar, top to bottom. Pick a tool, use it on the
            page, and press Escape to go back to Select.
          </p>
        </div>
        <IconButton size="sm" label="Close" data-tools-guide-close @click="emit('close')">
          <X :size="16" :stroke-width="1.5" />
        </IconButton>
      </div>

      <ol class="flex flex-col">
        <li
          v-for="(tool, i) in TOOLS"
          :key="tool.id"
          :data-tool-doc="tool.id"
          class="flex flex-wrap gap-3 border-t border-border py-4 first:border-t-0 first:pt-0"
        >
          <!--
            The icon is the thing the user is actually looking for, so it is
            shown exactly as the rail draws it. Decorative here: the label
            beside it is the accessible name, and a screen reader reading
            "square" before "Rectangle" is noise.
          -->
          <div
            class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control
                   bg-surface-sunken text-text-muted"
            aria-hidden="true"
          >
            <component :is="tool.icon" :size="16" :stroke-width="1.5" />
          </div>

          <div class="min-w-0 flex-1 basis-56 space-y-1.5">
            <h3 class="text-[14px] font-medium">
              <span class="text-text-subtle tabular-nums">{{ i + 1 }}.</span>
              {{ tool.label }}
            </h3>
            <p class="text-[13px] text-text-muted">{{ TOOL_DOCS[tool.id].does }}</p>
            <p class="text-[13px] text-text-subtle">{{ TOOL_DOCS[tool.id].how }}</p>

            <!--
              A rule down the side rather than red or amber TEXT. The warning
              token is a fill colour: at 13px on this surface it does not
              reach AA, and the three cautions here are the lines a user most
              needs to be able to read.
            -->
            <p
              v-if="TOOL_DOCS[tool.id].caution"
              :data-tool-caution="tool.id"
              class="border-l-2 border-warning py-0.5 pl-2.5 text-[13px] text-text-muted"
            >{{ TOOL_DOCS[tool.id].caution }}</p>
          </div>

          <!--
            The same looping drawing the rail's hover card shows. Decorative:
            the prose beside it says everything it does. Wraps under the text
            on a narrow screen rather than squeezing it.
          -->
          <div
            class="w-40 shrink-0 self-start overflow-hidden rounded-control bg-surface-sunken
                   max-sm:ml-11"
            aria-hidden="true"
          >
            <ToolPreview :tool="tool.id" />
          </div>
        </li>
      </ol>
    </div>
  </div>
</template>
