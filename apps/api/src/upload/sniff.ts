import type { JobType } from '@margin/shared'

/**
 * Whether these bytes are the format the job type needs.
 *
 * `ok: false` carries a reason shown to the user. It describes what we
 * looked at, never what we found in the file -- an error message is a log
 * line and a screenshot away from being the leak the whole phase is
 * trying to avoid.
 */
export type SniffResult = { ok: true } | { ok: false; reason: string }

/**
 * Binary formats we can name, so a wrong upload gets a useful refusal
 * rather than "not HTML".
 *
 * The list exists to IMPROVE the message, not to make the decision: the
 * accept rules below are allowlists, so a format missing from this table
 * is still rejected. An extension is never consulted -- `invoice.html`
 * containing a zip is a zip.
 */
const SIGNATURES: ReadonlyArray<{ bytes: readonly number[]; name: string }> = [
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], name: 'a PDF' }, // %PDF-
  { bytes: [0x50, 0x4b, 0x03, 0x04], name: 'a zip or Office document' },
  { bytes: [0x89, 0x50, 0x4e, 0x47], name: 'a PNG image' },
  { bytes: [0xff, 0xd8, 0xff], name: 'a JPEG image' },
  { bytes: [0x47, 0x49, 0x46, 0x38], name: 'a GIF image' },
  { bytes: [0xd0, 0xcf, 0x11, 0xe0], name: 'a legacy Office document' },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], name: 'an executable' },
  { bytes: [0x4d, 0x5a], name: 'an executable' },
  { bytes: [0x1f, 0x8b], name: 'a gzip archive' },
]

function signatureOf(bytes: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    if (bytes.length < sig.bytes.length) continue
    if (sig.bytes.every((b, i) => bytes[i] === b)) return sig.name
  }
  return null
}

/** How far in we look for a NUL or for the first markup character. */
const SNIFF_WINDOW = 4096

/**
 * HTML is the awkward case: it has no magic number.
 *
 * So the check is the closest honest equivalent -- the document must be
 * text (no NUL in the sniff window, which is how every browser and every
 * `file(1)` separates text from binary), must not open with a signature we
 * recognise as something else, and must begin with markup once a BOM and
 * leading whitespace are stepped over.
 *
 * Requiring a leading `<` is stricter than the HTML parser, which will
 * happily render a file of prose. That is deliberate. This input is fed to
 * a browser engine, and "starts with a tag" is a cheap, checkable property
 * that a file mislabelled by a confused user almost never has.
 */
function sniffHtml(bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) return { ok: false, reason: 'The file is empty.' }

  const named = signatureOf(bytes)
  if (named) return { ok: false, reason: `This looks like ${named}, not an HTML document.` }

  const window = bytes.subarray(0, SNIFF_WINDOW)
  if (window.includes(0x00)) {
    return { ok: false, reason: 'This looks like a binary file, not an HTML document.' }
  }

  let i = 0
  // UTF-8 BOM. UTF-16 is excluded already: its BOM is followed by NULs
  // for ASCII markup, so the check above has caught it.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3
  while (i < window.length && isSpace(window[i]!)) i++

  if (window[i] !== 0x3c /* < */) {
    return {
      ok: false,
      reason: 'An HTML file must begin with a tag, such as <!DOCTYPE html> or <html>.',
    }
  }
  return { ok: true }
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c
}

const SNIFFERS: Record<JobType, (bytes: Uint8Array) => SniffResult> = {
  'html-to-pdf': sniffHtml,
}

/**
 * Runs before a single byte is written to disk.
 *
 * Order matters more than the check does: validating after storing means a
 * flood of junk costs disk and a sweep, and means the rejected file
 * existed on our filesystem -- which the privacy page says it would not.
 */
export function sniff(type: JobType, bytes: Uint8Array): SniffResult {
  return SNIFFERS[type](bytes)
}
