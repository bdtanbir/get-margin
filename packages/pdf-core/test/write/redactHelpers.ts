import { readFileSync } from 'node:fs'
import { replay } from '../../src/write/index.js'
import {
  emptyEditDocument, type EditDocument, type EditObject, type RedactionObject,
} from '../../src/write/types.js'
import { fixturePath, type FixtureName } from '../fixtures/index.js'
import { PdfDocument } from '../../src/index.js'
import { buildQuadIndex } from '../../src/text/index.js'

/**
 * Shared by redact.test.ts and redact-independent.test.ts.
 *
 * A plain module rather than an export from one of them: importing helpers
 * ACROSS test files makes vitest collect the source file's suites too, so
 * every case in it runs twice and the counts stop meaning anything.
 */
export const bytes = (n: FixtureName): Uint8Array =>
  new Uint8Array(readFileSync(fixturePath(n)))

export function docWith(objects: EditObject[], pages = 1): EditDocument {
  return {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: Array.from({ length: pages }, (_, i) => `p${i}`),
    pages: Object.fromEntries(Array.from({ length: pages }, (_, i) => [
      `p${i}`, { sourceIndex: i, sourceId: 'src-0', rotation: 0, cropBox: null },
    ])),
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    nextZ: 99,
  }
}

export function charsOf(pdf: Uint8Array, page = 0) {
  const d = PdfDocument.open(pdf)
  try { return buildQuadIndex(d, page).lines.flatMap((l) => l.chars) } finally { d.close() }
}

export const textOf = (pdf: Uint8Array, page = 0): string =>
  charsOf(pdf, page).map((c) => c.char).join('')

/** A redaction covering `target` on `page` of `fixture`. */
export function redactionFor(
  fixture: FixtureName, page: number, pageId: string, target: string, blackBox = true,
): RedactionObject {
  const chars = charsOf(bytes(fixture), page)
  const text = chars.map((c) => c.char).join('')
  const at = text.indexOf(target)
  if (at === -1) throw new Error(`"${target}" is not on page ${page} of ${fixture}`)
  const quads = chars.slice(at, at + target.length).map((c) => c.quad as unknown as number[])
  return {
    id: `r-${target}`, pageId, kind: 'redaction', quads, blackBox,
    // A redaction has no meaningful rect of its own; the quads are the
    // geometry. This exists because BaseObject requires it, and the editor
    // draws its own chrome from the quads.
    rect: { x: 0, y: 0, w: 0, h: 0 },
    rotation: 0, z: 1, locked: false, opacity: 1,
  }
}

export const write = (objects: EditObject[], fixture: FixtureName = 'simple-text', pages = 1) =>
  replay(new Map([['src-0', bytes(fixture)]]), docWith(objects, pages))
