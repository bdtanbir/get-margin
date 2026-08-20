/**
 * Strip anything that could be a user's data out of an error message.
 *
 * The allowlist in `types.ts` is the real control; this is for the one
 * field that cannot be an allowlist. An error message is written by
 * whoever threw it, and this codebase already interpolates user input into
 * several of them -- `lib/pageRanges.ts` throws `"${text}" is not a page
 * range.` with whatever was typed, and a document's own font family and
 * page labels reach messages from `pdf-core`.
 *
 * So the rules below are deliberately blunt. A message that loses some
 * useful detail is a worse bug report; a message that carries
 * `2024-tax-return-jane-doe.pdf` is the failure this whole phase exists to
 * avoid. When those two conflict, the message loses.
 */

/** Applied in order. Earlier rules win, so specific patterns precede general ones. */
const RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // URLs first: they contain dots, slashes and tokens that later rules
  // would otherwise chew into an unreadable mess.
  { pattern: /\b(?:https?|blob|file|data):[^\s"')]+/gi, replacement: '[url]' },

  // Windows and POSIX paths. Two or more segments, so an ordinary sentence
  // containing a slash survives.
  { pattern: /\b[A-Za-z]:\\[^\s"')]+/g, replacement: '[path]' },
  { pattern: /(?:\/[\w.\-@ ]+){2,}\/?/g, replacement: '[path]' },

  // Anything with a file extension. The extension list is long on purpose:
  // it is the shape that matters, and a name is frequently the sensitive
  // thing on its own.
  {
    pattern:
      /\b[\w\-. ()]+\.(?:pdf|html?|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|json|xml|zip|gz|png|jpe?g|gif|webp|svg|tiff?|bmp|heic|eml|msg)\b/gi,
    replacement: '[file]',
  },

  // Quoted runs. `pageRanges.ts` puts the user's own typing in quotes, and
  // so will the next person who writes a validation message.
  { pattern: /"[^"]{1,200}"/g, replacement: '"[value]"' },
  { pattern: /“[^”]{1,200}”/g, replacement: '“[value]”' },
  { pattern: /'[^']{2,200}'/g, replacement: "'[value]'" },

  // Long unbroken runs: base64, hashes, ids, and the job ids that are
  // credentials in their own right.
  { pattern: /\b[A-Za-z0-9_\-+/=]{24,}\b/g, replacement: '[token]' },

  // Anything that looks like an address or a phone number. Neither belongs
  // in an error message, and both turn up in documents.
  { pattern: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, replacement: '[email]' },
]

/** Longer than this and it is prose or a payload, not a diagnosis. */
export const MAX_MESSAGE = 200

export function scrub(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return ''

  let out = input
  for (const { pattern, replacement } of RULES) out = out.replace(pattern, replacement)

  // Collapse whitespace so a multi-line message stays one field.
  out = out.replace(/\s+/g, ' ').trim()

  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out
}

/**
 * An error's type, with no stack and no message.
 *
 * A thrown value can be anything -- including a string built from the
 * document -- so only the constructor name is taken, and only when it is
 * a real Error.
 */
export function errorType(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error'
  return 'NonError'
}

/** The message, scrubbed. Non-Errors contribute nothing rather than being stringified. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? scrub(err.message) : ''
}

/**
 * Event and component names are validated, not scrubbed.
 *
 * Scrubbing them turned out to be actively wrong: `export.pdf` is a
 * perfectly good event name and the filename rule ate it, because a
 * lowercase word with a dot and an extension IS what a filename looks
 * like. There is no scrubber that can tell those apart.
 *
 * So these fields get the treatment the rest of the module already uses --
 * an allowlist. A name is a short identifier in a fixed shape, and colons
 * separate its parts rather than dots, specifically so that a value
 * containing a dot can be rejected outright. `2024-tax-return-jane-doe.pdf`
 * does not match either pattern and never will.
 */
const NAME = /^[a-z][a-z0-9]*(?:[:_-][a-z0-9]+)*$/
const COMPONENT = /^[A-Za-z][A-Za-z0-9]{0,40}$/

/** What is sent when a caller passes something that is not an identifier. */
export const REJECTED = 'invalid-name'

export function safeName(value: unknown): string {
  return typeof value === 'string' && value.length <= 48 && NAME.test(value) ? value : REJECTED
}

export function safeComponent(value: unknown): string {
  return typeof value === 'string' && COMPONENT.test(value) ? value : REJECTED
}
