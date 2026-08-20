import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApi } from './server.js'

/**
 * The process entrypoint.
 *
 * It wires no converters. The converters live in `apps/worker` and, in
 * deployment, in a separate container -- the API is a small public HTTP
 * surface and the worker parses untrusted files, so coupling them would
 * put the public surface inside the parsers' blast radius
 * (`PHASE-7-DESIGN.md` §8). Running this alone gives you the job API with
 * every job failing "no converter", which is the honest behaviour for an
 * API with no worker behind it.
 */
const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '127.0.0.1'
const storageRoot = process.env.STORAGE_ROOT ?? join(tmpdir(), 'margin-jobs')

const { app } = await createApi({ storageRoot })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // `close` runs the onClose hook, which stops the sweeper's interval.
    void app.close().then(() => process.exit(0))
  })
}

await app.listen({ port, host })
