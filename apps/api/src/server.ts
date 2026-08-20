import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { MAX_UPLOAD_BYTES, type JobId } from '@margin/shared'
import type { Logger } from 'pino'
import { createLogger } from './plugins/logging.js'
import { LocalStorage } from './storage/local.js'
import { Sweeper } from './storage/sweeper.js'
import type { StorageAdapter } from './storage/types.js'
import { MemoryQueue } from './jobs/memoryQueue.js'
import type { JobHandler, JobQueue } from './jobs/types.js'
import { jobRoutes } from './routes/jobs.js'
import { rateLimit, type RateLimitOptions } from './plugins/rateLimit.js'

export type ServerOptions = {
  storage: StorageAdapter
  queue: JobQueue
  logger?: Logger
  maxUploadBytes?: number
  rateLimit?: RateLimitOptions
}

/**
 * Builds the queue with its storage side-effects attached.
 *
 * `onComplete` is the only place a result is written and the only place an
 * input is deleted, and it does BOTH regardless of how the job went.
 * Deletion of the upload is not contingent on success -- a conversion that
 * crashed still had a user's file on our disk, and that file is the thing
 * the privacy claim is about.
 */
export function createQueue(
  storage: StorageAdapter,
  handlers: Partial<Record<string, JobHandler>> = {},
): MemoryQueue {
  const queue = new MemoryQueue({
    onComplete: async (id, result) => {
      if (result) {
        await storage.put(id, 'result', result)
        // The input goes now, not at the TTL. There is nothing left to do
        // with it, and every minute it stays is a minute it can leak.
        await storage.delete(id, 'input')
      } else {
        // Failed or cancelled: nothing to keep, so the whole directory
        // goes and no empty husk waits for the sweeper.
        await storage.delete(id)
      }
    },
  })
  for (const [type, handler] of Object.entries(handlers)) {
    if (handler) queue.register(type as never, handler)
  }
  return queue
}

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const maxUploadBytes = options.maxUploadBytes ?? MAX_UPLOAD_BYTES
  const app = Fastify({
    // Widened to Fastify's own logger type: a pino `Logger` here would
    // specialise the instance's generics and make it incompatible with a
    // plain `FastifyInstance` at every boundary.
    loggerInstance: (options.logger ?? createLogger()) as FastifyBaseLogger,
    // Trust the proxy's forwarded address: the rate limiter keys on the
    // client IP, and behind a load balancer every request otherwise
    // arrives from one address and shares one budget.
    trustProxy: true,
    bodyLimit: maxUploadBytes,
  })

  // Called directly rather than through `register`, because a hook added
  // inside a plugin only fires for that plugin's own routes. The limit has
  // to cover everything, so it is installed on the root instance.
  await rateLimit(app, options.rateLimit ?? {})

  await app.register(multipart, {
    limits: {
      fileSize: maxUploadBytes,
      files: 1,
      fields: 4,
      // A field is a short string like `html-to-pdf`. Anything larger is
      // someone trying to smuggle the payload past the file limit.
      fieldSize: 1024,
    },
  })

  /**
   * The error handler exists to keep internals out of the response.
   *
   * Fastify's default serialises the error, and an error thrown from a
   * converter can carry fragments of the input in its message. A caller
   * gets a status and a fixed sentence; the log gets the type and the
   * message, which the logger's own serialiser has already stripped of a
   * stack.
   */
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500
    if (status >= 500) req.log.error({ err }, 'request failed')
    reply.code(status).send({ error: status >= 500 ? 'Something went wrong.' : err.message })
  })

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'Not found.' })
  })

  app.get('/health', async () => ({ ok: true }))

  await app.register(jobRoutes, {
    storage: options.storage,
    queue: options.queue,
    maxUploadBytes,
  })

  return app
}

export type ApiOptions = {
  storageRoot: string
  handlers?: Partial<Record<string, JobHandler>>
  logger?: Logger
  maxUploadBytes?: number
  rateLimit?: RateLimitOptions
  /** Off in tests: an interval that outlives a test file makes it hang. */
  sweep?: boolean
}

/** The whole API, wired: storage, queue, sweeper, routes. */
export async function createApi(options: ApiOptions): Promise<{
  app: FastifyInstance
  storage: StorageAdapter
  queue: MemoryQueue
  sweeper: Sweeper
}> {
  const storage = new LocalStorage(options.storageRoot)
  const queue = createQueue(storage, options.handlers)
  const sweeper = new Sweeper(storage, {
    // The sweep removes the bytes; this removes the memory of them, so a
    // swept job reads as one that never existed rather than as `expired`
    // forever.
    onExpire: (id: JobId) => queue.forget(id),
  })
  const app = await createServer({
    storage,
    queue,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.maxUploadBytes ? { maxUploadBytes: options.maxUploadBytes } : {}),
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
  })
  if (options.sweep !== false) sweeper.start()
  app.addHook('onClose', async () => sweeper.stop())
  return { app, storage, queue, sweeper }
}
