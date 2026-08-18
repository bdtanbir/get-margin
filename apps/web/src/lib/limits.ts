/**
 * Client-side capacity limits (spec §4, §10 open question 3).
 *
 * These are soft caps enforced with a clear message rather than an OOM crash.
 * Revisit after measuring on a mid-range phone — the spec flags this as
 * unvalidated, and phone support is a committed requirement.
 */
export const MAX_BYTES = 150 * 1024 * 1024
export const MAX_PAGES = 800

export type SizeVerdict =
  | { ok: true }
  | { ok: false; reason: 'too-large' | 'too-many-pages' | 'empty'; message: string }

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

export function checkFileSize(bytes: number): SizeVerdict {
  if (bytes <= 0) {
    return { ok: false, reason: 'empty', message: 'That file is empty.' }
  }
  if (bytes > MAX_BYTES) {
    return {
      ok: false,
      reason: 'too-large',
      message: `That file is ${mb(bytes)}. The editor handles up to ${mb(MAX_BYTES)} in the browser.`,
    }
  }
  return { ok: true }
}

export function checkPageCount(pages: number): SizeVerdict {
  if (pages > MAX_PAGES) {
    return {
      ok: false,
      reason: 'too-many-pages',
      message: `That document has ${pages} pages. The editor handles up to ${MAX_PAGES}.`,
    }
  }
  return { ok: true }
}
