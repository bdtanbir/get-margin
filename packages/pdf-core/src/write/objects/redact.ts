import * as mupdf from 'mupdf'
import type { EditDocument, RedactionObject } from '../types.js'
import { withPage } from '../session.js'

/**
 * Apply every redaction, as a PASS over the assembled export copy.
 *
 * Not an ObjectWriter, unlike every other kind. `applyRedactions` operates
 * on a whole page at once and permanently rewrites its content stream, so
 * running it per object would mean re-walking and re-encoding the page once
 * per redacted word. It also has to run AFTER the ordinary writers: a
 * redaction is meant to remove what the source document said, not what the
 * user drew on top of it a moment ago.
 *
 * WHY THIS IS SAFE TO CALL REDACTION. `PLAN.md` 2.4 makes independent
 * verification a release gate rather than a nice-to-have, because the
 * original evidence was MuPDF re-reading its own output. That gate is met:
 * docs/findings/14-phase-6-preflight.md 1 records eight cases -- a word, a
 * word mid-line, PART of a word, all four page rotations, and black boxes
 * off -- each checked with pypdf, pdfminer.six, and a raw byte search.
 * test/write/redact-independent.test.ts re-runs that check on every commit
 * rather than leaving it as a one-time result.
 *
 * Text only. `applyRedactions`'s image and line-art paths are unexercised
 * (2.4), and a redaction that silently fails to remove a face from a
 * photograph is precisely the failure this feature exists to prevent.
 */
export function applyRedactions(raw: mupdf.PDFDocument, editDoc: EditDocument): void {
  const byPage = new Map<string, RedactionObject[]>()
  for (const object of Object.values(editDoc.objects)) {
    if (object.kind !== 'redaction') continue
    const list = byPage.get(object.pageId)
    if (list) list.push(object)
    else byPage.set(object.pageId, [object])
  }
  if (byPage.size === 0) return

  editDoc.pageOrder.forEach((pageId, index) => {
    const redactions = byPage.get(pageId)
    if (!redactions || redactions.length === 0) return

    withPage(raw, index, (page) => {
      // One Redact annotation per object, then ONE applyRedactions call for
      // the page: the call is what rewrites the content stream, and doing
      // it once is both faster and the only way the annotations can be
      // considered together.
      for (const redaction of redactions) {
        const annot = page.createAnnotation('Redact')
        // QuadPoints-driven, not Rect-driven -- 2.4, and confirmed by the
        // pre-flight, which redacted part of a word this way.
        annot.setQuadPoints(redaction.quads as never)
        annot.update()
      }

      // `blackBoxes` decides whether a mark is drawn, NOT whether the text
      // is removed -- the pre-flight verified removal with it false. A
      // redaction that leaves no mark is the wrong kind of quiet, so the
      // default is true and "no mark" is an explicit choice.
      const blackBoxes = redactions.some((r) => r.blackBox)
      page.applyRedactions(blackBoxes)
    })
  })
}
