<script setup lang="ts">
import { ref } from 'vue'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { X } from 'lucide-vue-next'
import Button from '@/ui/Button.vue'
import IconButton from '@/ui/IconButton.vue'
import { clearEdits } from '@/lib/autosaveDb'
import { clearSignatures } from '@/features/signature/signatureStore'
import { MAX_BYTES, MAX_PAGES } from '@/lib/limits'
import { conversionAvailable } from '@/features/convert/useJob'
import { telemetryState } from '@/lib/telemetry/analytics'

const emit = defineEmits<{ close: [] }>()
const surface = ref<HTMLElement | null>(null)
const cleared = ref(false)

/**
 * Whether this build has a conversion service behind it.
 *
 * The claim below has to change when it does. A privacy page that says
 * "there is no server to upload it to" in a build that has one is the
 * exact failure the previous phase already fixed once, and it is worse
 * here because the sentence is the whole point of the page.
 */
const canConvert = conversionAvailable()

/**
 * Whether this build can send usage counts at all, and whether it is.
 *
 * Same reasoning as `canConvert`: the claims below have to change when the
 * capability does. "No analytics" is true of the shipped build and would
 * be false in one with an endpoint configured and consent given.
 */
const telemetry = telemetryState

useFocusTrap(surface, { onEscape: () => emit('close') })

/**
 * Clear everything this app has stored. Deliberately reachable from the
 * page that lists it: telling someone what you keep without offering to
 * delete it is half an answer.
 */
async function clearAll(): Promise<void> {
  await Promise.all([clearEdits(), clearSignatures()])
  try {
    localStorage.removeItem('get-margin-theme')
  } catch {
    // Private mode; nothing was stored to begin with.
  }
  cleared.value = true
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 text-left"
    role="dialog"
    aria-modal="true"
    aria-label="Privacy"
    data-privacy-page
    @click.self="emit('close')"
  >
    <div ref="surface" tabindex="-1" class="my-8 flex w-full max-w-lg flex-col gap-4 rounded-panel bg-surface p-5 shadow-high">
      <div class="flex items-start justify-between gap-3">
        <h2 class="text-[17px] font-medium">Privacy</h2>
        <IconButton size="sm" label="Close" data-privacy-close @click="emit('close')">
          <X :size="16" :stroke-width="1.5" />
        </IconButton>
      </div>

      <section class="flex flex-col gap-2">
        <h3 v-if="!canConvert" class="text-[14px] font-medium">
          Your files never leave this device
        </h3>
        <h3 v-else class="text-[14px] font-medium">
          Your files stay on this device, with one exception you choose
        </h3>

        <p class="text-[13px] text-text-muted" data-privacy-local>
          Every PDF you open is read, edited, and exported inside this browser tab.
          <template v-if="!canConvert">
            Nothing is uploaded, and there is no server to upload it to — this app is
            a static site with no backend, no accounts, and no analytics on your
            documents.
          </template>
          <template v-else>
            There are no accounts and no analytics on your documents, and nothing is
            uploaded as you work.
          </template>
        </p>

        <!--
          Only shown when a conversion service is actually configured. The
          app ships without one, and in that build the paragraph above is
          literally true rather than nearly true.
        -->
        <p v-if="canConvert" class="text-[13px] text-text-muted" data-privacy-convert>
          <strong>The one exception is file conversion.</strong> Converting a file
          needs software that cannot run in a browser, so that one file is sent to a
          server — but only after you are shown exactly what is being sent and agree
          to it, every single time. It is deleted as soon as you download the result,
          and within an hour regardless. Its name is never stored or logged, and you
          can delete it yourself without waiting.
        </p>
      </section>

      <!--
        The honest half. Claiming "nothing is stored" would be false, and a
        privacy page that is false about the easy part is not worth reading.
        Every item here is something the code actually writes; see
        lib/autosaveDb.ts, features/signature/signatureStore.ts, lib/theme.ts.
      -->
      <section class="flex flex-col gap-2">
        <h3 class="text-[14px] font-medium">What is stored on this device</h3>
        <ul class="flex list-disc flex-col gap-2 pl-5 text-[13px] text-text-muted">
          <li>
            <strong>Your edits.</strong> Annotations, shapes, text you type and page
            changes are saved as you work, so a crashed tab does not lose an hour of it.
            They are matched back to a file by a fingerprint of its contents — which
            means <em>the PDF itself is never stored</em>, only what you did to it. You
            are asked before anything is restored.
          </li>
          <li>
            <strong>Answers you type into a PDF's form fields</strong>, which are saved
            the same way and for the same reason. On a real form that is often your
            name, address, or an account number, so it is worth saying plainly rather
            than leaving it inside "your edits". Clearing below removes them.
          </li>
          <li>
            <strong>The name of each file you open</strong> — the name only, so the
            restore prompt can tell you which document it found edits for. Not its
            contents.
          </li>
          <li>
            <strong>Saved signatures</strong>, and only if you tick the box that says so.
            Unticked by default.
          </li>
          <li><strong>Your light or dark theme preference.</strong></li>
        </ul>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="text-[14px] font-medium">What is not stored</h3>
        <p class="text-[13px] text-text-muted">
          The PDF files themselves — their pages, their text, and their images. Files up
          to {{ mb(MAX_BYTES) }} and {{ MAX_PAGES }} pages are held in memory while open
          and discarded when you close the tab. There are no accounts and no identifiers
          of any kind.
          <template v-if="!telemetry.configured"> There are no analytics.</template>
        </p>

        <!--
          Only in a build that can actually send something. The default
          build cannot, and in that build the sentence above is unqualified
          because it is unqualifiedly true.
        -->
        <p v-if="telemetry.configured" data-privacy-telemetry class="text-[13px] text-text-muted">
          <strong>Usage counts are {{ telemetry.sending ? 'on' : 'off' }}.</strong>
          This build can count how many times a feature is used — how many exports, how
          many redactions — and nothing else: never a document, never a file name, never
          anything you typed, and never an identifier that would link those counts to you
          or to each other. It is off until you say yes, and you are asked only once.
        </p>
        <!--
          Deliberately NOT a claim that nothing identifying is stored. It
          would be false the moment someone types their name into a text box
          or a form field, and a privacy page that overclaims on the part
          the user can check is not worth reading on the parts they cannot.
        -->
        <p class="text-[13px] text-text-muted">
          Anything <em>you</em> write, though — text you add, and answers you fill in —
          is part of your edits above, and is saved on this device until you clear it.
        </p>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="text-[14px] font-medium">One more thing about downloads</h3>
        <p class="text-[13px] text-text-muted">
          Exported PDFs have any embedded JavaScript and automatic actions removed,
          so a file you pass on cannot carry a script that came in with the original.
          If the original used scripts for form validation, those go too.
        </p>
      </section>

      <div class="flex items-center gap-3">
        <Button variant="danger" data-privacy-clear @click="clearAll">
          Clear everything stored
        </Button>
        <span v-if="cleared" data-privacy-cleared class="text-[13px] text-text-muted">
          Cleared.
        </span>
      </div>
    </div>
  </div>
</template>
