import type { JobType } from '@margin/shared'
import { ConverterRegistry, type ConvertOptions, type Converter } from './converters/types.js'
import { HtmlConverter } from './converters/html.js'

export { ConverterRegistry, ConversionTimeout } from './converters/types.js'
export type { Converter, ConvertOptions } from './converters/types.js'
export { HtmlConverter, DEFAULT_TIMEOUT_MS } from './converters/html.js'

/**
 * Every converter this build has.
 *
 * One entry. `office` and `ocr` are absent rather than stubbed -- see
 * `converters/types.ts` and `PHASE-7-DESIGN.md` §0. The shared `JobType`
 * enum has one member for the same reason, so the registry and the API's
 * capability list are the same list by construction rather than by
 * agreement.
 */
export function createRegistry(): ConverterRegistry {
  return new ConverterRegistry().register(new HtmlConverter())
}

/**
 * The registry as job handlers, ready to hand to the queue.
 *
 * This is the seam between the two processes. Today the API can import it
 * and run conversions in-process, which is what makes the whole path
 * testable here. In deployment the worker is a separate container with no
 * network egress, and this same map is built on the far side of the queue
 * (`PHASE-7-DESIGN.md` §8) -- the API keeps a small public HTTP surface
 * and the parsers stay out of its blast radius.
 */
export function createHandlers(
  registry: ConverterRegistry = createRegistry(),
): Record<string, (run: HandlerRun) => Promise<Uint8Array>> {
  const handlers: Record<string, (run: HandlerRun) => Promise<Uint8Array>> = {}
  for (const type of registry.types()) {
    const converter = registry.get(type) as Converter
    handlers[type] = (run) =>
      converter.convert(run.input, {
        signal: run.signal,
        report: run.report,
      } satisfies ConvertOptions)
  }
  return handlers
}

/** The shape the queue hands a handler. Structural, so the worker does not import the API. */
export type HandlerRun = {
  readonly type: JobType
  readonly input: Uint8Array
  readonly signal: AbortSignal
  report(progress: number): void
}
