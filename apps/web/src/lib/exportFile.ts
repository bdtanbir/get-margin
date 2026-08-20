/**
 * Hand a byte array to the browser as a file download.
 *
 * Deliberately synchronous and DOM-only: this must run inside the user
 * gesture that triggered it, or Safari blocks the download. Do not await
 * anything between the click handler and this call — await the bytes first,
 * then call this.
 */
export function downloadBytes(
  bytes: Uint8Array,
  fileName: string,
  mime = 'application/pdf',
): void {
  // `new Blob([bytes])` would keep a reference to the underlying ArrayBuffer;
  // copying into a fresh view keeps the blob independent of any typed array
  // the caller might still mutate.
  const blob = new Blob([bytes.slice()], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  // Never appended to the document: an unattached anchor still dispatches a
  // download on .click(), and not attaching it means no cleanup step can be
  // skipped and no stray node can survive an exception below.
  try {
    a.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** `report.docx` -> `report.pdf`; `report` -> `report.pdf`. */
export function pdfFileName(sourceName: string): string {
  const base = sourceName.replace(/\.[^./\\]+$/, '')
  return `${base || 'document'}.pdf`
}

/** MIME types for the things this app hands to the browser. */
export const MIME = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  png: 'image/png',
  zip: 'application/zip',
} as const

/**
 * `report.pdf`, page 3 -> `report-p3.jpg`.
 *
 * Padded to the width of the largest page number so a folder of exports
 * sorts correctly: `p01 … p10`, not `p1, p10, p2`.
 */
export function imageFileName(
  sourceName: string,
  pageNumber: number,
  format: 'jpeg' | 'png',
  totalPages = pageNumber,
): string {
  const base = sourceName.replace(/\.[^./\\]+$/, '') || 'document'
  const width = String(Math.max(1, totalPages)).length
  const ext = format === 'png' ? 'png' : 'jpg'
  return `${base}-p${String(pageNumber).padStart(width, '0')}.${ext}`
}
