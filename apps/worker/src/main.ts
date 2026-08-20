import { resolveQueue, registerConverters } from './worker.js'

/**
 * The worker process entrypoint, named by `infra/Dockerfile.worker`.
 *
 * It is thin on purpose: everything worth testing lives in `worker.ts`,
 * and this file is the part that touches `process` and therefore cannot be
 * imported by a test without side effects.
 *
 * In this build it always exits 1, because no cross-process queue adapter
 * ships (see `QUEUE_ADAPTERS`). That is a deliberate, legible failure
 * rather than a stub that pretends to be a worker: a container that idles
 * while consuming nothing looks healthy to every orchestrator that watches
 * it, and would be discovered as a silently empty queue instead of a
 * crash loop with a message.
 */
const resolved = resolveQueue(process.env)

if (!resolved.ok) {
  process.stderr.write(`${resolved.reason}\n`)
  process.exit(1)
}

const types = registerConverters(resolved.queue)
// Types and a count only. Never a filename, never a payload -- the same
// rule the API's logger enforces, applied by not having anything else to
// say.
process.stdout.write(
  `worker ready: adapter=${resolved.adapter} converters=${types.join(',')}\n`,
)
