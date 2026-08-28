import type { EditObject, Op } from '@margin/pdf-core'

/** The two kinds that cover something and may carry a copy of it. */
function carriesACopy(o: EditObject): boolean {
  if (o.kind !== 'imagePatch' && o.kind !== 'regionPatch') return false
  return (o.data?.length ?? 0) > 0
}

/**
 * What Delete does to the selected object: it removes what that object is
 * CARRYING.
 *
 * For everything else that has always meant the object itself, and it
 * still does. A patch is the exception because of what it is made of: a
 * cover over the document's own content, plus — once the user has clicked
 * or dragged it — a copy of that content drawn on top.
 *
 * Deleting such an object outright takes the COVER with it, which puts the
 * document's own logo straight back where it was. On screen that reads as
 * the Delete button doing nothing at all: the user asked for the logo to
 * go and the logo is still there. It is the single most confusing outcome
 * available, because it looks identical to a bug.
 *
 * So Delete peels one layer at a time, and the rule is one sentence: take
 * the copy off if there is one, otherwise remove the edit. Pressed once on
 * a logo, the logo goes and the cover stays. Pressed again on what is left
 * — an edit carrying nothing — the edit goes and the page is back as it
 * was. Both steps are ordinary undoable ops, so Ctrl+Z walks back up.
 *
 * The offset goes with the copy. Leaving it behind would mean the same
 * area, brought back later, arrives already displaced by a drag with
 * nothing on screen to explain it.
 *
 * NOTE the deliberate difference from the layers list, which deletes a row
 * outright. There the user is looking at a list of EDITS and the row is
 * the edit; here they are looking at the page and the selection is the
 * thing on it. Same word, two honest referents.
 */
export function deleteOpFor(o: EditObject): Op {
  if (!carriesACopy(o)) return { type: 'deleteObject', id: o.id }
  return {
    type: 'updateObject',
    id: o.id,
    // Explicit `undefined` rather than omission: `applyOp` merges with
    // Object.assign, so a key that is absent from the patch is a key left
    // exactly as it was.
    patch: { data: undefined, mime: undefined, offset: undefined } as Partial<EditObject>,
  }
}
