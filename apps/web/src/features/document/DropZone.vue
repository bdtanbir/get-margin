<script setup lang="ts">
import { ref, computed } from 'vue'
import { useDropZone } from '@vueuse/core'
import { FileUp } from 'lucide-vue-next'
import Button from '@/ui/Button.vue'
import { useDocumentStore } from '@/stores/document'
import { MAX_BYTES, MAX_PAGES } from '@/lib/limits'
import PrivacyPage from './PrivacyPage.vue'
import MadeBy from '@/ui/MadeBy.vue'

const doc = useDocumentStore()
const privacyOpen = ref(false)
const zone = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)

const { isOverDropZone } = useDropZone(zone, {
  dataTypes: ['application/pdf'],
  onDrop(files) {
    const file = files?.[0]
    if (file) void doc.openFile(file)
  },
})

const busy = computed(() => doc.status === 'opening')

function pick(): void { input.value?.click() }
function onInput(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) void doc.openFile(file)
  ;(e.target as HTMLInputElement).value = '' // allow re-picking the same file
}
</script>

<template>
  <div
    ref="zone"
    data-empty-state
    class="flex h-dvh w-full flex-col items-center justify-center gap-5 p-6 transition-colors duration-base"
    :class="isOverDropZone ? 'bg-accent-subtle' : 'bg-canvas'"
  >
    <div
      class="flex w-full max-w-md flex-col items-center gap-4 rounded-sheet border-2 border-dashed
             bg-surface px-7 py-10 text-center shadow-low transition-colors duration-base"
      :class="isOverDropZone ? 'border-accent' : 'border-border hover:border-border-strong'"
    >
      <!--
        Decorative: the heading below carries the meaning, and a screen
        reader announcing "file up" before it would just be noise.
      -->
      <div
        class="rounded-full bg-accent-subtle p-3.5 text-accent transition-colors duration-base"
        aria-hidden="true"
      >
        <FileUp :size="26" :stroke-width="1.5" />
      </div>

      <!--
        A newcomer arriving here has no idea what this is. "Open a PDF"
        tells them what to do but not what they will get, and the one thing
        that most distinguishes this from every other PDF site -- that the
        file never leaves the machine -- is exactly what someone about to
        hand over a contract or a passport scan wants to know first.
      -->
      <div class="space-y-1.5">
        <h2 class="text-xl font-semibold tracking-tight">Edit a PDF, privately</h2>
        <p class="text-[13px] text-text-muted">
          Annotate, sign, reorder and export — all in this browser tab.
          Nothing is uploaded.
        </p>
        <p class="pt-1 text-[13px] text-text-muted">
          Drag a file here, or choose one from your device.
        </p>
      </div>

      <Button variant="primary" :loading="busy" @click="pick">
        {{ busy ? 'Opening…' : 'Choose file' }}
      </Button>

      <!--
        Hidden from the accessibility tree, and out of the tab order, the
        same way AddSourceButton hides its own input.

        `sr-only` alone left it visible to screen readers with no name at
        all -- axe rates a nameless file input as critical, and this is the
        control that opens a document. It also left a second tab stop
        immediately after "Choose file", invisible and with no focus ring,
        that did the same thing as the button.

        The visible button IS the control: it has a name, a focus ring, and
        forwards its click here. So the fix is to stop exposing the input
        twice rather than to give the duplicate a label.
      -->
      <input
        ref="input"
        type="file"
        accept="application/pdf,.pdf"
        class="sr-only"
        tabindex="-1"
        aria-hidden="true"
        @change="onInput"
      >

      <!--
        The fine print, gathered behind a rule rather than left as two more
        items in the main stack. Both lines answer "what will this cost me
        and what happens to my file" -- questions asked after the headline
        has landed -- and spacing them like the headline gave a size limit
        the same weight as the product's one-line pitch.

        The limits are said UP FRONT rather than surfaced as an error after
        a failed open, and read from lib/limits.ts rather than retyped so
        the copy and the check cannot drift.
      -->
      <div class="mt-1 w-full space-y-2 border-t border-border pt-4">
        <p class="text-[12px] text-text-subtle">
          Up to {{ Math.round(MAX_BYTES / 1048576) }} MB and {{ MAX_PAGES }} pages.
          Your file stays on this device.
        </p>

        <button
          type="button"
          data-open-privacy-from-empty
          class="text-[12px] text-accent underline underline-offset-2 hover:text-accent-hover"
          @click="privacyOpen = true"
        >What is stored on this device?</button>
      </div>

      <PrivacyPage v-if="privacyOpen" @close="privacyOpen = false" />

      <!--
        Given a box of its own rather than left as red text on the card. An
        open that failed is the one moment the user needs to notice
        something, and at 13px it read as one more line of the fine print
        it sits next to.

        A danger BORDER on the card's own surface, not a `danger-subtle`
        fill. The obvious version -- `text-danger` on `bg-danger-subtle` --
        measures 4.22:1 in the dark theme, under AA's 4.5, while
        `text-danger` on `surface` is 5.41 light and 4.74 dark. Neither
        pairing is covered by test/lib/contrast.test.ts, which walks the
        three text tokens over the four surface tokens and so sees no
        combination involving `danger` at all.
      -->
      <p
        v-if="doc.error"
        role="alert"
        class="w-full rounded-control border border-danger bg-surface px-3 py-2 text-[13px] text-danger"
      >{{ doc.error }}</p>
    </div>

    <!--
      Outside the dashed card, so it reads as the page's footer rather than
      as one more thing inside the drop target. This is the only screen a
      visitor sees before opening a file, which makes it the one place a
      credit is worth the pixels.
    -->
    <MadeBy />
  </div>
</template>
