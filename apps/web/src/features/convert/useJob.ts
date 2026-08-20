import { ref, computed, onScopeDispose, type Ref } from 'vue'
import {
  jobStatusResponse,
  createJobResponse,
  isTerminal,
  type JobStatus,
  type JobType,
} from '@margin/shared'
import { downloadBytes, MIME } from '@/lib/exportFile'

/**
 * Where the conversion API lives, if it lives anywhere.
 *
 * EMPTY BY DEFAULT, and that is the product decision, not an oversight.
 * The app is a static site with no backend; conversion is an optional
 * service someone can point it at. With nothing configured the feature is
 * not offered, no upload is possible, and the privacy page's claim that
 * files never leave the device stays literally true.
 */
export const CONVERT_API_BASE: string =
  (import.meta.env?.VITE_CONVERT_API as string | undefined)?.replace(/\/$/, '') ?? ''

export function conversionAvailable(baseUrl: string = CONVERT_API_BASE): boolean {
  return baseUrl.length > 0
}

/** What the panel shows. `idle` means nothing has been submitted. */
export type UiStatus = 'idle' | 'uploading' | JobStatus

export type UseJobOptions = {
  baseUrl?: string
  /** Injected so tests drive real request/response shapes without a network. */
  fetchFn?: typeof fetch
  /** Injected so tests can assert what was handed to the browser. */
  download?: (bytes: Uint8Array, name: string, mime: string) => void
}

/** First poll delay, the multiplier, and the ceiling. */
export const POLL_START_MS = 500
export const POLL_FACTOR = 1.6
export const POLL_MAX_MS = 5_000

export type Job = {
  status: Ref<UiStatus>
  jobId: Ref<string | null>
  progress: Ref<number | undefined>
  error: Ref<string>
  resultReady: Ref<boolean>
  /** True once the result has been fetched and therefore deleted server-side. */
  downloaded: Ref<boolean>
  purged: Ref<boolean>
  busy: Ref<boolean>
  finished: Ref<boolean>
  start(file: File, type: JobType): Promise<void>
  download(): Promise<void>
  purge(): Promise<void>
  stop(): void
}

export function useJob(options: UseJobOptions = {}): Job {
  const baseUrl = options.baseUrl ?? CONVERT_API_BASE
  const doFetch = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const handOver = options.download ?? downloadBytes

  const status = ref<UiStatus>('idle')
  const jobId = ref<string | null>(null)
  const progress = ref<number | undefined>(undefined)
  const error = ref('')
  const resultReady = ref(false)
  const downloaded = ref(false)
  const purged = ref(false)
  const busy = ref(false)

  let timer: ReturnType<typeof setTimeout> | null = null
  let delay = POLL_START_MS

  const finished = computed(() => status.value !== 'idle' && status.value !== 'uploading' && isTerminal(status.value))

  function stop(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  // A poll outliving the component would keep hitting the API from a
  // screen nobody is looking at, and would burn the read budget doing it.
  onScopeDispose(stop)

  async function start(file: File, type: JobType): Promise<void> {
    if (busy.value) return
    busy.value = true
    error.value = ''
    downloaded.value = false
    purged.value = false
    progress.value = undefined
    resultReady.value = false
    status.value = 'uploading'

    try {
      const body = new FormData()
      body.append('type', type)
      body.append('file', file)

      // The type is in the query string as well as the body: the server's
      // rate limiter has to price the request before it reads the body, and
      // it refuses the two if they disagree.
      const res = await doFetch(`${baseUrl}/v1/jobs?type=${encodeURIComponent(type)}`, {
        method: 'POST',
        body,
      })
      if (!res.ok) {
        status.value = 'failed'
        error.value = await messageFrom(res)
        return
      }

      // Parsed against the SHARED schema, so a server that changed shape is
      // an error here rather than an undefined read three lines later.
      const created = createJobResponse.parse(await res.json())
      jobId.value = created.jobId
      status.value = 'queued'
      delay = POLL_START_MS
      schedule()
    } catch (e) {
      status.value = 'failed'
      error.value = networkMessage(e)
    } finally {
      busy.value = false
    }
  }

  function schedule(): void {
    stop()
    timer = setTimeout(() => void poll(), delay)
    // Backoff: a conversion can take minutes, and polling a minutes-long
    // job twice a second is a self-inflicted denial of service that the
    // server's own read budget would eventually refuse.
    delay = Math.min(POLL_MAX_MS, Math.round(delay * POLL_FACTOR))
  }

  async function poll(): Promise<void> {
    const id = jobId.value
    if (!id) return
    try {
      const res = await doFetch(`${baseUrl}/v1/jobs/${id}`)
      if (res.status === 404) {
        // Gone entirely: swept, or purged from somewhere else. Not an error.
        status.value = 'expired'
        resultReady.value = false
        stop()
        return
      }
      if (!res.ok) {
        error.value = await messageFrom(res)
        // A transient failure is not a terminal one -- keep polling, more
        // slowly, rather than declaring a job dead because one request was
        // refused.
        schedule()
        return
      }

      const body = jobStatusResponse.parse(await res.json())
      status.value = body.status
      progress.value = body.progress
      resultReady.value = body.resultReady
      if (body.error) error.value = body.error

      // Terminal means terminal: nothing further will happen, so nothing
      // further is asked.
      if (isTerminal(body.status)) stop()
      else schedule()
    } catch (e) {
      error.value = networkMessage(e)
      schedule()
    }
  }

  async function download(): Promise<void> {
    const id = jobId.value
    // `downloaded` is the guard, not just a flag: the result is deleted by
    // the read, so a second fetch would 404 and look like a failure.
    if (!id || busy.value || downloaded.value) return
    busy.value = true
    error.value = ''
    try {
      const res = await doFetch(`${baseUrl}/v1/jobs/${id}/result`)
      if (!res.ok) {
        error.value =
          res.status === 404
            ? 'That result is no longer on the server — it was deleted.'
            : await messageFrom(res)
        if (res.status === 404) {
          status.value = 'expired'
          resultReady.value = false
        }
        return
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      handOver(bytes, 'converted.pdf', MIME.pdf)
      downloaded.value = true
      resultReady.value = false
      // The server deleted it as we read it, so the local view says so
      // rather than continuing to offer a download that would now 404.
      status.value = 'expired'
      stop()
    } catch (e) {
      error.value = networkMessage(e)
    } finally {
      busy.value = false
    }
  }

  async function purge(): Promise<void> {
    const id = jobId.value
    if (!id) return
    stop()
    try {
      await doFetch(`${baseUrl}/v1/jobs/${id}`, { method: 'DELETE' })
    } catch {
      // A purge that could not reach the server still expires within the
      // hour. Reporting a scary failure for a file that will be deleted
      // anyway would be worse than saying nothing.
    }
    purged.value = true
    resultReady.value = false
    status.value = 'expired'
  }

  return {
    status,
    jobId,
    progress,
    error,
    resultReady,
    downloaded,
    purged,
    busy,
    finished,
    start,
    download,
    purge,
    stop,
  }
}

/** The server's own sentence when it has one, never a raw status code alone. */
async function messageFrom(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; retryAfter?: unknown }
    if (typeof body.error === 'string' && body.error) {
      if (typeof body.retryAfter === 'number') {
        return `${body.error} Try again in ${body.retryAfter}s.`
      }
      return body.error
    }
  } catch {
    // Not JSON. Fall through.
  }
  return `The server refused that request (${res.status}).`
}

function networkMessage(e: unknown): string {
  return e instanceof Error && e.name === 'ZodError'
    ? 'The server sent something this app did not understand.'
    : 'Could not reach the conversion service.'
}
