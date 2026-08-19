/**
 * Hand a byte array to the browser as a file download.
 *
 * Deliberately synchronous and DOM-only: this must run inside the user
 * gesture that triggered it, or Safari blocks the download. Do not await
 * anything between the click handler and this call — await the bytes first,
 * then call this.
 */
export function downloadBytes(bytes: Uint8Array, fileName: string): void {
  // `new Blob([bytes])` would keep a reference to the underlying ArrayBuffer;
  // copying into a fresh view keeps the blob independent of any typed array
  // the caller might still mutate.
  const blob = new Blob([bytes.slice()], { type: 'application/pdf' })
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
