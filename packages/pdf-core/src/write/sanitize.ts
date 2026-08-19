import type * as mupdf from 'mupdf'

/** What a document was carrying, so the UI can say what it removed. */
export type StrippedContent = {
  openAction: boolean
  documentJavaScript: boolean
  catalogActions: boolean
  /** Number of pages that carried an /AA additional-actions dictionary. */
  pageActions: number
  /**
   * Number of annotations whose action or additional-action dictionary was
   * removed. Link and widget annotations are where /Launch actually lives:
   * the catalog carries at most one OpenAction, but a page can carry a
   * hundred link hotspots, any of which can run a file.
   */
  annotationActions: number
}

export function nothingStripped(): StrippedContent {
  return {
    openAction: false,
    documentJavaScript: false,
    catalogActions: false,
    pageActions: 0,
    annotationActions: 0,
  }
}

export function anythingStripped(found: StrippedContent): boolean {
  return (
    found.openAction ||
    found.documentJavaScript ||
    found.catalogActions ||
    found.pageActions > 0 ||
    found.annotationActions > 0
  )
}

/**
 * Action types removed wherever they appear.
 *
 * A DENYLIST, not an allowlist, and that direction is deliberate: the app
 * writes its own /URI and /GoTo links (objects/link.ts), documents in the
 * wild are full of legitimate navigation, and an allowlist would quietly
 * destroy every hotspot in a table of contents the first time someone
 * exported a file. The set below is the execute / exfiltrate / read-local
 * group -- each one does something the user did not ask for when they
 * clicked what looked like a link.
 *
 * /GoToR and /Named stay. Opening another document is what a link is for;
 * /Named is page navigation and print. Neither runs anything.
 */
const FORBIDDEN_ACTIONS = new Set([
  'JavaScript',  // runs script
  'Launch',      // runs a file -- the vector PLAN.md names alongside /JS
  'SubmitForm',  // posts field values to a URL
  'ImportData',  // reads a local file into the document
  'Rendition',   // can carry a JavaScript payload of its own
  'GoToE',       // navigates into an embedded file
])

/**
 * Whether an action -- or anything further down its /Next chain -- is
 * forbidden.
 *
 * The chain matters. `/A << /S /URI /URI (https://example.com) /Next << /S
 * /Launch ... >> >>` reads as an ordinary link from its first dictionary
 * and runs a file from its second, so judging an action by its own /S
 * alone passes exactly the thing worth catching. /Next may be a single
 * action or an array of them.
 *
 * `seen` guards against a cyclic chain, which a hostile file can build and
 * a naive walk would hang on.
 */
function chainIsForbidden(action: mupdf.PDFObject, seen = new Set<number>()): boolean {
  if (!action.isDictionary()) return false
  const ref = action.asIndirect()
  if (ref) {
    if (seen.has(ref)) return false
    seen.add(ref)
  }

  const kind = action.get('S')
  if (kind.isName() && FORBIDDEN_ACTIONS.has(kind.asName())) return true

  const next = action.get('Next')
  if (next.isArray()) {
    let forbidden = false
    next.forEach((entry) => { if (chainIsForbidden(entry, seen)) forbidden = true })
    return forbidden
  }
  return chainIsForbidden(next, seen)
}

/**
 * Strip actions from one page's annotations, returning how many were
 * changed.
 *
 * Walks /Annots as raw objects rather than through loadAnnotation, because
 * the annotation API covers editable annotations and a form widget
 * carrying a keystroke script is not one -- reading the array directly
 * reaches every subtype.
 */
function stripAnnotationActions(pageObj: mupdf.PDFObject): number {
  const annots = pageObj.get('Annots')
  if (!annots.isArray()) return 0

  let changed = 0
  annots.forEach((annot) => {
    if (!annot.isDictionary()) return
    let touched = false

    // /AA on an annotation fires on focus, blur, keystroke, mouse-enter --
    // no click required, so there is nothing to remove selectively.
    if (!annot.get('AA').isNull()) {
      annot.delete('AA')
      touched = true
    }

    if (chainIsForbidden(annot.get('A'))) {
      // The WHOLE chain goes, not the offending link in it. Keeping the
      // benign prefix of an action that was built to reach a /Launch means
      // trusting the shape of a file written to deceive.
      annot.delete('A')
      touched = true
    }

    if (touched) changed++
  })
  return changed
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
      found.annotationActions += stripAnnotationActions(obj)
    } finally {
      page.destroy()
    }
  }

  return found
}
