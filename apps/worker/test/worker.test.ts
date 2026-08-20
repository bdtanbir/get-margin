import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { JobType } from '@margin/shared'
import { resolveQueue, registerConverters, QUEUE_ADAPTERS, type QueueLike } from '../src/worker.js'
import { ConverterRegistry } from '../src/converters/types.js'

const run = promisify(execFile)

/** Records what was registered, standing in for whatever queue is wired later. */
function fakeQueue() {
  const registered = new Map<JobType, unknown>()
  const queue: QueueLike = { register: (type, handler) => void registered.set(type, handler) }
  return { queue, registered }
}

describe('resolveQueue', () => {
  /**
   * The state of this build, asserted rather than assumed.
   *
   * When someone adds a BullMQ adapter, this test fails and they change it
   * deliberately -- which is the point. An empty registry that nothing
   * checks is indistinguishable from one somebody forgot to populate.
   */
  it('ships no cross-process queue adapter', () => {
    expect(Object.keys(QUEUE_ADAPTERS)).toEqual([])
  })

  it('refuses, and says what is missing and where to look', () => {
    const resolved = resolveQueue({ REDIS_URL: 'redis://redis:6379' })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return

    // A refusal nobody can act on is only marginally better than a crash.
    expect(resolved.reason).toContain('BullMQ')
    expect(resolved.reason).toContain('QUEUE_ADAPTERS')
    expect(resolved.reason).toContain('17-deploy-verification.md')
  })

  it('refuses the same way whether or not a URL was configured', () => {
    // Both fail for the same real reason: there is no adapter to use.
    expect(resolveQueue({}).ok).toBe(false)
    expect(resolveQueue({ QUEUE_URL: 'redis://x' }).ok).toBe(false)
  })
})

describe('registerConverters', () => {
  it('registers exactly the converters this build has', () => {
    const { queue, registered } = fakeQueue()
    const types = registerConverters(queue)

    expect(types).toEqual(['html-to-pdf'])
    expect([...registered.keys()]).toEqual(['html-to-pdf'])
  })

  /** Reads the registry rather than a hardcoded list, so the two cannot drift. */
  it('registers nothing when the registry is empty', () => {
    const { queue, registered } = fakeQueue()
    expect(registerConverters(queue, new ConverterRegistry())).toEqual([])
    expect(registered.size).toBe(0)
  })

  /** Registering the name is not the claim -- the claim is that it converts. */
  it('registers a handler that actually converts', async () => {
    const { queue, registered } = fakeQueue()
    registerConverters(queue)

    const handler = registered.get('html-to-pdf') as (run: {
      type: JobType
      input: Uint8Array
      signal: AbortSignal
      report(p: number): void
    }) => Promise<Uint8Array>

    const out = await handler({
      type: 'html-to-pdf',
      input: new TextEncoder().encode('<html><body><p>x</p></body></html>'),
      signal: new AbortController().signal,
      report: () => {},
    })
    expect(new TextDecoder().decode(out.subarray(0, 5))).toBe('%PDF-')
  }, 60_000)
})

describe('the entrypoint infra/Dockerfile.worker names', () => {
  const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url))

  /**
   * The Dockerfile's CMD used to name a file that was not in the
   * repository, so the container died on a module-resolution error that
   * explained nothing. This runs the real entrypoint the real way.
   */
  it('exists, runs, and exits non-zero with an explanation', async () => {
    await expect(
      run(process.execPath, ['--import', 'tsx', MAIN], { env: { ...process.env, PATH: process.env.PATH ?? '' } }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('no cross-process queue adapter'),
    })
  }, 60_000)
})
