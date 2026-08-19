import type * as mupdf from 'mupdf'

/** What a document was carrying, so the UI can say what it removed. */
export type StrippedContent = {
  openAction: boolean
  documentJavaScript: boolean
  catalogActions: boolean
  /** Number of pages that carried an /AA additional-actions dictionary. */
  pageActions: number
}

export function nothingStripped(): StrippedContent {
  return { openAction: false, documentJavaScript: false, catalogActions: false, pageActions: 0 }
}

export function anythingStripped(found: StrippedContent): boolean {
  return (
    found.openAction || found.documentJavaScript || found.catalogActions || found.pageActions > 0
  )
}

/**
 * Remove every scripted-action vector from an open document.
 *
 * WHY EXPORT AND NOT OPEN: MuPDF does not execute JavaScript while
 * rendering, so an opened file is not dangerous to this app. The risk is
 * the user editing a hostile PDF and passing it on, and the export path is
 * the one place every downloaded byte goes through.
 *
 * WHY THE BYTES ACTUALLY GO: deleting a key only unlinks the object; the
 * script text would remain in the file, recoverable by anyone reading it.
 * The caller saves with `garbage=compact` (SAVE_OPTIONS), which collects
 * the orphans -- measured in docs/findings/09-phase-4-preflight.md, and
 * asserted directly by sanitize.test.ts rather than assumed.
 *
 * COST, stated rather than hidden: a source document whose form fields
 * carry validation scripts loses them. That is the right default for a
 * consumer editor, and the return value exists so the UI can say it
 * happened rather than leaving the user to discover it.
 */
export function stripActiveContent(raw: mupdf.PDFDocument): StrippedContent {
  const found = nothingStripped()
  const root = raw.getTrailer().get('Root')
  if (!root.isDictionary()) return found

  if (!root.get('OpenAction').isNull()) {
    root.delete('OpenAction')
    found.openAction = true
  }

  if (!root.get('AA').isNull()) {
    root.delete('AA')
    found.catalogActions = true
  }

  const names = root.get('Names')
  if (names.isDictionary() && !names.get('JavaScript').isNull()) {
    names.delete('JavaScript')
    found.documentJavaScript = true
  }

  for (let i = 0; i < raw.countPages(); i++) {
    const page = raw.loadPage(i)
    try {
      const obj = page.getObject()
      if (!obj.get('AA').isNull()) {
        obj.delete('AA')
        found.pageActions++
      }
    } finally {
      page.destroy()
    }
  }

  return found
}
