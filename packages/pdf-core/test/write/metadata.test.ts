import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import { replay } from '../../src/write/index.js'
import { readMetadata, buildXmp, EMPTY_METADATA } from '../../src/write/metadata.js'
import { emptyEditDocument, type EditDocument } from '../../src/write/types.js'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const src = () => new Uint8Array(readFileSync(fixturePath('simple-text')))
const open = (b: Uint8Array) =>
  mupdf.PDFDocument.openDocument(b, 'application/pdf') as mupdf.PDFDocument

function doc(over: Partial<EditDocument> = {}): EditDocument {
  return {
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'],
    pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
    ...over,
  }
}

const META = {
  title: 'Quarterly Report',
  author: 'Ada Lovelace',
  subject: 'Numbers',
  keywords: 'finance, 2026',
  creator: 'get-margin',
}

const write = (over: Partial<EditDocument> = {}, modified = 'D:20260819120000Z') =>
  replay(new Map([['src-0', src()]]), doc(over), { modified })

function infoOf(pdf: Uint8Array) {
  const d = open(pdf)
  try { return readMetadata(d) } finally { d.destroy() }
}

function xmpOf(pdf: Uint8Array): string {
  const d = open(pdf)
  try {
    const meta = d.getTrailer().get('Root').get('Metadata')
    return meta.isStream() ? meta.readStream().asString() : ''
  } finally { d.destroy() }
}

describe('reading metadata', () => {
  it('reads what the source document carries', () => {
    // The fixture generator sets Creator and Producer.
    expect(infoOf(src()).creator).toBe('get-margin-fixtures')
  })

  it('reports empty rather than throwing for absent fields', () => {
    expect(infoOf(src()).title).toBe('')
  })
})

describe('writing metadata', () => {
  it('round-trips every field through /Info', () => {
    expect(infoOf(write({ metadata: META }))).toEqual(META)
  })

  /**
   * THE POINT. Nothing keeps /Info and XMP in sync -- MuPDF updates
   * neither from the other -- so a file whose /Info says one title and
   * whose XMP says another is valid, and different readers believe
   * different halves. Writing one and leaving the other stale is exactly
   * how a document comes to disagree with itself about who wrote it.
   */
  it('writes the SAME description to XMP', () => {
    const xmp = xmpOf(write({ metadata: META }))
    expect(xmp).toContain('Quarterly Report')
    expect(xmp).toContain('Ada Lovelace')
    expect(xmp).toContain('Numbers')
  })

  it('creates an XMP packet where the source had none', () => {
    expect(xmpOf(src())).toBe('')
    expect(xmpOf(write({ metadata: META }))).not.toBe('')
  })

  it('escapes XML rather than producing a broken packet', () => {
    const xmp = xmpOf(write({ metadata: { ...EMPTY_METADATA, title: 'Tom & Jerry <b>' } }))
    expect(xmp).toContain('Tom &amp; Jerry &lt;b&gt;')
    expect(xmp).not.toContain('<b>')
  })

  it('omits empty fields from the packet rather than writing blanks', () => {
    const xmp = xmpOf(write({ metadata: { ...EMPTY_METADATA, title: 'Only a title' } }))
    expect(xmp).toContain('Only a title')
    expect(xmp).not.toContain('<dc:creator>')
  })

  it('says get-margin produced the file', () => {
    const d = open(write({ metadata: META }))
    try { expect(d.getMetaData('info:Producer')).toBe('get-margin') } finally { d.destroy() }
  })

  it('stamps the supplied modification date, not the clock', () => {
    const out = write({ metadata: META }, 'D:20200101000000Z')
    const d = open(out)
    try { expect(d.getMetaData('info:ModDate')).toBe('D:20200101000000Z') } finally { d.destroy() }
    expect(xmpOf(out)).toContain('D:20200101000000Z')
  })

  /**
   * Replay must be a pure function of its inputs. A writer that stamped
   * `new Date()` would make two exports of one document differ, which is
   * the guarantee the whole write path is built around.
   */
  it('produces identical bytes for identical inputs', () => {
    const a = write({ metadata: META })
    const b = write({ metadata: META })
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('leaves the page content alone', () => {
    const out = write({ metadata: META })
    const d = open(out)
    const p = d.loadPage(0)
    try { expect(p.toStructuredText().asText()).toContain('Hello') } finally { p.destroy(); d.destroy() }
  })

  it('defeats the byte-identical pass-through', () => {
    expect(Buffer.from(write({ metadata: META })).equals(Buffer.from(src()))).toBe(false)
  })
})

describe('stripping metadata', () => {
  const stripped = () => write({ stripMetadata: true })

  it('removes what the source carried', () => {
    expect(infoOf(src()).creator).not.toBe('')
    expect(infoOf(stripped())).toEqual(EMPTY_METADATA)
  })

  it('removes the XMP packet too', () => {
    expect(xmpOf(write({ metadata: META, stripMetadata: true }))).toBe('')
  })

  /**
   * /ID is a pair of hashes that follow a document across revisions, so
   * leaving it behind after removing every name still lets two files be
   * linked to each other -- which is precisely what someone stripping
   * metadata is trying to prevent.
   */
  it('removes the file identifier, which would otherwise link revisions', () => {
    const d = open(stripped())
    try { expect(d.getTrailer().get('ID').isNull()).toBe(true) } finally { d.destroy() }
  })

  it('takes precedence over a description', () => {
    expect(infoOf(write({ metadata: META, stripMetadata: true })).title).toBe('')
  })

  it('leaves a readable document', () => {
    const d = open(stripped())
    const p = d.loadPage(0)
    try { expect(p.toStructuredText().asText()).toContain('Hello') } finally { p.destroy(); d.destroy() }
  })

  it('defeats the byte-identical pass-through', () => {
    expect(Buffer.from(stripped()).equals(Buffer.from(src()))).toBe(false)
  })
})

describe('buildXmp', () => {
  it('is a well-formed packet with the standard wrapper', () => {
    const xmp = buildXmp(META, 'D:20260819120000Z')
    expect(xmp).toContain('<?xpacket begin=')
    expect(xmp).toContain('<?xpacket end="w"?>')
    expect(xmp).toContain('x:xmpmeta')
    expect(xmp).toContain('rdf:RDF')
  })
})
