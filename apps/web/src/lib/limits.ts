/**
 * Client-side capacity limits (spec §4, §10 open question 3).
 *
 * These are soft caps enforced with a clear message rather than an OOM crash.
 * Revisit after measuring on a mid-range phone — the spec flags this as
 * unvalidated, and phone support is a committed requirement.
 */
export const MAX_BYTES = 150 * 1024 * 1024
export const MAX_PAGES = 800

/**
 * Total bytes of ALL open source files, across a merge.
 *
 * MAX_BYTES bounds one file; nothing bounded the sum, so merging five
 * large documents grew memory without limit. A merged file's bytes cannot
 * be freed while it is open -- adding one is an undoable op, so undo
 * removes its pages and redo brings them back, and dropping the bytes in
 * between would leave a redo that cannot render or export (Phase 3's
 * recorded limitation, unchanged). Refusing the merge that would cross the
 * line is the safe half of that problem, and the half worth having.
 */
export const MAX_TOTAL_SOURCE_BYTES = 300 * 1024 * 1024

export type SizeVerdict =
  | { ok: true }
  | {
      ok: false
      reason: 'too-large' | 'too-many-pages' | 'empty' | 'too-much-open'
      message: string
    }

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

/**
 * Whether another file can be merged in without crossing the total budget.
 * Named so the message can say what to do -- close something -- rather than
 * just refusing.
 */
export function checkTotalOpenSize(openBytes: number, incomingBytes: number): SizeVerdict {
  const total = openBytes + incomingBytes
  if (total > MAX_TOTAL_SOURCE_BYTES) {
    return {
      ok: false,
      reason: 'too-much-open',
      message:
        `Adding this file would put ${mb(total)} of PDFs in memory at once, over the ` +
        `${mb(MAX_TOTAL_SOURCE_BYTES)} limit. Export what you have and start again with the result.`,
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
