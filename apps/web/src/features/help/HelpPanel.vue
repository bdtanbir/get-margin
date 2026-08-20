<script setup lang="ts">
import { ref } from 'vue'
import { X } from 'lucide-vue-next'
import IconButton from '@/ui/IconButton.vue'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { shortcutsByGroup } from './shortcuts'
import { MAX_BYTES, MAX_PAGES } from '@/lib/limits'
import { conversionAvailable } from '@/features/convert/useJob'

/**
 * What the app does, and how to drive it.
 *
 * The shortcut table is rendered from `shortcuts.ts`, the same list the
 * bindings read their key combinations from. A help page maintained
 * separately from the bindings documents `⌘K` beside code that binds
 * something else, and nothing notices until a user writes in.
 */
const emit = defineEmits<{ close: [] }>()

const surface = ref<HTMLElement | null>(null)
useFocusTrap(surface, { onEscape: () => emit('close') })

const groups = shortcutsByGroup()
const canConvert = conversionAvailable()
const mb = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Help"
    data-help-panel
    @click.self="emit('close')"
  >
    <div
      ref="surface"
      tabindex="-1"
      class="my-8 flex w-full max-w-lg flex-col gap-5 rounded-panel bg-surface p-5 shadow-high"
    >
      <div class="flex items-start justify-between gap-3">
        <h2 class="text-[17px] font-medium">Help</h2>
        <IconButton size="sm" label="Close" data-help-close @click="emit('close')">
          <X :size="16" :stroke-width="1.5" />
        </IconButton>
      </div>

      <section class="flex flex-col gap-2">
        <h3 class="text-[14px] font-medium">What this is</h3>
        <p class="text-[13px] text-text-muted">
          A PDF editor that runs in this browser tab. Annotate, sign, reorder,
          redact, fill forms, and export — on documents up to {{ mb(MAX_BYTES) }}
          and {{ MAX_PAGES }} pages.
        </p>
        <p data-help-privacy class="text-[13px] text-text-muted">
          <template v-if="!canConvert">
            Your files never leave this device. There is no server to send them to.
          </template>
          <template v-else>
            Your files stay on this device, with one exception: converting a file
            needs software that cannot run in a browser, and that is the only
            feature that uploads anything. It asks first, every time.
          </template>
        </p>
      </section>

      <section class="flex flex-col gap-3">
        <h3 class="text-[14px] font-medium">Keyboard shortcuts</h3>
        <div v-for="[group, items] in groups" :key="group" class="flex flex-col gap-1">
          <p class="text-[12px] font-medium uppercase tracking-wide text-text-subtle">
            {{ group }}
          </p>
          <div
            v-for="item in items"
            :key="item.id"
            :data-help-shortcut="item.id"
            class="flex items-baseline justify-between gap-4 py-0.5 text-[13px]"
          >
            <span class="text-text-muted">{{ item.label }}</span>
            <kbd
              class="rounded border border-border bg-surface-sunken px-1.5 py-0.5
                     font-sans text-[12px] text-text"
            >{{ item.display }}</kbd>
          </div>
        </div>
        <p class="text-[12px] text-text-subtle">
          On Windows and Linux, use Ctrl where ⌘ is shown.
        </p>
      </section>

      <!--
        Pointing at the privacy page rather than restating it. Two copies of
        a privacy claim is two things to keep true, and the page is already
        the one that changes with the build.
      -->
      <section class="flex flex-col gap-2">
        <h3 class="text-[14px] font-medium">Anything else</h3>
        <p class="text-[13px] text-text-muted">
          Every feature is in the command palette — press
          <kbd class="rounded border border-border bg-surface-sunken px-1 font-sans text-[12px]">⌘K</kbd>.
          What this app stores on your device, and how to clear it, is listed on
          the privacy page.
        </p>
      </section>
    </div>
  </div>
</template>
