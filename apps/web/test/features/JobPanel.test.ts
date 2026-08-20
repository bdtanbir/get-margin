import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { effectScope } from 'vue'
import JobPanel from '@/features/convert/JobPanel.vue'
import { useJob, POLL_START_MS, POLL_FACTOR, type Job } from '@/features/convert/useJob'

const JOB_ID = 'A'.repeat(43)
const BASE = 'https://convert.example'

/** A response the real code will actually parse, not a stub object. */
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const statusBody = (over: Record<string, unknown> = {}) => ({
  jobId: JOB_ID,
  type: 'html-to-pdf',
  status: 'running',
  resultReady: false,
  ...over,
})

let fetchFn: ReturnType<typeof vi.fn>
let download: ReturnType<typeof vi.fn>
let scope: ReturnType<typeof effectScope>

/** Composables register scope-dispose hooks, so they need a scope to live in. */
function makeJob(): Job {
  scope = effectScope()
  return scope.run(() => useJob({ baseUrl: BASE, fetchFn: fetchFn as unknown as typeof fetch, download }))!
}

/** Runs the pending poll timer and lets its promise chain settle. */
async function tick(ms = POLL_START_MS * 4) {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

const file = () => new File(['<html><body>hi</body></html>'], 'report.html', { type: 'text/html' })

beforeEach(() => {
  vi.useFakeTimers()
  fetchFn = vi.fn()
  download = vi.fn()
})

afterEach(() => {
  scope?.stop()
  vi.useRealTimers()
})

describe('useJob', () => {
  it('submits the file and starts polling', async () => {
    fetchFn.mockResolvedValueOnce(json({ jobId: JOB_ID, statusUrl: `/v1/jobs/${JOB_ID}` }))
    const job = makeJob()
    await job.start(file(), 'html-to-pdf')

    expect(job.jobId.value).toBe(JOB_ID)
    expect(job.status.value).toBe('queued')

    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe(`${BASE}/v1/jobs?type=html-to-pdf`)
    expect(init.method).toBe('POST')
    // The type travels in the query string as well, because the server has
    // to price the request before it reads the body.
    expect((init.body as FormData).get('type')).toBe('html-to-pdf')
  })

  it('reports progress as the job runs', async () => {
    fetchFn
      .mockResolvedValueOnce(json({ jobId: JOB_ID, statusUrl: `/v1/jobs/${JOB_ID}` }))
      .mockResolvedValueOnce(json(statusBody({ status: 'running', progress: 0.4 })))
    const job = makeJob()
    await job.start(file(), 'html-to-pdf')
    await tick()

    expect(job.status.value).toBe('running')
    expect(job.progress.value).toBe(0.4)
  })

  /**
   * Terminal means terminal. A poll loop that keeps asking after `done`
   * spends the server's read budget on an answer that cannot change.
   */
  it('stops polling once the job is done', async () => {
    fetchFn
      .mockResolvedValueOnce(json({ jobId: JOB_ID, statusUrl: `/v1/jobs/${JOB_ID}` }))
      .mockResolvedValueOnce(json(statusBody({ status: 'done', resultReady: true })))
    const job = makeJob()
    await job.start(file(), 'html-to-pdf')
    await tick()

    expect(job.status.value).toBe('done')
    const callsAfterDone = fetchFn.mock.calls.length
    await tick(60_000)
    expect(fetchFn.mock.calls.length).toBe(callsAfterDone)
  })

  it('stops polling on failure too', async () => {
    fetchFn
      .mockResolvedValueOnce(json({ jobId: JOB_ID, statusUrl: `/v1/jobs/${JOB_ID}` }))
      .mockResolvedValueOnce(json(statusBody({ status: 'failed', error: 'Rendering failed.' })))
    const job = makeJob()
    await job.start(file(), 'html-to-pdf')
    await tick()

    const calls = fetchFn.mock.calls.length
    await tick(60_000)
    expect(fetchFn.mock.calls.length).toBe(calls)
    expect(job.error.value).toBe('Rendering failed.')
  })

  /** Backing off: a job that takes minutes must not be polled twice a second. */
  it('slows down between polls rather than hammering', async () => {
    fetchFn.mockResolvedValue(json(statusBody()))
    fetchFn.mockResolvedValueOnce(json({ jobId: JOB_ID, statusUrl: `/v1/jobs/${JOB_ID}` }))
    const job = makeJob()
    await job.start(file(), 'html-to-pdf')

    // Well short of the first delay: nothing has been asked yet.
    await tick(POLL_START_MS - 50)
    expect(fetchFn.mock.calls.length).toBe(1)

    await tick(100)
    expect(fetchFn.mock.calls.length).toBe(2)

    // The second gap is longer than the first, so the same elapsed time
    // does not produce another poll.
    await tick(POLL_START_MS - 50)
    expect(fetchFn.mock.calls.length).toBe(2)
  })

  it('downloads the result exactly once', async () => {
    fetchFn
      .mockResolvedValueOnce(json({ jobId: JOB_ID, statusUrl: `/v1/jobs/${JOB_ID}` }))
      .mockResolvedValueOnce(json(statusBody({ status: 'done', resultReady: true })))
      .mockResolvedValueOnce(new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])))
    const job = makeJob()
    await job.start(file(), 'html-to-pdf')
    await tick()

    await job.download()
    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0]![1]).toBe('converted.pdf')

    // A second attempt fetches nothing: the read deleted the result, so
    // asking again would 404 and look like a failure.
    const calls = fetchFn.mock.calls.length
    await job.download()
    expect(fetchFn.mock.calls.length).toBe(calls)
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('treats a downloaded job as deleted, because the server deleted it', async () => {
    fetchFn
      .mockResolvedValueOnce(json({ jobId: JOB_ID, statusUrl: `/v1/jobs/${JOB_ID}` }))
      .mockResolvedValueOnce(json(statusBody({ status: 'done', resultReady: true })))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
    const job = makeJob()
    await job.start(file(), 'html-to-pdf')
    await tick()
    await job.download()

    expect(job.downloaded.value).toBe(true)
    expect(job.resultReady.value).toBe(false)
    expect(job.status.value).toBe('expired')
  })

  it('purges on request and says the file is gone', async () => {
    fetchFn
      .mockResolvedValueOnce(json({ jobId: JOB_ID, statusUrl: `/v1/jobs/${JOB_ID}` }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const job = makeJob()
    await job.start(file(), 'html-to-pdf')
    await job.purge()

    const [url, init] = fetchFn.mock.calls[1]!
    expect(url).toBe(`${BASE}/v1/jobs/${JOB_ID}`)
    expect(init.method).toBe('DELETE')
    expect(job.purged.value).toBe(true)
    expect(job.status.value).toBe('expired')
  })

  it('stops polling after a purge', async () => {
    fetchFn
      .mockResolvedValueOnce(json({ jobId: JOB_ID, statusUrl: `/v1/jobs/${JOB_ID}` }))
      .mockResolvedValue(new Response(null, { status: 204 }))
    const job = makeJob()
    await job.start(file(), 'html-to-pdf')
    await job.purge()

    const calls = fetchFn.mock.calls.length
    await tick(60_000)
    expect(fetchFn.mock.calls.length).toBe(calls)
  })

  /** A job the server has forgotten is deleted, not broken. */
  it('reads a 404 while polling as expired rather than as an error', async () => {
    fetchFn
      .mockResolvedValueOnce(json({ jobId: JOB_ID, statusUrl: `/v1/jobs/${JOB_ID}` }))
      .mockResolvedValueOnce(json({ error: 'No such job.' }, 404))
    const job = makeJob()
    await job.start(file(), 'html-to-pdf')
    await tick()

    expect(job.status.value).toBe('expired')
    expect(job.error.value).toBe('')
  })

  it('surfaces the server’s own refusal, including when to retry', async () => {
    fetchFn.mockResolvedValueOnce(
      json({ error: 'Too many requests. Try again shortly.', retryAfter: 30 }, 429),
    )
    const job = makeJob()
    await job.start(file(), 'html-to-pdf')

    expect(job.status.value).toBe('failed')
    expect(job.error.value).toContain('Too many requests')
    expect(job.error.value).toContain('30s')
  })

  it('keeps polling through one failed request rather than giving up', async () => {
    fetchFn
      .mockResolvedValueOnce(json({ jobId: JOB_ID, statusUrl: `/v1/jobs/${JOB_ID}` }))
      .mockResolvedValueOnce(json({ error: 'Bad gateway.' }, 502))
      .mockResolvedValueOnce(json(statusBody({ status: 'done', resultReady: true })))
    const job = makeJob()
    await job.start(file(), 'html-to-pdf')

    // One poll at a time: the default tick jumps far enough to run both,
    // which would hide the fact that the first one was survived rather
    // than skipped.
    await tick(POLL_START_MS + 10)
    expect(job.status.value).toBe('queued')

    await tick(POLL_START_MS * POLL_FACTOR + 10)
    expect(job.status.value).toBe('done')
  })

  it('reports an unreachable service without pretending the job failed silently', async () => {
    fetchFn.mockRejectedValueOnce(new TypeError('network error'))
    const job = makeJob()
    await job.start(file(), 'html-to-pdf')
    expect(job.status.value).toBe('failed')
    expect(job.error.value).toMatch(/could not reach/i)
  })
})

describe('JobPanel', () => {
  async function panelAt(over: Record<string, unknown>) {
    fetchFn
      .mockResolvedValueOnce(json({ jobId: JOB_ID, statusUrl: `/v1/jobs/${JOB_ID}` }))
      .mockResolvedValueOnce(json(statusBody(over)))
    const job = makeJob()
    await job.start(file(), 'html-to-pdf')
    await tick()
    return { job, w: mount(JobPanel, { props: { job, fileName: 'report.html' } }) }
  }

  it('renders progress while the job runs', async () => {
    const { w } = await panelAt({ status: 'running', progress: 0.42 })
    expect(w.get('[data-job-headline]').text()).toContain('42%')
    expect(w.get('[data-job-progress]').attributes('aria-valuenow')).toBe('42')
  })

  it('shows no progress bar when the converter cannot report one', async () => {
    const { w } = await panelAt({ status: 'running' })
    expect(w.find('[data-job-progress]').exists()).toBe(false)
    expect(w.get('[data-job-headline]').text()).toContain('Converting')
  })

  it('shows the reason a job failed', async () => {
    const { w } = await panelAt({ status: 'failed', error: 'That HTML could not be rendered.' })
    expect(w.get('[data-job-error]').text()).toBe('That HTML could not be rendered.')
    expect(w.get('[data-job-headline]').classes()).toContain('text-danger')
  })

  it('offers a download only when there is one', async () => {
    const { w } = await panelAt({ status: 'done', resultReady: true })
    expect(w.find('[data-job-download]').exists()).toBe(true)

    const { w: running } = await panelAt({ status: 'running' })
    expect(running.find('[data-job-download]').exists()).toBe(false)
  })

  /**
   * The distinction this whole status enum exists for.
   *
   * A file deleted on schedule is the product keeping its promise. Rendered
   * in the same red as a crash, it teaches people that the privacy
   * guarantee looks like a bug.
   */
  it('reads expired as deleted on schedule, not as an error', async () => {
    const { w } = await panelAt({ status: 'expired' })
    const headline = w.get('[data-job-headline]')
    expect(headline.text()).toMatch(/deleted from the server on schedule/i)
    expect(headline.classes()).not.toContain('text-danger')
    expect(w.find('[data-job-error]').exists()).toBe(false)
  })

  it('says the file is gone after a purge, and stops offering to delete it again', async () => {
    const { job, w } = await panelAt({ status: 'done', resultReady: true })
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await w.get('[data-job-purge]').trigger('click')
    await flushPromises()

    expect(job.purged.value).toBe(true)
    expect(w.get('[data-job-headline]').text()).toMatch(/deleted from the server, as you asked/i)
    expect(w.find('[data-job-purge]').exists()).toBe(false)
    expect(w.find('[data-job-download]').exists()).toBe(false)
  })

  it('says the file was deleted after a download', async () => {
    const { w } = await panelAt({ status: 'done', resultReady: true })
    fetchFn.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))

    await w.get('[data-job-download]').trigger('click')
    await flushPromises()

    expect(w.get('[data-job-headline]').text()).toMatch(/downloaded, and deleted from the server/i)
    expect(download).toHaveBeenCalledTimes(1)
  })

  /** The promise is worth more next to the button that acts on it. */
  it('states the deletion policy while the file is still on the server', async () => {
    const { w } = await panelAt({ status: 'running' })
    const text = w.get('[data-job-retention]').text()
    expect(text).toMatch(/as soon as you download/i)
    expect(text).toMatch(/within an hour/i)
    expect(w.find('[data-job-purge]').exists()).toBe(true)
  })
})
