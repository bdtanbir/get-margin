<script setup lang="ts">
import { ref } from 'vue'
import { useFocusTrap } from '@/lib/useFocusTrap'
import Button from '@/ui/Button.vue'
import { TRACKED, setTelemetryChoice } from '@/lib/telemetry/analytics'

/**
 * The question, asked once, with the answer defaulting to no.
 *
 * Opt-in rather than opt-out, and that costs something real: most people
 * will not opt in, so the numbers will be partial and skewed toward people
 * who are comfortable being counted. It is the only setting consistent
 * with a privacy page that promises no analytics on documents -- that page
 * next to an opt-out toggle would be a page nobody should believe.
 *
 * Declining is a first-class button, not a link or a dismissal. A dialog
 * where "no" is harder to find than "yes" is a dark pattern regardless of
 * what the copy says.
 */
const emit = defineEmits<{ close: [] }>()

const surface = ref<HTMLElement | null>(null)
// Escape declines. Dismissing without answering must not be read as yes.
useFocusTrap(surface, { onEscape: () => decline() })

const features = Object.values(TRACKED)

function accept(): void {
  setTelemetryChoice('granted')
  emit('close')
}

function decline(): void {
  setTelemetryChoice('declined')
  emit('close')
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Help improve this app"
    data-telemetry-consent
    @click.self="decline"
  >
    <div
      ref="surface"
      tabindex="-1"
      class="my-8 flex w-full max-w-md flex-col gap-4 rounded-panel bg-surface p-5 shadow-high"
    >
      <h2 class="text-[17px] font-medium">Help improve this app?</h2>

      <p class="text-[13px] text-text-muted">
        We can count which features get used, so we know what to work on. It is
        entirely optional and the app works exactly the same either way.
      </p>

      <!--
        The actual list, rendered from the same constant the code counts
        against, rather than a sentence describing it. A description can
        drift from what is collected; this cannot.
      -->
      <div class="flex flex-col gap-1.5" data-telemetry-collected>
        <p class="text-[13px] font-medium">What would be counted</p>
        <ul class="flex list-disc flex-col gap-0.5 pl-5 text-[13px] text-text-muted">
          <li v-for="feature in features" :key="feature">{{ feature }}</li>
        </ul>
        <p class="text-[12px] text-text-subtle">
          Only how many times — never which document, never its name, never
          anything you typed.
        </p>
      </div>

      <div class="flex flex-col gap-1.5" data-telemetry-never>
        <p class="text-[13px] font-medium">What is never collected</p>
        <ul class="flex list-disc flex-col gap-0.5 pl-5 text-[13px] text-text-muted">
          <li>Your documents, or any part of them</li>
          <li>File names, sizes, or page contents</li>
          <li>Anything that could identify you or link these counts together</li>
        </ul>
      </div>

      <p class="text-[12px] text-text-subtle">
        You can change this at any time. Saying no is remembered, so you will not
        be asked again.
      </p>

      <!--
        Decline first and equally weighted. The primary styling goes to
        neither: this is a genuine question, and making "yes" the obvious
        button is how an opt-in becomes an opt-out with extra steps.
      -->
      <div class="flex justify-end gap-2">
        <Button variant="ghost" data-telemetry-decline @click="decline">No thanks</Button>
        <Button variant="ghost" data-telemetry-accept @click="accept">Yes, count features</Button>
      </div>
    </div>
  </div>
</template>
