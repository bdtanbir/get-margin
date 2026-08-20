<script setup lang="ts">
import { computed } from 'vue'
import Button from '@/ui/Button.vue'
import type { Job } from './useJob'

/**
 * What a conversion looks like while it happens, and afterwards.
 *
 * Takes the job rather than creating one, so a test drives real state
 * transitions through the composable and the panel stays a view.
 */
const props = defineProps<{ job: Job; fileName: string }>()
const emit = defineEmits<{ close: [] }>()

const percent = computed(() =>
  props.job.progress.value === undefined ? null : Math.round(props.job.progress.value * 100),
)

/**
 * `expired` is not a failure, and this is the line that decides whether a
 * user reads it as one.
 *
 * A file deleted on schedule is the product keeping its promise. Showing it
 * in the same red as "the conversion crashed" would teach people that the
 * privacy guarantee looks like a bug.
 */
const headline = computed(() => {
  switch (props.job.status.value) {
    case 'idle':
      return 'Ready to convert.'
    case 'uploading':
      return 'Uploading…'
    case 'queued':
      return 'Waiting for a converter…'
    case 'running':
      return percent.value === null ? 'Converting…' : `Converting… ${percent.value}%`
    case 'done':
      return 'Done. Your file is ready to download.'
    case 'failed':
      return 'The conversion did not work.'
    case 'expired':
      if (props.job.purged.value) return 'Deleted from the server, as you asked.'
      if (props.job.downloaded.value) return 'Downloaded, and deleted from the server.'
      return 'This file was deleted from the server on schedule.'
    default:
      return ''
  }
})

const isFailure = computed(() => props.job.status.value === 'failed')
const isWorking = computed(() =>
  ['uploading', 'queued', 'running'].includes(props.job.status.value),
)
</script>

<template>
  <section class="flex flex-col gap-3 rounded-panel border border-border bg-surface p-4" data-job-panel>
    <div class="flex items-baseline justify-between gap-3">
      <h3 class="text-[14px] font-medium">{{ fileName }}</h3>
      <span
        class="text-[12px]"
        :class="isFailure ? 'text-danger' : 'text-text-subtle'"
        :data-job-status="job.status.value"
      >{{ job.status.value }}</span>
    </div>

    <p
      class="text-[13px]"
      :class="isFailure ? 'text-danger' : 'text-text-muted'"
      data-job-headline
    >{{ headline }}</p>

    <!--
      A determinate bar only when there is a real number behind it. A bar
      that animates without knowing anything is a lie about progress.
    -->
    <div
      v-if="isWorking && percent !== null"
      class="h-1.5 w-full overflow-hidden rounded-full bg-border"
      role="progressbar"
      :aria-valuenow="percent"
      aria-valuemin="0"
      aria-valuemax="100"
      data-job-progress
    >
      <div class="h-full rounded-full bg-accent transition-all" :style="{ width: `${percent}%` }" />
    </div>

    <p v-if="job.error.value" data-job-error class="text-[13px] text-danger">
      {{ job.error.value }}
    </p>

    <!--
      The deletion promise, restated where it can be acted on. Saying a file
      is deleted within the hour is worth more when the button to do it now
      is next to the sentence.
    -->
    <p
      v-if="!job.purged.value && !job.downloaded.value && job.status.value !== 'expired'"
      data-job-retention
      class="text-[12px] text-text-subtle"
    >
      Your file is deleted from the server as soon as you download it, and within
      an hour regardless.
    </p>

    <div class="flex justify-end gap-2">
      <Button
        v-if="!job.purged.value && job.status.value !== 'expired' && job.status.value !== 'idle'"
        variant="ghost"
        data-job-purge
        @click="job.purge()"
      >Delete from server</Button>
      <Button
        v-if="job.resultReady.value"
        variant="primary"
        data-job-download
        :loading="job.busy.value"
        @click="job.download()"
      >Download</Button>
      <Button
        v-if="job.finished.value"
        variant="ghost"
        data-job-close
        @click="emit('close')"
      >Close</Button>
    </div>
  </section>
</template>
