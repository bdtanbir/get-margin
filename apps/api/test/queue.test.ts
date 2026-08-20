import { describe, it, expect } from 'vitest'
import type { JobId } from '@margin/shared'
import { newJobId } from '../src/storage/types.js'
import { MemoryQueue } from '../src/jobs/memoryQueue.js'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('MemoryQueue', () => {
  it('moves a job queued -> running -> done', async () => {
    const results = new Map<JobId, Uint8Array | null>()
    const queue = new MemoryQueue({ onComplete: (id, r) => void results.set(id, r) })
    queue.register('html-to-pdf', async (run) => bytes(text(run.input).toUpperCase()))

    const id = newJobId()
    await queue.enqueue(id, 'html-to-pdf', bytes('page'))
    // Observable as `queued` before the handler runs -- the state machine
    // is real, not a status assigned after the fact.
    expect(queue.status(id)?.status).toBe('queued')

    await queue.drain()
    expect(queue.status(id)?.status).toBe('done')
    expect(text(results.get(id)!)).toBe('PAGE')
  })

  it('reports progress to a listener', async () => {
    const queue = new MemoryQueue()
    const seen: number[] = []
    queue.onProgress((_, p) => seen.push(p))
    queue.register('html-to-pdf', async (run) => {
      run.report(0.25)
      run.report(0.75)
      return bytes('x')
    })

    const id = newJobId()
    await queue.enqueue(id, 'html-to-pdf', bytes('x'))
    await queue.drain()
    expect(seen).toEqual([0.25, 0.75])
    expect(queue.status(id)?.progress).toBe(1)
  })

  it('clamps a progress report rather than trusting the converter', async () => {
    const queue = new MemoryQueue()
    const seen: number[] = []
    queue.onProgress((_, p) => seen.push(p))
    queue.register('html-to-pdf', async (run) => {
      run.report(-5)
      run.report(42)
      return bytes('x')
    })
    await queue.enqueue(newJobId(), 'html-to-pdf', bytes('x'))
    await queue.drain()
    expect(seen).toEqual([0, 1])
  })

  it('stops reporting to an unsubscribed listener', async () => {
    const queue = new MemoryQueue()
    const seen: number[] = []
    const off = queue.onProgress((_, p) => seen.push(p))
    off()
    queue.register('html-to-pdf', async (run) => {
      run.report(0.5)
      return bytes('x')
    })
    await queue.enqueue(newJobId(), 'html-to-pdf', bytes('x'))
    await queue.drain()
    expect(seen).toEqual([])
  })

  it('lands a throwing handler in failed, with its message', async () => {
    const queue = new MemoryQueue()
    queue.register('html-to-pdf', async () => {
      throw new Error('The document could not be rendered.')
    })
    const id = newJobId()
    await queue.enqueue(id, 'html-to-pdf', bytes('x'))
    await queue.drain()
    expect(queue.status(id)?.status).toBe('failed')
    expect(queue.status(id)?.error).toBe('The document could not be rendered.')
  })

  /**
   * A converter is handed attacker-controlled bytes and can throw
   * anything, including a string assembled from the input. Only
   * `Error.message` is ever taken, and a non-Error gets a fixed sentence.
   */
  it('does not adopt a thrown non-Error as the message', async () => {
    const queue = new MemoryQueue()
    queue.register('html-to-pdf', async () => {
      throw { secret: 'contents-of-the-uploaded-file' }
    })
    const id = newJobId()
    await queue.enqueue(id, 'html-to-pdf', bytes('x'))
    await queue.drain()
    expect(queue.status(id)?.error).toBe('Conversion failed.')
  })

  /**
   * Deletion is never contingent on the job succeeding: a job that failed
   * still had a file uploaded, and that file is the thing that matters.
   */
  it('signals completion even when the job failed', async () => {
    const completed: Array<[JobId, Uint8Array | null]> = []
    const queue = new MemoryQueue({ onComplete: (id, r) => void completed.push([id, r]) })
    queue.register('html-to-pdf', async () => {
      throw new Error('nope')
    })
    const id = newJobId()
    await queue.enqueue(id, 'html-to-pdf', bytes('x'))
    await queue.drain()
    expect(completed).toEqual([[id, null]])
  })

  it('stops a queued job before it runs', async () => {
    const queue = new MemoryQueue()
    let ran = false
    queue.register('html-to-pdf', async () => {
      ran = true
      return bytes('x')
    })
    const id = newJobId()
    await queue.enqueue(id, 'html-to-pdf', bytes('x'))
    expect(queue.cancel(id)).toBe(true)
    await queue.drain()
    expect(ran).toBe(false)
    expect(queue.status(id)?.status).toBe('failed')
    expect(queue.status(id)?.error).toBe('Cancelled.')
  })

  /**
   * A C++ parser mid-parse cannot be interrupted, so cancelling a running
   * job means its answer is thrown away -- not that the CPU is freed. The
   * result must not reach storage.
   */
  it('discards the result of a job cancelled while running', async () => {
    let release: () => void = () => {}
    const started = new Promise<void>((r) => (release = r))
    let handlerReached = false
    const completed: Array<Uint8Array | null> = []

    const queue = new MemoryQueue({ onComplete: (_, r) => void completed.push(r) })
    queue.register('html-to-pdf', async () => {
      handlerReached = true
      release()
      await new Promise((r) => setTimeout(r, 1))
      return bytes('too late')
    })

    const id = newJobId()
    await queue.enqueue(id, 'html-to-pdf', bytes('x'))
    await started
    expect(handlerReached).toBe(true)
    expect(queue.cancel(id)).toBe(true)
    await queue.drain()
    expect(completed).toEqual([null])
    expect(queue.status(id)?.status).toBe('failed')
  })

  it('tells a running handler it was cancelled', async () => {
    let release: () => void = () => {}
    const started = new Promise<void>((r) => (release = r))
    let aborted = false

    const queue = new MemoryQueue()
    queue.register('html-to-pdf', async (run) => {
      release()
      await new Promise((r) => setTimeout(r, 1))
      aborted = run.signal.aborted
      return bytes('x')
    })
    const id = newJobId()
    await queue.enqueue(id, 'html-to-pdf', bytes('x'))
    await started
    queue.cancel(id)
    await queue.drain()
    expect(aborted).toBe(true)
  })

  it('cancelling a finished job changes nothing', async () => {
    const queue = new MemoryQueue()
    queue.register('html-to-pdf', async () => bytes('x'))
    const id = newJobId()
    await queue.enqueue(id, 'html-to-pdf', bytes('x'))
    await queue.drain()
    expect(queue.cancel(id)).toBe(false)
    expect(queue.status(id)?.status).toBe('done')
  })

  /** An unknown id is a question, not a fault -- it is also how a purged job looks. */
  it('reports nothing for an id it has never seen, rather than throwing', () => {
    const queue = new MemoryQueue()
    expect(queue.status(newJobId())).toBeNull()
    expect(queue.cancel(newJobId())).toBe(false)
  })

  it('forgets a purged job entirely', async () => {
    const queue = new MemoryQueue()
    queue.register('html-to-pdf', async () => bytes('x'))
    const id = newJobId()
    await queue.enqueue(id, 'html-to-pdf', bytes('x'))
    await queue.drain()
    queue.forget(id)
    expect(queue.status(id)).toBeNull()
  })

  it('fails a job whose type has no registered converter', async () => {
    const queue = new MemoryQueue()
    const id = newJobId()
    await queue.enqueue(id, 'html-to-pdf', bytes('x'))
    await queue.drain()
    expect(queue.status(id)?.status).toBe('failed')
    expect(queue.status(id)?.error).toMatch(/no converter/i)
  })

  it('runs jobs independently', async () => {
    const queue = new MemoryQueue()
    queue.register('html-to-pdf', async (run) => {
      if (text(run.input) === 'bad') throw new Error('bad input')
      return bytes('ok')
    })
    const good = newJobId()
    const bad = newJobId()
    await queue.enqueue(good, 'html-to-pdf', bytes('good'))
    await queue.enqueue(bad, 'html-to-pdf', bytes('bad'))
    await queue.drain()
    expect(queue.status(good)?.status).toBe('done')
    expect(queue.status(bad)?.status).toBe('failed')
  })
})
