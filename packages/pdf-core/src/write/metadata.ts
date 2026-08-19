import * as mupdf from 'mupdf'

/**
 * The document description a reader shows in its properties panel.
 *
 * `producer` is deliberately absent: this build produced the file, so it
 * says so, and letting a user claim otherwise is a small lie the app would
 * be writing on their behalf.
 */
export type DocumentMetadata = {
  title: string
  author: string
  subject: string
  keywords: string
  creator: string
}

export const EMPTY_METADATA: DocumentMetadata = {
  title: '', author: '', subject: '', keywords: '', creator: '',
}

const INFO_KEYS: Array<[keyof DocumentMetadata, string]> = [
  ['title', 'info:Title'],
  ['author', 'info:Author'],
  ['subject', 'info:Subject'],
  ['keywords', 'info:Keywords'],
  ['creator', 'info:Creator'],
]

export function readMetadata(raw: mupdf.PDFDocument): DocumentMetadata {
  const out = { ...EMPTY_METADATA }
  for (const [field, key] of INFO_KEYS) {
    try {
      out[field] = raw.getMetaData(key) ?? ''
    } catch {
      // A document with no /Info at all; the empty default is correct.
    }
  }
  return out
}

/** XML text content, escaped. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * An XMP packet describing the same metadata as /Info.
 *
 * Hand-built because MuPDF neither creates nor updates one:
 * docs/findings/14-phase-6-preflight.md 4 measured that `setMetaData` leaves
 * /Metadata absent, while a hand-written packet survives a save and reopen
 * intact.
 */
export function buildXmp(meta: DocumentMetadata, modified: string): string {
  const alt = (value: string, tag: string): string =>
    value
      ? `<dc:${tag}><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(value)}</rdf:li></rdf:Alt></dc:${tag}>`
      : ''
  const seq = (value: string, tag: string): string =>
    value
      ? `<dc:${tag}><rdf:Seq><rdf:li>${xmlEscape(value)}</rdf:li></rdf:Seq></dc:${tag}>`
      : ''

  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   ${alt(meta.title, 'title')}
   ${seq(meta.author, 'creator')}
   ${alt(meta.subject, 'description')}
   ${meta.keywords ? `<dc:subject><rdf:Bag><rdf:li>${xmlEscape(meta.keywords)}</rdf:li></rdf:Bag></dc:subject>` : ''}
   ${meta.creator ? `<xmp:CreatorTool>${xmlEscape(meta.creator)}</xmp:CreatorTool>` : ''}
   <xmp:ModifyDate>${modified}</xmp:ModifyDate>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}

/**
 * Write the document's description to BOTH /Info and XMP.
 *
 * Both, always, and that is the point. Nothing keeps the two in sync --
 * MuPDF updates neither from the other -- so a file whose /Info says one
 * title and whose XMP says another is perfectly valid, and different
 * readers will believe different halves. Writing one and leaving the other
 * stale is exactly how a document comes to disagree with itself about who
 * wrote it.
 *
 * `modified` is passed in rather than read from the clock: replay must be a
 * pure function of its inputs, and a writer that stamped `new Date()` would
 * make two exports of the same document differ.
 */
export function writeMetadata(
  raw: mupdf.PDFDocument,
  meta: DocumentMetadata,
  modified: string,
): void {
  for (const [field, key] of INFO_KEYS) {
    raw.setMetaData(key, meta[field])
  }
  // Honest rather than configurable: this build produced the file.
  raw.setMetaData('info:Producer', 'get-margin')
  raw.setMetaData('info:ModDate', modified)

  const dict = raw.newDictionary()
  dict.put('Type', raw.newName('Metadata'))
  dict.put('Subtype', raw.newName('XML'))
  raw.getTrailer().get('Root').put('Metadata', raw.addStream(buildXmp(meta, modified), dict))
}

/**
 * Remove everything describing the document.
 *
 * /Info, the XMP packet, AND the file identifier. The last one matters:
 * /ID is a pair of hashes that follow a document across revisions, so
 * leaving it behind after stripping the rest lets two files be linked to
 * each other even with every name removed -- which is precisely what
 * someone stripping metadata is trying to prevent.
 */
export function stripMetadata(raw: mupdf.PDFDocument): void {
  for (const key of [
    'info:Title', 'info:Author', 'info:Subject', 'info:Keywords',
    'info:Creator', 'info:Producer', 'info:CreationDate', 'info:ModDate',
  ]) {
    try {
      raw.setMetaData(key, '')
    } catch {
      // Absent already.
    }
  }

  const trailer = raw.getTrailer()
  const root = trailer.get('Root')
  if (root.isDictionary() && !root.get('Metadata').isNull()) root.delete('Metadata')
  if (!trailer.get('Info').isNull()) trailer.delete('Info')
  if (!trailer.get('ID').isNull()) trailer.delete('ID')
}
