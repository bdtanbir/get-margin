<script setup lang="ts">
import { ref, onErrorCaptured } from 'vue'
import { TriangleAlert } from 'lucide-vue-next'
import Button from '@/ui/Button.vue'
import { reporter } from '@/lib/telemetry/reporter'

const props = defineProps<{
  /** What part of the app this guards, named as the user would recognise it. */
  label: string
}>()

const emit = defineEmits<{ captured: [Error] }>()

const failure = ref<Error | undefined>(undefined)
/** Bumped to force a fresh subtree on retry; the old one may be half-built. */
const attempt = ref(0)

/**
 * Catch a descendant's error instead of letting it unmount the whole app.
 *
 * Returning false stops propagation: without it the error continues to the
 * next boundary and the root handler, and the panel below would be shown
 * at the same time as the app blanked.
 *
 * The error is RECORDED and NAMED, never swallowed. A boundary that hides
 * a failure is worse than no boundary -- the user sees a blank region with
 * no way to describe what happened.
 */
onErrorCaptured((err) => {
  failure.value = err instanceof Error ? err : new Error(String(err))
  emit('captured', failure.value)
  /**
   * Reported, if and only if reporting is both configured and consented
   * to -- the reporter decides that, not this call site.
   *
   * The ERROR is handed over rather than a message assembled here, because
   * the reporter is the thing that knows how to take a type and a scrubbed
   * message and nothing else. Passing a string built at this call site is
   * exactly how a filename would end up in a payload.
   */
  reporter().reportError({
    name: 'boundary-caught',
    component: 'ErrorBoundary',
    error: failure.value,
  })
  return false
})

function retry(): void {
  failure.value = undefined
  attempt.value++
}
</script>

<template>
  <div v-if="failure" data-boundary-failed class="flex h-full items-center justify-center p-6">
    <div class="flex max-w-md flex-col gap-3 rounded-panel border border-border bg-surface p-4">
      <div class="flex items-center gap-2 text-[14px] font-medium text-text">
        <TriangleAlert :size="18" :stroke-width="1.5" class="text-danger" />
        {{ props.label }} stopped working
      </div>
      <p class="text-[13px] text-text-muted">
        Your document is still open and your edits are still here. Only this part
        of the screen failed.
      </p>
      <!--
        The message is shown, not just logged. Without it the user cannot
        describe the failure to anyone, and neither can we.
      -->
      <p class="rounded-control bg-surface-sunken p-2 font-mono text-[12px] text-text-subtle">
        {{ failure.message }}
      </p>
      <Button class="self-start" data-boundary-retry @click="retry">Try again</Button>
    </div>
  </div>
  <slot v-else :key="attempt" />
</template>
