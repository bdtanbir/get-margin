import type { JobType } from '@margin/shared'

export type ConvertOptions = {
  /**
   * Wall clock, not CPU time.
   *
   * The parsers this interface is meant to host -- LibreOffice, Ghostscript
   * -- hang on malformed input reliably rather than rarely, and a hang uses
   * no CPU while holding a worker forever. Only a wall-clock bound catches
   * that, and it has to end in a killed process rather than a rejected
   * promise, or the hung thing is still there.
   */
  timeoutMs?: number
  /** Cancellation from the queue. A converter that can stop early should. */
  signal?: AbortSignal
  /** Progress, 0..1. Converters that cannot measure themselves never call it. */
  report?: (progress: number) => void
}

/**
 * One conversion.
 *
 * Bytes in, bytes out. No paths and no filename: a converter never learns
 * what the file was called, so there is nothing for it to log, echo into
 * an error message, or write into the output's metadata.
 */
export type Converter = {
  readonly type: JobType
  convert(input: Uint8Array, options?: ConvertOptions): Promise<Uint8Array>
}

/**
 * The converters this build actually has.
 *
 * A registry rather than a switch, and it is keyed by `JobType`, which is
 * the shared enum the API validates against. That is what keeps the UI
 * honest: a type only becomes offerable by being added to `JobType`, and
 * adding it there without adding a converter here is a lookup that returns
 * undefined at wiring time rather than a job that fails after the upload.
 *
 * `office` and `ocr` are ABSENT, not stubbed. See `PHASE-7-DESIGN.md` §0:
 * they need LibreOffice and Tesseract, neither of which could be run when
 * this was written, and a stub that throws at runtime is a feature that
 * appears in the UI, gets chosen, and fails after the file has been sent.
 */
export class ConverterRegistry {
  private readonly converters = new Map<JobType, Converter>()

  register(converter: Converter): this {
    this.converters.set(converter.type, converter)
    return this
  }

  get(type: JobType): Converter | undefined {
    return this.converters.get(type)
  }

  has(type: string): boolean {
    return this.converters.has(type as JobType)
  }

  types(): JobType[] {
    return [...this.converters.keys()]
  }
}

/** Thrown when a converter runs past its wall clock. */
export class ConversionTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`The conversion took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.`)
    this.name = 'ConversionTimeout'
  }
}
