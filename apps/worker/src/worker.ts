import type { JobType } from '@margin/shared'
import { createHandlers, createRegistry, type HandlerRun } from './index.js'
import type { ConverterRegistry } from './converters/types.js'

/**
 * The part of a queue a worker needs: somewhere to hand its handlers.
 *
 * Structural rather than an import, so the worker does not depend on the
 * API package. The API's `JobQueue` satisfies it, and so will a BullMQ
 * adapter.
 */
export type QueueLike = {
  register(type: JobType, handler: (run: HandlerRun) => Promise<Uint8Array>): void
}

/**
 * The cross-process queue adapters this build ships.
 *
 * EMPTY, and that is the honest state rather than an oversight. The only
 * queue implementation in the repository is in-process (`MemoryQueue`),
 * which is what makes the whole job path testable here; a BullMQ adapter
 * needs a real Redis to be worth anything, and the pre-flight found none
 * (`docs/findings/16-phase-7-preflight.md`). An adapter written against a
 * mock of Redis proves things about the mock.
 *
 * Adding one means adding it here, which is deliberately a visible change
 * to a named thing rather than a quiet one.
 */
export const QUEUE_ADAPTERS: Record<string, (url: string) => QueueLike> = {}

export type Resolved =
  | { ok: true; queue: QueueLike; adapter: string }
  | { ok: false; reason: string }

/**
 * Works out which queue to consume from, and refuses legibly when there is
 * none.
 *
 * The refusal is the point. Before this existed, `Dockerfile.worker`
 * named an entrypoint that was not in the repository, so the container
 * died on a module-resolution error that said nothing about why. A process
 * that explains what is missing and names the checklist is a better
 * failure than one that cannot start.
 */
export function resolveQueue(env: Record<string, string | undefined>): Resolved {
  const url = env.QUEUE_URL ?? env.REDIS_URL
  const available = Object.keys(QUEUE_ADAPTERS)

  if (available.length === 0) {
    return {
      ok: false,
      reason: [
        'This build ships no cross-process queue adapter, so the worker has nothing to consume.',
        '',
        'The queue that exists is in-process (apps/api/src/jobs/memoryQueue.ts) and runs',
        'converters inside the API. Running the worker as its own container needs a BullMQ',
        'adapter registered in QUEUE_ADAPTERS (apps/worker/src/worker.ts), against a real',
        'Redis. See PHASE-7-DESIGN.md section 0 for why it was not written blind, and',
        'docs/findings/17-deploy-verification.md item 2 for what to verify once it is.',
      ].join('\n'),
    }
  }

  if (!url) {
    return { ok: false, reason: 'Set QUEUE_URL (or REDIS_URL) to the queue this worker consumes.' }
  }

  const scheme = url.split(':')[0] ?? ''
  const make = QUEUE_ADAPTERS[scheme]
  if (!make) {
    return {
      ok: false,
      reason: `No queue adapter for "${scheme}". This build has: ${available.join(', ')}.`,
    }
  }
  return { ok: true, queue: make(url), adapter: scheme }
}

/**
 * Puts every converter this build has onto a queue.
 *
 * Returns what it registered, so a caller can log a count without
 * inspecting the queue -- and so a test can assert that the worker offers
 * exactly the converters that exist, rather than a hardcoded list that
 * could drift from them.
 */
export function registerConverters(
  queue: QueueLike,
  registry: ConverterRegistry = createRegistry(),
): JobType[] {
  const handlers = createHandlers(registry)
  const types = Object.keys(handlers) as JobType[]
  for (const type of types) {
    const handler = handlers[type]
    if (handler) queue.register(type, handler)
  }
  return types
}
