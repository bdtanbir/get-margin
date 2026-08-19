import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PdfService } from '../../src/workers/pdfService.js'
import { emptyEditDocument, type EditObject } from '@margin/pdf-core'
import { generateFixtures, fixturePath } from '../../../../packages/pdf-core/test/fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const FONTS = new Map([[
  'Inter', new Uint8Array(readFileSync(join(ROOT, 'apps/web/public/fonts/Inter.ttf'))),
]])

/** Exactly what StampDialog's watermark preset produces. */
const watermark = (): EditObject => ({
  id: 'V1StGXR8_Z', pageId: 'p0', kind: 'stamp', stampKind: 'watermark',
  text: 'CONFIDENTIAL',
  rect: { x: 108, y: 354, w: 396, h: 84 },
  rotation: 45, z: 1, locked: false, opacity: 0.25,
  fontFamily: 'Inter', fontSize: 60, color: [0.5, 0.5, 0.5], align: 'center',
  behind: true,
} as unknown as EditObject)

describe('exporting a watermark through the worker service', () => {
  it('produces a document rather than hanging', () => {
    const svc = new PdfService()
    svc.open(new Uint8Array(readFileSync(fixturePath('simple-text'))))
    const doc = {
      ...emptyEditDocument(),
      sources: { 'src-0': { hash: '', name: 'a.pdf' } },
      pageOrder: ['p0'],
      pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation: 0, cropBox: null } },
      objects: { [watermark().id]: watermark() },
    }
    const out = svc.save(doc, FONTS)
    expect(out.length).toBeGreaterThan(0)
  })
})
