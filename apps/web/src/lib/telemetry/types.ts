/**
 * Everything this app is allowed to send about itself.
 *
 * This type IS the policy, the same way `JobLogFields` is the policy for
 * the API's logger. `PLAN.md` §4 promises no analytics on documents, and an
 * error reporter is the easiest way to break that by accident: stack
 * traces carry paths, error messages interpolate user input, and a
 * free-form "context" object is where a filename ends up every single
 * time.
 *
 * So there is no context object, no stack, no document identifier, and no
 * file size. Anything not in these shapes cannot be sent, because there is
 * nowhere to put it.
 */

/** Bumped when a field's meaning changes, so a receiver can reject what it cannot read. */
export const TELEMETRY_SCHEMA = 1

export type ErrorEvent = {
  schema: typeof TELEMETRY_SCHEMA
  kind: 'error'
  /** A stable identifier chosen by the caller: `export-failed`, not a sentence. */
  name: string
  /** Which part of the app, named as the code names it: `CompressDialog`. */
  component: string
  /** The error's constructor name -- `PdfOpenError`, `TypeError`. Never the stack. */
  errorType: string
  /** `Error.message`, after `scrub`. Never the raw value. */
  message: string
}

export type UsageEvent = {
  schema: typeof TELEMETRY_SCHEMA
  kind: 'usage'
  /** A feature name from a closed set the code chooses: `export.pdf`, `redact`. */
  name: string
  /** How many times, since the last send. A count cannot carry a document. */
  count: number
}

export type TelemetryEvent = ErrorEvent | UsageEvent

/**
 * Where events go, if anywhere.
 *
 * An interface rather than a `fetch` call so the destination is a
 * deployment decision and the tests can read exactly what would have been
 * transmitted -- which is what makes "the filename never appears in the
 * payload" an assertion about bytes rather than about intent.
 */
export type Transport = (events: TelemetryEvent[]) => Promise<void>
