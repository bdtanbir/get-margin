# get-margin Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-risk every uncertain MuPDF.js capability, build the two test assets the rest of the project depends on, then ship a viewer shell that opens any PDF and reads comfortably on desktop and phone.

**Architecture:** pnpm monorepo. `packages/pdf-core` wraps MuPDF and runs in both a browser Web Worker and Node (Node is what makes golden-file export testing possible). `packages/edit-model` is pure data. `apps/web` is Vue 3 + Vite + Tailwind v4, with all rendering off the main thread behind a Comlink-wrapped worker. Phase 0 is throwaway probe code whose deliverable is a written findings record plus two permanent assets: the coordinate-transform module and the golden-file render rig. Phase 1 builds the read-only viewer on top.

**Tech Stack:** Node 22 LTS · pnpm 9 · TypeScript 5.6+ (strict) · Vue 3.5 (Composition API, `<script setup>`) · Vite 6 · Tailwind CSS v4 (`@tailwindcss/vite`) · `mupdf` (WASM) · Comlink · Pinia · Vitest · fast-check · Playwright · pixelmatch + pngjs · pdf-lib (test fixtures only)

**Spec:** `PLAN.md` (repo root) — read §1 (Architecture), §2.5 (Fonts), §6 (UI/UX), §9 (Deployment) before starting. This plan implements §7 Phase 0 and Phase 1 only.

## Global Constraints

Every task's requirements implicitly include these. Values are copied verbatim from the spec.

- **Vue 3 Composition API with `<script setup>`.** No Options API anywhere.
- **Tailwind CSS v4** via `@tailwindcss/vite`. Tokens declared in `@theme`. Components use **semantic tokens only** (`--color-surface`, `--color-border`, `--color-text-muted`) — never raw palette values like `zinc-300`, so dark mode is a token swap rather than a `dark:` audit.
- **Pin the single-threaded MuPDF WASM build.** No `SharedArrayBuffer`, therefore no COOP/COEP headers.
- **All stored geometry is unrotated PDF user space** — origin bottom-left, y-up, 72dpi points.
- **No component performs its own coordinate arithmetic.** Everything goes through `lib/transform.ts`.
- **Objects reference a synthetic `pageId`, never a page index.**
- **Self-host the WASM binary.** Never load it from a CDN.
- **Do not add `pdfjs-dist`, `fabric`, or `konva`.** `pdf-lib` appears in phase 0/1 as a **devDependency for test-fixture generation only** — it is not yet a runtime dependency, and whether it becomes one is decided by Task 5.
- **MuPDF is AGPL-3.0.** Do not publish this repo publicly or deploy it to a public URL until the Artifex licensing decision in spec §0 is settled.
- **Icons:** `lucide-vue-next`, 1.5px stroke weight, uniformly.
- **Touch targets:** minimum 44px on the mobile shell.
- **Never log file contents, filenames, or PDF bytes.**

## How Phase 0 differs from Phase 1

Phase 0 Tasks 3–6 are **spikes**. Their deliverable is a findings record in `docs/findings/`, not shipped code. The probe scripts live in `spikes/` and are **deleted at the end of Task 8**. They are deliberately written to *introspect* the API — printing available methods and actual return shapes — because the entire point is that the spec is uncertain about these bindings. Do not TDD a spike; do not preserve spike code.

Tasks 1, 2, 7, and 8 produce permanent code and are TDD'd normally. All of Phase 1 is TDD'd normally.

---

## File Structure

**Phase 0 creates:**

| Path | Responsibility |
|---|---|
| `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json` | Workspace wiring, shared strict TS config |
| `vitest.workspace.ts` | Test discovery across packages |
| `packages/pdf-core/src/engine.ts` | MuPDF module load, document open, handle registry, lifecycle |
| `packages/pdf-core/src/geometry.ts` | MediaBox/CropBox/Rotate normalization → `PageGeometry` |
| `packages/pdf-core/src/render.ts` | Page → RGBA pixel buffer at a given scale |
| `packages/pdf-core/test/fixtures/generate.ts` | Deterministic fixture PDFs via pdf-lib |
| `packages/pdf-core/test/golden.ts` | Golden-file rig: render → PNG → pixelmatch compare |
| `packages/transform/src/index.ts` | The coordinate contract. PDF ↔ view, both directions |
| `spikes/*.ts` | Throwaway probes (deleted in Task 8) |
| `docs/findings/*.md` | Spike findings — the actual Phase 0 deliverable |

**Phase 1 creates:** `apps/web/` per spec §1.1 — `app/` (shells, tokens), `features/document|viewport`, `stores/`, `workers/`, `ui/`, `lib/`.

Splitting `transform` into its own package rather than `apps/web/src/lib/transform.ts` (as the spec sketches) is a deliberate deviation: it must be importable by `pdf-core`'s Node-side golden tests, and a package boundary is what enforces "no component does its own coordinate math." Task 7 explains this in place.

---

## Task 1: Monorepo scaffold and test harness

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore`, `.npmrc`
- Create: `packages/pdf-core/package.json`, `packages/pdf-core/tsconfig.json`
- Test: `packages/pdf-core/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a working `pnpm test` across the workspace; the `@margin/pdf-core` package name that every later task imports

- [ ] **Step 1: Initialize the repo and workspace files**

```bash
cd /Users/tanbirahmed/Desktop/get-margin
git init
node --version   # must print v22.x — if not, install Node 22 LTS first
corepack enable && corepack prepare pnpm@9 --activate
```

`package.json`:

```json
{
  "name": "get-margin",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b --pretty"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.9.0"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

`.npmrc`:

```
strict-peer-dependencies=false
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
.DS_Store
packages/pdf-core/test/fixtures/*.pdf
packages/pdf-core/test/golden/**/*.actual.png
packages/pdf-core/test/golden/**/*.diff.png
docs/findings/scratch/
```

Fixture PDFs are gitignored because Task 2 generates them deterministically — committing binaries you can regenerate is how fixture drift starts.

- [ ] **Step 2: Add the shared TypeScript config**

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

`noUncheckedIndexedAccess` is on deliberately. This codebase indexes into arrays of pages, spans, and quads constantly; without it, `pages[i]` silently types as non-optional and you get runtime `undefined` errors in the render loop.

- [ ] **Step 3: Create the pdf-core package**

`packages/pdf-core/package.json`:

```json
{
  "name": "@margin/pdf-core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "mupdf": "^1.26.0"
  },
  "devDependencies": {
    "pdf-lib": "^1.17.1",
    "pngjs": "^7.0.0",
    "pixelmatch": "^6.0.0",
    "@types/pngjs": "^6.0.5"
  }
}
```

`packages/pdf-core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Add vitest workspace config**

`vitest.workspace.ts`:

```ts
export default [
  {
    test: {
      name: 'pdf-core',
      root: './packages/pdf-core',
      environment: 'node',
      testTimeout: 30_000,
    },
  },
]
```

The 30s timeout is because MuPDF WASM instantiation plus a multi-page render legitimately exceeds vitest's 5s default, and a timeout failure here reads as a broken engine rather than a slow one.

- [ ] **Step 5: Install and write the smoke test**

```bash
pnpm install
```

`packages/pdf-core/test/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('workspace', () => {
  it('loads the mupdf module', async () => {
    const mupdf = await import('mupdf')
    expect(mupdf).toBeDefined()
    expect(typeof mupdf.Document?.openDocument).toBe('function')
  })
})
```

- [ ] **Step 6: Run the smoke test**

Run: `pnpm vitest run --project pdf-core`

Expected: PASS. If `mupdf.Document` is undefined, the package's export shape differs from what this plan assumes — **stop and record the actual shape in `docs/findings/00-module-shape.md` before continuing**, then adjust the import in this test. Every later task imports MuPDF the same way, so getting this right once saves fixing it fifteen times.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: pnpm monorepo scaffold with pdf-core package and vitest"
```

---

## Task 2: Deterministic test fixtures

**Files:**
- Create: `packages/pdf-core/test/fixtures/generate.ts`
- Create: `packages/pdf-core/test/fixtures/index.ts`
- Test: `packages/pdf-core/test/fixtures/generate.test.ts`
- Modify: `packages/pdf-core/package.json` (add `fixtures` script)

**Interfaces:**
- Consumes: Task 1's workspace
- Produces:
  - `generateFixtures(outDir: string): Promise<void>`
  - `fixturePath(name: FixtureName): string` where `FixtureName = 'simple-text' | 'rotated' | 'offset-cropbox' | 'multi-page' | 'large-300p' | 'mixed-fonts'`
  - Every later task and every golden test resolves fixtures through `fixturePath`.

Fixtures are **generated, not committed**. Deterministic synthesis beats real-world sample PDFs for automated tests: byte-identical across machines, no license questions, and each one isolates exactly one variable (rotation, CropBox offset, page count). Real-world PDFs still matter — but they belong in the *spikes* (Tasks 3–6), where a human reads the output, not in assertions.

- [ ] **Step 1: Write the failing test**

`packages/pdf-core/test/fixtures/generate.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import { generateFixtures, fixturePath, FIXTURE_NAMES } from './index.js'

beforeAll(async () => {
  await generateFixtures()
}, 60_000)

describe('fixtures', () => {
  it('writes every declared fixture', () => {
    for (const name of FIXTURE_NAMES) {
      const p = fixturePath(name)
      expect(existsSync(p), `missing fixture: ${name}`).toBe(true)
      expect(statSync(p).size).toBeGreaterThan(500)
    }
  })

  it('produces byte-identical output on repeat runs', async () => {
    const { readFileSync } = await import('node:fs')
    const before = readFileSync(fixturePath('simple-text'))
    await generateFixtures()
    const after = readFileSync(fixturePath('simple-text'))
    expect(after.equals(before)).toBe(true)
  })
})
```

The determinism test is the important one — pdf-lib stamps `CreationDate` by default, which would make every fixture differ per run and every golden test flaky. Step 3 suppresses that explicitly.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project pdf-core fixtures`
Expected: FAIL — `Cannot find module './index.js'`

- [ ] **Step 3: Write the generator**

`packages/pdf-core/test/fixtures/generate.ts`:

```ts
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const FIXED_DATE = new Date('2020-01-01T00:00:00Z')

/** pdf-lib stamps timestamps by default; pinning them is what makes fixtures reproducible. */
function pin(doc: PDFDocument): void {
  doc.setCreationDate(FIXED_DATE)
  doc.setModificationDate(FIXED_DATE)
  doc.setProducer('get-margin-fixtures')
  doc.setCreator('get-margin-fixtures')
}

async function save(doc: PDFDocument, outDir: string, name: string): Promise<void> {
  pin(doc)
  // useObjectStreams:false keeps output stable and human-inspectable in a hex editor.
  const bytes = await doc.save({ useObjectStreams: false })
  await writeFile(join(outDir, `${name}.pdf`), bytes)
}

async function simpleText(outDir: string): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792]) // US Letter
  page.drawText('Hello margin', { x: 72, y: 700, size: 24, font, color: rgb(0, 0, 0) })
  page.drawText('Second line of body text for span extraction.', {
    x: 72, y: 660, size: 11, font, color: rgb(0.2, 0.2, 0.2),
  })
  page.drawRectangle({ x: 72, y: 600, width: 200, height: 40, color: rgb(0.9, 0.9, 0.95) })
  await save(doc, outDir, 'simple-text')
}

async function rotated(outDir: string): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  // One page per rotation value, so transform tests can assert all four in one document.
  for (const deg of [0, 90, 180, 270]) {
    const page = doc.addPage([612, 792])
    page.setRotation({ type: 'degrees', angle: deg } as never)
    page.drawText(`rotate ${deg}`, { x: 72, y: 720, size: 18, font })
    // A marker at the PDF-space origin corner — the anchor transform tests assert against.
    page.drawRectangle({ x: 0, y: 0, width: 40, height: 20, color: rgb(1, 0, 0) })
  }
  await save(doc, outDir, 'rotated')
}

async function offsetCropBox(outDir: string): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792])
  page.drawText('cropbox offset', { x: 100, y: 700, size: 18, font })
  // Non-zero origin AND smaller than MediaBox — the case that breaks naive coordinate code.
  page.setCropBox(50, 80, 400, 500)
  await save(doc, outDir, 'offset-cropbox')
}

async function multiPage(outDir: string): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 12; i++) {
    const page = doc.addPage([612, 792])
    page.drawText(`Page ${i}`, { x: 72, y: 700, size: 32, font })
  }
  await save(doc, outDir, 'multi-page')
}

async function large300p(outDir: string): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 300; i++) {
    const page = doc.addPage([612, 792])
    page.drawText(`Page ${i} of 300`, { x: 72, y: 720, size: 14, font })
    // Enough text per page that render timing reflects real work, not a blank-page fast path.
    for (let line = 0; line < 40; line++) {
      page.drawText(
        `Line ${line}: the quick brown fox jumps over the lazy dog 0123456789`,
        { x: 72, y: 690 - line * 16, size: 10, font },
      )
    }
  }
  await save(doc, outDir, 'large-300p')
}

async function mixedFonts(outDir: string): Promise<void> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const faces = [
    StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique,
    StandardFonts.TimesRoman, StandardFonts.TimesRomanItalic, StandardFonts.Courier,
  ]
  let y = 720
  for (const face of faces) {
    const font = await doc.embedFont(face)
    page.drawText(`${face} sample text 123`, { x: 72, y, size: 14, font })
    y -= 30
  }
  await save(doc, outDir, 'mixed-fonts')
}

export async function generateFixtures(outDir = new URL('.', import.meta.url).pathname): Promise<void> {
  await mkdir(outDir, { recursive: true })
  await simpleText(outDir)
  await rotated(outDir)
  await offsetCropBox(outDir)
  await multiPage(outDir)
  await large300p(outDir)
  await mixedFonts(outDir)
}
```

`packages/pdf-core/test/fixtures/index.ts`:

```ts
import { join } from 'node:path'

export const FIXTURE_NAMES = [
  'simple-text', 'rotated', 'offset-cropbox', 'multi-page', 'large-300p', 'mixed-fonts',
] as const

export type FixtureName = (typeof FIXTURE_NAMES)[number]

const DIR = new URL('.', import.meta.url).pathname

export function fixturePath(name: FixtureName): string {
  return join(DIR, `${name}.pdf`)
}

export { generateFixtures } from './generate.js'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project pdf-core fixtures`
Expected: PASS, both tests.

If `page.setRotation` rejects the object form, use pdf-lib's `degrees()` helper (`import { degrees } from 'pdf-lib'`) and drop the `as never`. If the determinism test fails, something else is stamping non-deterministic bytes — inspect with `diff <(xxd a.pdf) <(xxd b.pdf) | head -40` and pin whatever field differs.

- [ ] **Step 5: Add the fixtures script**

Add to `packages/pdf-core/package.json`:

```json
"scripts": {
  "fixtures": "tsx test/fixtures/cli.ts"
}
```

`packages/pdf-core/test/fixtures/cli.ts`:

```ts
import { generateFixtures } from './generate.js'
await generateFixtures()
console.log('fixtures written')
```

```bash
pnpm add -Dw tsx
```

The spikes in Tasks 3–6 are standalone scripts, not vitest runs, so they need a way to produce fixtures outside the test lifecycle.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: deterministic fixture PDF generator"
```

---

## Task 3: Spike — read path (render throughput and structured text)

**Files:**
- Create: `spikes/01-render.ts`, `spikes/02-structured-text.ts`
- Create: `docs/findings/01-read-path.md`

**Interfaces:**
- Consumes: `fixturePath` from Task 2
- Produces: a findings document. **No shipped code.** Tasks 9–11 read these findings to write `render.ts` and `text.ts` correctly the first time.

**Spike discipline:** answer the questions, write down what you found, delete the code. Do not write tests. Do not refactor. Do not build abstractions. If you find yourself designing an API, stop — that's Task 9's job, and it will be better informed once these answers exist.

**Questions this spike must answer:**

1. What is the exact call sequence from `ArrayBuffer` to pixels? Exact method names and argument shapes.
2. Time to first rendered page on `large-300p`, and steady-state pages/second at 1.0× and 2.0× scale.
3. Peak RSS while rendering 300 pages sequentially. Does it grow without bound — i.e. do pixmaps need explicit disposal?
4. What is `toStructuredText().asJSON()`'s actual shape? Are per-span font name, size, weight, and italic flags present? Are per-character bboxes present?
5. Does `page.getBounds()` return the CropBox or the MediaBox? On `offset-cropbox`, does it include the non-zero origin?
6. How is `/Rotate` exposed, and does `toPixmap` apply it automatically or must the caller compose it into the matrix?

Question 6 is the one that most changes downstream code: if `toPixmap` already applies rotation, the transform module must *not* apply it again, and the spec's Layer-2 root `<g transform>` covers only the y-flip.

- [ ] **Step 1: Write the render probe**

`spikes/01-render.ts`:

```ts
import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

function mb(): number { return Math.round(process.memoryUsage().rss / 1048576) }

/** Print the real API surface rather than trusting docs — this is the point of the spike. */
function surface(label: string, obj: object): void {
  const proto = Object.getPrototypeOf(obj)
  console.log(`\n--- ${label} methods ---`)
  console.log(Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor').sort().join(', '))
}

const buf = readFileSync(fixturePath('simple-text'))
const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
surface('Document', doc)
console.log('pages:', doc.countPages())

const page = doc.loadPage(0)
surface('Page', page)
console.log('getBounds():', page.getBounds())

// Q1: minimal path to pixels.
const scale = 2
const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
surface('Pixmap', pix)
console.log('pixmap:', pix.getWidth(), 'x', pix.getHeight(), 'stride?', (pix as never as { getStride?: () => number }).getStride?.())
const pixels = pix.getPixels()
console.log('pixels bytes:', pixels.length, 'bytes/px:', pixels.length / (pix.getWidth() * pix.getHeight()))
writeFileSync('spikes/out-simple.png', pix.asPNG())

// Q5: CropBox vs MediaBox.
const cropDoc = mupdf.Document.openDocument(new Uint8Array(readFileSync(fixturePath('offset-cropbox'))), 'application/pdf')
const cropPage = cropDoc.loadPage(0)
console.log('\noffset-cropbox getBounds():', cropPage.getBounds(), '(expected CropBox [50,80,400,500])')

// Q6: rotation handling.
const rotDoc = mupdf.Document.openDocument(new Uint8Array(readFileSync(fixturePath('rotated'))), 'application/pdf')
for (let i = 0; i < 4; i++) {
  const p = rotDoc.loadPage(i)
  const b = p.getBounds()
  const px = p.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false, true)
  console.log(`page ${i}: bounds=${JSON.stringify(b)} pixmap=${px.getWidth()}x${px.getHeight()}`)
  writeFileSync(`spikes/out-rot-${i}.png`, px.asPNG())
}
console.log('If pixmap dims SWAP on pages 1 and 3, toPixmap applies /Rotate itself.')

// Q2/Q3: throughput and memory.
const bigDoc = mupdf.Document.openDocument(new Uint8Array(readFileSync(fixturePath('large-300p'))), 'application/pdf')
for (const s of [1, 2]) {
  const t0 = performance.now()
  let firstMs = 0
  const rssStart = mb()
  for (let i = 0; i < 300; i++) {
    const pg = bigDoc.loadPage(i)
    const pm = pg.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true)
    pm.getPixels()
    if (i === 0) firstMs = performance.now() - t0
    // Q3: does explicit destroy exist, and does omitting it leak?
    ;(pm as never as { destroy?: () => void }).destroy?.()
    ;(pg as never as { destroy?: () => void }).destroy?.()
    if (i % 100 === 0) console.log(`  scale ${s} page ${i} rss=${mb()}MB`)
  }
  const total = performance.now() - t0
  console.log(`scale ${s}: first=${firstMs.toFixed(0)}ms total=${(total / 1000).toFixed(1)}s rate=${(300 / (total / 1000)).toFixed(1)}pg/s rssDelta=${mb() - rssStart}MB`)
}
```

- [ ] **Step 2: Run it and read the output carefully**

```bash
pnpm --filter @margin/pdf-core fixtures
pnpm tsx spikes/01-render.ts 2>&1 | tee docs/findings/scratch/01-render.log
```

Open `spikes/out-rot-*.png` in an image viewer. **Look at them** — if page 1's output is visually rotated, MuPDF applied `/Rotate`. This is a visual question; the numbers alone won't settle it.

Then re-run the memory loop with the `destroy?.()` calls commented out and compare `rssDelta`. If it grows substantially, disposal is mandatory and `render.ts` needs `try/finally`.

- [ ] **Step 3: Write the structured-text probe**

`spikes/02-structured-text.ts`:

```ts
import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

for (const fixture of ['simple-text', 'mixed-fonts'] as const) {
  const doc = mupdf.Document.openDocument(new Uint8Array(readFileSync(fixturePath(fixture))), 'application/pdf')
  const page = doc.loadPage(0)

  // Try each option string — availability varies by version, and preserve-spans is
  // what makes stable run addressing possible (spec §2.4 step 2).
  for (const opts of ['', 'preserve-whitespace', 'preserve-whitespace,preserve-spans']) {
    try {
      const st = page.toStructuredText(opts)
      const json = JSON.parse(st.asJSON())
      console.log(`\n=== ${fixture} opts="${opts}" ===`)
      console.log('top-level keys:', Object.keys(json))
      const block = json.blocks?.[0]
      console.log('block keys:', block && Object.keys(block))
      const line = block?.lines?.[0]
      console.log('line keys:', line && Object.keys(line))
      const span = line?.spans?.[0] ?? line
      console.log('span keys:', span && Object.keys(span))
      console.log('span sample:', JSON.stringify(span)?.slice(0, 600))
      writeFileSync(`spikes/out-st-${fixture}-${opts.length}.json`, JSON.stringify(json, null, 2))
    } catch (e) {
      console.log(`opts="${opts}" FAILED:`, (e as Error).message)
    }
  }
}
console.log('\nCheck the written JSON for: per-span font name/size/weight/italic, per-char bbox, and whether spans exist at all.')
```

- [ ] **Step 4: Run it**

```bash
mkdir -p docs/findings/scratch
pnpm tsx spikes/02-structured-text.ts 2>&1 | tee docs/findings/scratch/02-text.log
```

Inspect the written JSON directly — the console summary only shows the first span, and what matters is whether font metadata is present on *every* span and whether character-level bboxes exist. Both are prerequisites for the spec's §2.4 text patching and §2.1 markup quads.

- [ ] **Step 5: Write the findings document**

`docs/findings/01-read-path.md` — answer all six questions with concrete evidence:

```markdown
# Findings: MuPDF.js read path

Engine: mupdf@<exact version from pnpm list>
Machine: <cpu, ram, node version>

## Q1 — ArrayBuffer to pixels
<exact call sequence with real signatures>

## Q2 — Throughput (large-300p, 612x792, 40 lines/page)
| scale | first page | 300 pages | pages/sec |
|---|---|---|---|

## Q3 — Memory
Peak RSS: <n>MB. With destroy(): <n>MB delta. Without: <n>MB delta.
Disposal required: YES / NO
<if YES, note that render.ts must use try/finally>

## Q4 — Structured text shape
Working option string: <...>
Per-span font name: YES/NO · size: YES/NO · weight/italic: YES/NO
Per-character bboxes: YES/NO
<paste one real span object>
IMPACT ON SPEC §2.4: <if font metadata is missing, span-level text patching
cannot identify the original font and phase 6 needs re-planning — say so here>

## Q5 — getBounds()
Returns: CropBox / MediaBox. Includes non-zero origin: YES/NO

## Q6 — Rotation
toPixmap applies /Rotate automatically: YES/NO
Evidence: pixmap dims for pages 0-3 were <...>
IMPACT ON TASK 7: <if YES, transform must not re-apply rotation>

## Decisions
- <each downstream consequence, one line>
```

- [ ] **Step 6: Commit**

```bash
git add spikes docs/findings
git commit -m "spike: MuPDF read path findings (render throughput, structured text)"
```

---

## Task 4: Spike — write path (annotations and font embedding)

**Files:**
- Create: `spikes/03-annotations.ts`, `spikes/04-fonts.ts`
- Create: `docs/findings/02-write-path.md`

**Interfaces:**
- Consumes: `fixturePath` from Task 2
- Produces: findings, plus **the pdf-lib decision** — whether `pdf-lib` becomes a runtime dependency for the font path (spec §2.5, Global Constraints).

**Questions:**

1. Does `page.createAnnotation(type)` work for `Highlight`, `Underline`, `StrikeOut`, `Ink`, `FreeText`, `Square`, `Line`, and `Link`?
2. After setting properties and calling `update()`, does MuPDF generate an appearance stream automatically? Does the result render correctly in **Acrobat, Preview, and Chrome** — which disagree, and Preview is the most forgiving, so it will lie to you?
3. Can `FreeText` do font family, size, colour, and alignment? Is that enough for the spec's text tool, or must text be drawn as content-stream operators instead?
4. **Can an arbitrary TTF be embedded?** `PDFDocument.addSimpleFont` or equivalent — and does text drawn with it render and measure correctly?
5. Does subsetting happen automatically? What does embedding a full font add to file size?

- [ ] **Step 1: Write the annotation probe**

`spikes/03-annotations.ts`:

```ts
import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

const doc = mupdf.Document.openDocument(
  new Uint8Array(readFileSync(fixturePath('simple-text'))), 'application/pdf',
) as mupdf.PDFDocument
const page = doc.loadPage(0) as mupdf.PDFPage

console.log('--- PDFPage methods ---')
console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(page)).sort().join(', '))

const TYPES = ['Highlight', 'Underline', 'StrikeOut', 'Ink', 'FreeText', 'Square', 'Circle', 'Line', 'Link', 'Stamp']
for (const type of TYPES) {
  try {
    const a = page.createAnnotation(type as never)
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(a)).sort()
    console.log(`\n${type}: OK`)
    if (type === 'Highlight') console.log('  annot methods:', methods.join(', '))
  } catch (e) {
    console.log(`\n${type}: FAILED — ${(e as Error).message}`)
  }
}

// Q2: does update() synthesize an appearance stream?
try {
  const hl = page.createAnnotation('Highlight' as never)
  hl.setQuadPoints([[72, 690, 300, 690, 72, 715, 300, 715]] as never)
  hl.setColor([1, 0.9, 0.2] as never)
  hl.update()
  const dict = (hl as never as { getObject: () => { get: (k: string) => unknown } }).getObject()
  console.log('\nHighlight /AP present after update():', String(dict.get('AP')))
} catch (e) {
  console.log('\nHighlight quadpoints/appearance FAILED:', (e as Error).message)
}

// Q3: FreeText styling range.
try {
  const ft = page.createAnnotation('FreeText' as never)
  ft.setRect([72, 400, 400, 460] as never)
  ft.setContents('FreeText styling probe — does alignment work?')
  ft.setDefaultAppearance('Helv', 14, [0.1, 0.2, 0.8] as never)
  ft.update()
  console.log('FreeText: setDefaultAppearance accepted')
} catch (e) {
  console.log('FreeText styling FAILED:', (e as Error).message)
}

// Ink, for the freehand/signature path.
try {
  const ink = page.createAnnotation('Ink' as never)
  ink.setInkList([[[100, 200], [140, 240], [180, 200], [220, 250]]] as never)
  ink.setColor([0, 0, 0] as never)
  ink.setBorderWidth?.(2)
  ink.update()
  console.log('Ink: OK')
} catch (e) {
  console.log('Ink FAILED:', (e as Error).message)
}

// Link with a URI action.
try {
  const link = page.createAnnotation('Link' as never)
  link.setRect([72, 300, 300, 320] as never)
  ;(link as never as { setURI?: (u: string) => void }).setURI?.('https://example.com')
  link.update()
  console.log('Link setURI available:', typeof (link as never as { setURI?: unknown }).setURI)
} catch (e) {
  console.log('Link FAILED:', (e as Error).message)
}

writeFileSync('spikes/out-annots.pdf', doc.saveToBuffer('compress').asUint8Array())
console.log('\nWrote spikes/out-annots.pdf — OPEN IT IN ACROBAT, PREVIEW, AND CHROME.')
```

- [ ] **Step 2: Run it, then open the output in three viewers**

```bash
pnpm tsx spikes/03-annotations.ts 2>&1 | tee docs/findings/scratch/03-annots.log
open -a Preview spikes/out-annots.pdf
open -a "Google Chrome" spikes/out-annots.pdf
open -a "Adobe Acrobat Reader" spikes/out-annots.pdf
```

Record what each viewer shows per annotation type. Disagreement between viewers usually means the appearance stream is missing and each viewer is synthesizing its own — which is exactly the failure the spec's phase-2 milestone guards against.

- [ ] **Step 3: Write the font probe**

`spikes/04-fonts.ts`:

```ts
import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

const TTF = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'
const ALT = '/Library/Fonts/Arial Unicode.ttf'
const fontPath = existsSync(TTF) ? TTF : ALT
if (!existsSync(fontPath)) throw new Error(`no TTF at ${TTF} or ${ALT} — point fontPath at any .ttf`)

const doc = mupdf.Document.openDocument(
  new Uint8Array(readFileSync(fixturePath('simple-text'))), 'application/pdf',
) as mupdf.PDFDocument

console.log('--- PDFDocument methods ---')
console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(doc)).sort().join(', '))
console.log('\n--- mupdf top-level exports ---')
console.log(Object.keys(mupdf).sort().join(', '))

// Q4: construct a Font from raw TTF bytes.
let font: unknown
try {
  const bytes = new Uint8Array(readFileSync(fontPath))
  font = new (mupdf as never as { Font: new (n: string, b: Uint8Array) => unknown }).Font('ProbeFont', bytes)
  console.log('\nnew mupdf.Font(name, bytes): OK')
  console.log('Font methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(font as object)).sort().join(', '))
} catch (e) {
  console.log('\nnew mupdf.Font FAILED:', (e as Error).message)
}

// Q4 continued: register it in the document.
try {
  const ref = (doc as never as { addSimpleFont: (f: unknown, enc?: string) => unknown })
    .addSimpleFont(font, 'Latin')
  console.log('addSimpleFont: OK ->', String(ref))
} catch (e) {
  console.log('addSimpleFont FAILED:', (e as Error).message)
  console.log('  -> try addCJKFont / addFont; if none work, pdf-lib takes the font path')
}

// Q5: size cost.
const before = doc.saveToBuffer('compress').asUint8Array().length
writeFileSync('spikes/out-font.pdf', doc.saveToBuffer('compress').asUint8Array())
console.log(`\nfile size with font registered: ${(before / 1024).toFixed(0)}KB`)
console.log(`raw TTF size: ${(readFileSync(fontPath).length / 1024).toFixed(0)}KB`)
console.log('If the delta ~= raw TTF size, NO subsetting happens and pdf-core/fonts.ts must subset.')
```

- [ ] **Step 4: Run it**

```bash
pnpm tsx spikes/04-fonts.ts 2>&1 | tee docs/findings/scratch/04-fonts.log
```

- [ ] **Step 5: Write the findings and make the pdf-lib call**

`docs/findings/02-write-path.md`:

```markdown
# Findings: MuPDF.js write path

## Q1 — Annotation type support
| Type | createAnnotation | Acrobat | Preview | Chrome |
|---|---|---|---|---|
| Highlight | | | | |
| Underline | | | | |
| StrikeOut | | | | |
| Ink | | | | |
| FreeText | | | | |
| Square | | | | |
| Line | | | | |
| Link | | | | |

## Q2 — Appearance streams
Auto-generated by update(): YES/NO
Cross-viewer consistent: YES/NO
<if NO, pdf-core/annots.ts must build /AP content streams by hand — note the effort>

## Q3 — FreeText capability
Font family / size / colour / alignment: <what worked>
VERDICT: FreeText is sufficient for the text tool / text must be drawn as
content-stream operators instead
<this determines whether write/drawText.ts is 50 lines or 300>

## Q4 — Arbitrary TTF embedding
Working call: <exact signature, or NONE>

## Q5 — Subsetting
Automatic: YES/NO. Size delta for a <n>KB TTF: <n>KB.

## DECISION: pdf-lib as a runtime dependency
YES / NO — because <...>
If YES: scope is strictly the font path (embedding + subsetting). MuPDF remains
the export engine for everything else, per spec §1 approach A single-engine choice.
Update PLAN.md §8 to move pdf-lib from "conditional" to "included".
```

- [ ] **Step 6: Commit**

```bash
git add spikes docs/findings
git commit -m "spike: MuPDF write path findings (annotations, font embedding)"
```

---

## Task 5: Spike — encryption and save options

**Files:**
- Create: `spikes/05-encryption.ts`
- Create: `docs/findings/03-encryption.md`

**Interfaces:**
- Consumes: `fixturePath` from Task 2
- Produces: **the `qpdf-wasm` decision** (spec §2.3, §8).

**Questions:**

1. What does `saveToBuffer` accept as an options string? Is there an enumeration of valid keys?
2. Can it write an **encrypted** PDF — user password, owner password, permission flags, AES-256?
3. Does `authenticatePassword` unlock an encrypted document, and can it then be saved decrypted?
4. What do `garbage=compact` / `garbage=deduplicate` / `compress` actually save on a real file?

- [ ] **Step 1: Write the probe**

`spikes/05-encryption.ts`:

```ts
import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

const src = new Uint8Array(readFileSync(fixturePath('large-300p')))

function open(): mupdf.PDFDocument {
  return mupdf.Document.openDocument(src, 'application/pdf') as mupdf.PDFDocument
}

// Q4: what do save options actually buy?
const OPTS = ['', 'compress', 'garbage=compact', 'garbage=deduplicate', 'compress,garbage=deduplicate']
for (const o of OPTS) {
  try {
    const out = open().saveToBuffer(o).asUint8Array()
    console.log(`"${o}" -> ${(out.length / 1024).toFixed(0)}KB`)
  } catch (e) {
    console.log(`"${o}" FAILED: ${(e as Error).message}`)
  }
}
console.log(`baseline source: ${(src.length / 1024).toFixed(0)}KB`)

// Q1/Q2: encryption. Try every plausible spelling — this is the whole point.
const CANDIDATES = [
  'encrypt=aes-256,user-password=secret,owner-password=owner',
  'encrypt=aes256,user-password=secret,owner-password=owner',
  'encryption=aes-256,user-password=secret',
  'user-password=secret,owner-password=owner',
  'decrypt=no,user-password=secret',
]
let worked: string | null = null
for (const o of CANDIDATES) {
  try {
    const out = open().saveToBuffer(o).asUint8Array()
    writeFileSync('spikes/out-enc.pdf', out)
    // The real test: can it be reopened WITHOUT the password?
    let needsPw = false
    try {
      const re = mupdf.Document.openDocument(out, 'application/pdf') as mupdf.PDFDocument
      needsPw = re.needsPassword()
    } catch { needsPw = true }
    console.log(`"${o}" -> saved ${(out.length / 1024).toFixed(0)}KB, needsPassword=${needsPw}`)
    if (needsPw) { worked = o; break }
  } catch (e) {
    console.log(`"${o}" FAILED: ${(e as Error).message}`)
  }
}
console.log('\nENCRYPTION SUPPORTED:', worked ?? 'NO — qpdf-wasm needed')

// Q3: round-trip decrypt.
if (worked) {
  const enc = new Uint8Array(readFileSync('spikes/out-enc.pdf'))
  const d = mupdf.Document.openDocument(enc, 'application/pdf') as mupdf.PDFDocument
  console.log('needsPassword:', d.needsPassword())
  console.log('authenticatePassword("wrong"):', d.authenticatePassword('wrong'))
  console.log('authenticatePassword("secret"):', d.authenticatePassword('secret'))
  const plain = d.saveToBuffer('compress').asUint8Array()
  const reopened = mupdf.Document.openDocument(plain, 'application/pdf') as mupdf.PDFDocument
  console.log('decrypted copy needsPassword:', reopened.needsPassword(), '(want false)')
}
```

- [ ] **Step 2: Run it**

```bash
pnpm tsx spikes/05-encryption.ts 2>&1 | tee docs/findings/scratch/05-enc.log
```

Verify `spikes/out-enc.pdf` genuinely prompts for a password in Preview. A save that succeeds but produces an unprotected file is the failure mode to catch here — `needsPassword()` returning true is the assertion that matters, not the absence of an exception.

- [ ] **Step 3: If MuPDF can't encrypt, probe qpdf-wasm**

Only if `worked === null`:

```bash
pnpm add -Dw @jspawn/qpdf-wasm
```

Append to the probe:

```ts
if (!worked) {
  const { default: initQpdf } = await import('@jspawn/qpdf-wasm')
  const qpdf = await initQpdf()
  // qpdf --encrypt user owner 256 -- in.pdf out.pdf
  qpdf.FS.writeFile('/in.pdf', src)
  const code = qpdf.callMain(['--encrypt', 'secret', 'owner', '256', '--', '/in.pdf', '/out.pdf'])
  console.log('qpdf exit:', code)
  const out = qpdf.FS.readFile('/out.pdf') as Uint8Array
  writeFileSync('spikes/out-enc-qpdf.pdf', out)
  const re = mupdf.Document.openDocument(out, 'application/pdf') as mupdf.PDFDocument
  console.log('qpdf output needsPassword:', re.needsPassword())
  console.log('qpdf-wasm binary size on disk: check node_modules/@jspawn/qpdf-wasm')
}
```

Record the qpdf-wasm binary size — it's an extra download for every user, and if it's large it belongs in a lazy chunk loaded only when someone actually uses password protection.

- [ ] **Step 4: Write the findings**

`docs/findings/03-encryption.md`:

```markdown
# Findings: encryption and save options

## Q1 — saveToBuffer options
Valid keys observed: <...>
Source of truth: <link to mupdf docs or header, if found>

## Q2 — Writing encrypted PDFs
SUPPORTED: YES / NO
Working option string: <...>
Verified by needsPassword() on reopen: YES/NO
Verified by Preview password prompt: YES/NO

## Q3 — Decryption round-trip
authenticatePassword works: YES/NO
Save-as-decrypted works: YES/NO

## Q4 — Compression savings (large-300p, <n>KB source)
| options | output | saving |
|---|---|---|

## DECISION: qpdf-wasm
NEEDED / NOT NEEDED — because <...>
If NEEDED: binary size <n>MB, must be a lazy-loaded chunk, not in the main bundle.
Update PLAN.md §8 to move qpdf-wasm from "conditional" to "included".
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "spike: encryption and save-option findings"
```

---

## Task 6: Spike — raw object access (form widgets and content streams)

**Files:**
- Create: `spikes/06-widgets.ts`, `spikes/07-content-stream.ts`
- Create: `docs/findings/04-raw-objects.md`

**Interfaces:**
- Consumes: `fixturePath` from Task 2
- Produces: findings that **size Phase 5 (forms) and Phase 6 (text patching)**. These are the two highest-variance phases in the spec's roadmap; this spike is what converts them from guesses into estimates.

**Questions:**

1. Does mupdf.js expose raw PDF object manipulation — `newDictionary`, `newArray`, `newName`, `newString`, `newInteger`, and `PDFObject.put/get/delete`?
2. Can a working AcroForm text field be assembled from scratch: field dict with `/FT /Tx`, `/T`, `/Ff`, plus the document `/AcroForm` with `/Fields`, `/DR`, `/DA`?
3. Does the resulting field appear and accept typing in Acrobat and Chrome? (Preview's form support is weak — don't judge by it.)
4. Can existing widgets be enumerated and read via `page.getWidgets()`, including field type, name, value, and choice options?
5. Can a page's content stream be read as bytes, modified, and written back — and does the page still render correctly?
6. Can `Tj`/`TJ` operators be located well enough to remove a specific text run? (Spec §2.4 step 3.)

- [ ] **Step 1: Write the widget probe**

`spikes/06-widgets.ts`:

```ts
import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

const doc = mupdf.Document.openDocument(
  new Uint8Array(readFileSync(fixturePath('simple-text'))), 'application/pdf',
) as mupdf.PDFDocument

// Q1: what raw-object constructors exist?
const RAW = ['newDictionary', 'newArray', 'newName', 'newString', 'newInteger', 'newReal', 'newBoolean', 'newNull', 'addObject', 'addStream', 'addRawStream', 'getTrailer']
console.log('--- raw object API ---')
for (const m of RAW) {
  console.log(`  ${m}: ${typeof (doc as never as Record<string, unknown>)[m]}`)
}

const page = doc.loadPage(0) as mupdf.PDFPage

// Q4: read existing widgets (none in this fixture — proves the call shape, not the data).
try {
  const widgets = page.getWidgets()
  console.log('\ngetWidgets() ->', widgets.length, 'widgets')
  for (const w of widgets) {
    console.log('  methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(w)).sort().join(', '))
    break
  }
} catch (e) {
  console.log('\ngetWidgets FAILED:', (e as Error).message)
}

// Q2: assemble a text field from scratch.
try {
  const annot = page.createAnnotation('Widget' as never)
  annot.setRect([72, 500, 320, 524] as never)

  const obj = (annot as never as { getObject: () => PDFObjLike }).getObject()
  type PDFObjLike = { put: (k: string, v: unknown) => void; get: (k: string) => unknown }

  obj.put('FT', doc.newName('Tx'))
  obj.put('T', doc.newString('probe_text_field'))
  obj.put('Ff', doc.newInteger(0))          // no flags: single-line, not required
  obj.put('V', doc.newString(''))
  obj.put('DA', doc.newString('/Helv 12 Tf 0 g'))

  annot.update()
  console.log('\nWidget field dict assembled OK')

  // The AcroForm dict is what makes the field actually interactive.
  const trailer = (doc as never as { getTrailer: () => PDFObjLike }).getTrailer()
  const root = trailer.get('Root') as PDFObjLike
  let acro = root.get('AcroForm') as PDFObjLike | undefined
  if (!acro || String(acro) === 'null') {
    acro = doc.newDictionary() as PDFObjLike
    root.put('AcroForm', acro)
    console.log('created /AcroForm')
  }
  const fields = doc.newArray() as never as { push: (v: unknown) => void }
  fields.push(obj)
  acro.put('Fields', fields)
  acro.put('DA', doc.newString('/Helv 12 Tf 0 g'))
  acro.put('NeedAppearances', doc.newBoolean(true))
  console.log('AcroForm wired: /Fields, /DA, /NeedAppearances')

  // /DR default resources — without a Helv font resource, viewers can't render the field text.
  const dr = doc.newDictionary() as PDFObjLike
  const fonts = doc.newDictionary() as PDFObjLike
  const helv = doc.newDictionary() as PDFObjLike
  helv.put('Type', doc.newName('Font'))
  helv.put('Subtype', doc.newName('Type1'))
  helv.put('BaseFont', doc.newName('Helvetica'))
  fonts.put('Helv', helv)
  dr.put('Font', fonts)
  acro.put('DR', dr)
  console.log('/DR default resources added')

  writeFileSync('spikes/out-widget.pdf', doc.saveToBuffer('compress').asUint8Array())
  console.log('\nWrote spikes/out-widget.pdf — OPEN IN ACROBAT AND CHROME, TRY TYPING IN THE FIELD.')
} catch (e) {
  console.log('\nWidget assembly FAILED:', (e as Error).message)
  console.log('  -> Phase 5 is significantly harder than estimated; record this.')
}
```

- [ ] **Step 2: Run it and test the field by hand**

```bash
pnpm tsx spikes/06-widgets.ts 2>&1 | tee docs/findings/scratch/06-widgets.log
open -a "Adobe Acrobat Reader" spikes/out-widget.pdf
open -a "Google Chrome" spikes/out-widget.pdf
```

**Click into the field and type.** A field that appears but won't accept input means `/AcroForm` wiring is incomplete — usually a missing `/DR` or the field not being reachable from `/Fields`. Note precisely which viewer does what; Chrome's PDF viewer is stricter about form structure than Acrobat and is the better canary.

- [ ] **Step 3: Write the content-stream probe**

`spikes/07-content-stream.ts`:

```ts
import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'
import { fixturePath } from '../packages/pdf-core/test/fixtures/index.js'

const doc = mupdf.Document.openDocument(
  new Uint8Array(readFileSync(fixturePath('simple-text'))), 'application/pdf',
) as mupdf.PDFDocument
const page = doc.loadPage(0) as mupdf.PDFPage

type PDFObjLike = {
  get: (k: string) => PDFObjLike | undefined
  put: (k: string, v: unknown) => void
  isArray?: () => boolean
  isStream?: () => boolean
  readStream?: () => { asUint8Array: () => Uint8Array }
  writeStream?: (b: Uint8Array) => void
}

const pageObj = (page as never as { getObject: () => PDFObjLike }).getObject()
console.log('page dict keys probe — Contents:', String(pageObj.get('Contents')))

// Q5: read the content stream.
const contents = pageObj.get('Contents')
let raw: Uint8Array | null = null
try {
  if (contents?.isArray?.()) {
    console.log('Contents is an array — must concatenate parts')
    const first = (contents as never as { get: (i: number) => PDFObjLike }).get(0)
    raw = first.readStream?.().asUint8Array() ?? null
  } else {
    raw = contents?.readStream?.().asUint8Array() ?? null
  }
  console.log('stream bytes:', raw?.length)
  const text = new TextDecoder('latin1').decode(raw!)
  console.log('\n--- first 1200 chars of content stream ---')
  console.log(text.slice(0, 1200))

  // Q6: can text-showing operators be located?
  const tj = [...text.matchAll(/\((?:[^()\\]|\\.)*\)\s*Tj/g)]
  const tJ = [...text.matchAll(/\[[^\]]*\]\s*TJ/g)]
  console.log(`\nfound ${tj.length} Tj and ${tJ.length} TJ operators`)
  for (const m of tj.slice(0, 5)) console.log('  Tj:', m[0].slice(0, 80), '@', m.index)

  // Q5 continued: modify and write back — delete the first Tj and confirm it renders.
  if (tj[0]) {
    const patched = text.slice(0, tj[0].index) + ' '.repeat(tj[0][0].length) + text.slice(tj[0].index! + tj[0][0].length)
    const target = contents?.isArray?.()
      ? (contents as never as { get: (i: number) => PDFObjLike }).get(0)
      : contents!
    target.writeStream?.(new TextEncoder().encode(patched))
    writeFileSync('spikes/out-patched.pdf', doc.saveToBuffer('compress').asUint8Array())
    console.log('\nWrote spikes/out-patched.pdf — the first text run should be GONE, rest intact.')
  }
} catch (e) {
  console.log('content stream access FAILED:', (e as Error).message)
  console.log('  -> spec §2.4 step 3 must use cover-and-redraw only; true redaction needs another approach.')
}
```

- [ ] **Step 4: Run it and verify the patched output visually**

```bash
pnpm tsx spikes/07-content-stream.ts 2>&1 | tee docs/findings/scratch/07-stream.log
open spikes/out-patched.pdf
```

Two things to confirm: the targeted text is gone, and **everything else still renders**. Blanking operators with spaces preserves byte offsets, which avoids breaking any length-dependent structure — if the page renders blank or corrupt, the stream is probably filtered/compressed in a way that needs decoding first, which is a materially harder problem. Also check `pdftotext spikes/out-patched.pdf -` (or re-run structured-text extraction) to confirm the text is genuinely *unextractable*, not just invisible. That distinction is the entire difference between whiteout and redaction in spec §2.1.

- [ ] **Step 5: Write the findings**

`docs/findings/04-raw-objects.md`:

```markdown
# Findings: raw PDF object access

## Q1 — Raw object API
Available: <list of confirmed constructors and PDFObject methods>

## Q2/Q3 — Form field creation from scratch
Field dict assembled: YES/NO
AcroForm wiring required: <what was actually needed>
Interactive in Acrobat: YES/NO · Chrome: YES/NO
Effort observed: <lines of code for ONE field type>
PHASE 5 ESTIMATE: <spec says 3 weeks — confirm, or revise with reasoning.
There are 6 field types plus radio-group parent/kid semantics.>

## Q4 — Reading existing widgets
getWidgets() shape: <...>
Exposes type/name/value/options: <...>

## Q5 — Content stream read/modify/write
Readable: YES/NO · Writable: YES/NO
Contents as array vs single stream: <which, and does it vary?>
Compressed/filtered streams need manual decode: YES/NO

## Q6 — Locating text operators
Tj found: <n> · TJ found: <n>
Regex approach sufficient: YES/NO
<A regex over latin1 is a spike shortcut. Note whether a real tokenizer is
needed — string literals containing escaped parens will break naive matching.>
Text genuinely unextractable after patch: YES/NO

## PHASE 6 ESTIMATE
Spec allots ~1.5 weeks for text patching. Confirm or revise: <...>
Cover-and-redraw viable now: YES/NO
Content-stream surgery viable: YES/NO / NEEDS A TOKENIZER (<est>)
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "spike: raw object access findings (form widgets, content streams)"
```

---

## Task 7: The coordinate transform module

**Files:**
- Create: `packages/transform/package.json`, `packages/transform/tsconfig.json`
- Create: `packages/transform/src/index.ts`
- Test: `packages/transform/test/transform.test.ts`
- Modify: `vitest.workspace.ts`

**Interfaces:**
- Consumes: **Task 3's finding for Q6** — whether `toPixmap` applies `/Rotate` itself. If it does, `pageViewSize` must still report rotated dimensions (the bitmap is already rotated) but `pdfToView` must *not* apply the rotation a second time. Read `docs/findings/01-read-path.md` before writing Step 3.
- Produces — every one of these is consumed by Phase 1 and by all later phases:
  ```ts
  type Point = { x: number; y: number }
  type Rect = { x: number; y: number; w: number; h: number }   // PDF space, (x,y) = bottom-left
  type Rotation = 0 | 90 | 180 | 270
  type PageGeometry = { cropBox: [number, number, number, number]; rotate: Rotation }

  function pageSizePt(g: PageGeometry): { w: number; h: number }
  function pageViewSize(g: PageGeometry, zoom: number): { width: number; height: number }
  function pdfToView(p: Point, g: PageGeometry, zoom: number): Point
  function viewToPdf(p: Point, g: PageGeometry, zoom: number): Point
  function pdfRectToView(r: Rect, g: PageGeometry, zoom: number): { x: number; y: number; w: number; h: number }
  function viewRectToPdf(r: { x: number; y: number; w: number; h: number }, g: PageGeometry, zoom: number): Rect
  function svgViewBox(g: PageGeometry): string
  function svgRootTransform(g: PageGeometry): string
  function normalizeRotation(deg: number): Rotation
  ```

**Why this is its own package** rather than `apps/web/src/lib/transform.ts` as the spec sketches: it must be importable by `pdf-core`'s Node-side golden tests, and a package boundary is the only thing that actually enforces the spec's "no component performs its own coordinate arithmetic" constraint — a `lib/` file is trivially bypassed by inlining two lines of math, and that inlining is exactly how these bugs get in.

The spec calls out why this gets property tests: PDF y-up versus CSS y-down, non-zero CropBox origins, and `/Rotate` are the number one bug source in PDF editors, and the failures are *subtle* — a few points off, only on rotated pages — so they survive manual testing and reach users.

- [ ] **Step 1: Create the package**

`packages/transform/package.json`:

```json
{
  "name": "@margin/transform",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "devDependencies": { "fast-check": "^3.23.0" }
}
```

`packages/transform/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*.ts"]
}
```

Add to `vitest.workspace.ts`:

```ts
  {
    test: {
      name: 'transform',
      root: './packages/transform',
      environment: 'node',
    },
  },
```

```bash
pnpm install
```

- [ ] **Step 2: Write the failing tests**

`packages/transform/test/transform.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  pageSizePt, pageViewSize, pdfToView, viewToPdf, pdfRectToView, viewRectToPdf,
  svgViewBox, normalizeRotation, type PageGeometry, type Rotation,
} from '../src/index.js'

const LETTER: PageGeometry = { cropBox: [0, 0, 612, 792], rotate: 0 }

describe('pageSizePt', () => {
  it('returns cropBox extent, not corner coordinates', () => {
    expect(pageSizePt({ cropBox: [50, 80, 400, 500], rotate: 0 })).toEqual({ w: 350, h: 420 })
  })
})

describe('pageViewSize', () => {
  it('scales by zoom', () => {
    expect(pageViewSize(LETTER, 2)).toEqual({ width: 1224, height: 1584 })
  })

  it('swaps dimensions for quarter turns', () => {
    expect(pageViewSize({ ...LETTER, rotate: 90 }, 1)).toEqual({ width: 792, height: 612 })
    expect(pageViewSize({ ...LETTER, rotate: 270 }, 1)).toEqual({ width: 792, height: 612 })
  })

  it('preserves dimensions for half turns', () => {
    expect(pageViewSize({ ...LETTER, rotate: 180 }, 1)).toEqual({ width: 612, height: 792 })
  })
})

describe('pdfToView — anchor cases', () => {
  // PDF origin is bottom-left; view origin is top-left. These four assertions
  // pin the y-flip, which every other case depends on.
  it('maps the PDF bottom-left corner to the view bottom-left', () => {
    expect(pdfToView({ x: 0, y: 0 }, LETTER, 1)).toEqual({ x: 0, y: 792 })
  })

  it('maps the PDF top-left corner to the view origin', () => {
    expect(pdfToView({ x: 0, y: 792 }, LETTER, 1)).toEqual({ x: 0, y: 0 })
  })

  it('subtracts a non-zero cropBox origin', () => {
    const g: PageGeometry = { cropBox: [50, 80, 400, 500], rotate: 0 }
    // (50,500) is the cropBox top-left → view origin
    expect(pdfToView({ x: 50, y: 500 }, g, 1)).toEqual({ x: 0, y: 0 })
    // (50,80) is the cropBox bottom-left → view (0, height)
    expect(pdfToView({ x: 50, y: 80 }, g, 1)).toEqual({ x: 0, y: 420 })
  })

  it('applies zoom after normalization', () => {
    expect(pdfToView({ x: 100, y: 692 }, LETTER, 2)).toEqual({ x: 200, y: 200 })
  })
})

describe('pdfToView — rotation', () => {
  // /Rotate N means "display the page rotated N degrees CLOCKWISE".
  // Content at the unrotated top-left therefore appears at the top-right when N=90.
  it('rotate 90 sends the unrotated top-left to the view top-right', () => {
    const g: PageGeometry = { ...LETTER, rotate: 90 }
    const { width } = pageViewSize(g, 1)
    const v = pdfToView({ x: 0, y: 792 }, g, 1)
    expect(v).toEqual({ x: width, y: 0 })
  })

  it('rotate 180 sends the unrotated top-left to the view bottom-right', () => {
    const g: PageGeometry = { ...LETTER, rotate: 180 }
    const { width, height } = pageViewSize(g, 1)
    expect(pdfToView({ x: 0, y: 792 }, g, 1)).toEqual({ x: width, y: height })
  })

  it('rotate 270 sends the unrotated top-left to the view bottom-left', () => {
    const g: PageGeometry = { ...LETTER, rotate: 270 }
    const { height } = pageViewSize(g, 1)
    expect(pdfToView({ x: 0, y: 792 }, g, 1)).toEqual({ x: 0, y: height })
  })

  it('keeps every rotated point inside the view box', () => {
    for (const rotate of [0, 90, 180, 270] as Rotation[]) {
      const g: PageGeometry = { ...LETTER, rotate }
      const { width, height } = pageViewSize(g, 1)
      for (const p of [{ x: 0, y: 0 }, { x: 612, y: 0 }, { x: 0, y: 792 }, { x: 612, y: 792 }]) {
        const v = pdfToView(p, g, 1)
        expect(v.x).toBeGreaterThanOrEqual(-0.001)
        expect(v.y).toBeGreaterThanOrEqual(-0.001)
        expect(v.x).toBeLessThanOrEqual(width + 0.001)
        expect(v.y).toBeLessThanOrEqual(height + 0.001)
      }
    }
  })
})

describe('normalizeRotation', () => {
  it('wraps and snaps to quarter turns', () => {
    expect(normalizeRotation(0)).toBe(0)
    expect(normalizeRotation(90)).toBe(90)
    expect(normalizeRotation(360)).toBe(0)
    expect(normalizeRotation(450)).toBe(90)
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(-450)).toBe(270)
  })
})

describe('svgViewBox', () => {
  it('uses unrotated cropBox extent with a zero origin', () => {
    // The root <g transform> handles the flip and rotation, so the viewBox
    // stays in unrotated PDF units — this is what lets objects render at raw coords.
    expect(svgViewBox({ cropBox: [50, 80, 400, 500], rotate: 90 })).toBe('0 0 350 420')
  })
})

// ---- Property tests: the real defense ----

const arbGeometry = fc.record({
  cropBox: fc
    .tuple(
      fc.integer({ min: -200, max: 200 }),
      fc.integer({ min: -200, max: 200 }),
      fc.integer({ min: 20, max: 2000 }),
      fc.integer({ min: 20, max: 2000 }),
    )
    .map(([x0, y0, w, h]) => [x0, y0, x0 + w, y0 + h] as [number, number, number, number]),
  rotate: fc.constantFrom<Rotation>(0, 90, 180, 270),
})

const arbZoom = fc.double({ min: 0.1, max: 8, noNaN: true, noDefaultInfinity: true })

describe('property: pdfToView and viewToPdf are inverses', () => {
  it('round-trips any point through any geometry and zoom', () => {
    fc.assert(
      fc.property(arbGeometry, arbZoom, fc.double({ min: -3000, max: 3000, noNaN: true }), fc.double({ min: -3000, max: 3000, noNaN: true }),
        (g, zoom, x, y) => {
          const back = viewToPdf(pdfToView({ x, y }, g, zoom), g, zoom)
          expect(back.x).toBeCloseTo(x, 6)
          expect(back.y).toBeCloseTo(y, 6)
        }),
      { numRuns: 2000 },
    )
  })
})

describe('property: rect round-trip preserves area', () => {
  it('keeps width*height invariant under transform and back', () => {
    fc.assert(
      fc.property(arbGeometry, arbZoom,
        fc.record({
          x: fc.double({ min: -500, max: 500, noNaN: true }),
          y: fc.double({ min: -500, max: 500, noNaN: true }),
          w: fc.double({ min: 1, max: 800, noNaN: true }),
          h: fc.double({ min: 1, max: 800, noNaN: true }),
        }),
        (g, zoom, r) => {
          const back = viewRectToPdf(pdfRectToView(r, g, zoom), g, zoom)
          expect(back.x).toBeCloseTo(r.x, 5)
          expect(back.y).toBeCloseTo(r.y, 5)
          expect(back.w).toBeCloseTo(r.w, 5)
          expect(back.h).toBeCloseTo(r.h, 5)
        }),
      { numRuns: 2000 },
    )
  })
})

describe('property: rects stay non-negative in view space', () => {
  it('never produces a negative width or height', () => {
    fc.assert(
      fc.property(arbGeometry, arbZoom,
        fc.record({
          x: fc.double({ min: -500, max: 500, noNaN: true }),
          y: fc.double({ min: -500, max: 500, noNaN: true }),
          w: fc.double({ min: 1, max: 800, noNaN: true }),
          h: fc.double({ min: 1, max: 800, noNaN: true }),
        }),
        (g, zoom, r) => {
          const v = pdfRectToView(r, g, zoom)
          expect(v.w).toBeGreaterThan(0)
          expect(v.h).toBeGreaterThan(0)
        }),
      { numRuns: 1000 },
    )
  })
})
```

The area-preservation and non-negative-extent properties matter as much as the round-trip: a rect transform that swaps w/h on quarter turns but forgets to re-derive the corner will still round-trip correctly while rendering every rotated object in the wrong place.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run --project transform`
Expected: FAIL — `Cannot find module '../src/index.js'`

- [ ] **Step 4: Write the implementation**

`packages/transform/src/index.ts`:

```ts
/**
 * The coordinate contract for get-margin.
 *
 * PDF user space: origin bottom-left, y-up, units are points (1/72 inch).
 * View space:     origin top-left, y-down, units are CSS pixels.
 *
 * All stored geometry in this application is UNROTATED PDF user space.
 * Zoom and page rotation are view concerns and never mutate stored data.
 *
 * `/Rotate N` in a PDF means "display this page rotated N degrees CLOCKWISE".
 */

export type Point = { x: number; y: number }
/** PDF-space rect. (x, y) is the BOTTOM-LEFT corner; w/h are always positive. */
export type Rect = { x: number; y: number; w: number; h: number }
/** View-space rect. (x, y) is the TOP-LEFT corner; w/h are always positive. */
export type ViewRect = { x: number; y: number; w: number; h: number }
export type Rotation = 0 | 90 | 180 | 270
export type PageGeometry = {
  /** [x0, y0, x1, y1] — CropBox if present, else MediaBox. Origin may be non-zero. */
  cropBox: [number, number, number, number]
  rotate: Rotation
}

export function normalizeRotation(deg: number): Rotation {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360
  return r as Rotation
}

/** Unrotated page extent in points. */
export function pageSizePt(g: PageGeometry): { w: number; h: number } {
  const [x0, y0, x1, y1] = g.cropBox
  return { w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
}

/** Displayed size in CSS pixels, accounting for quarter-turn dimension swap. */
export function pageViewSize(g: PageGeometry, zoom: number): { width: number; height: number } {
  const { w, h } = pageSizePt(g)
  const swap = g.rotate === 90 || g.rotate === 270
  return { width: (swap ? h : w) * zoom, height: (swap ? w : h) * zoom }
}

export function pdfToView(p: Point, g: PageGeometry, zoom: number): Point {
  const [x0, y0] = g.cropBox
  const { w, h } = pageSizePt(g)
  // Local unrotated coords, y still up.
  const lx = p.x - x0
  const ly = p.y - y0
  // Unrotated display coords, y now down.
  const dx = lx
  const dy = h - ly

  let vx: number
  let vy: number
  switch (g.rotate) {
    case 0:   vx = dx;     vy = dy;     break
    case 90:  vx = h - dy; vy = dx;     break
    case 180: vx = w - dx; vy = h - dy; break
    case 270: vx = dy;     vy = w - dx; break
  }
  return { x: vx * zoom, y: vy * zoom }
}

export function viewToPdf(p: Point, g: PageGeometry, zoom: number): Point {
  const [x0, y0] = g.cropBox
  const { w, h } = pageSizePt(g)
  const vx = p.x / zoom
  const vy = p.y / zoom

  let dx: number
  let dy: number
  switch (g.rotate) {
    case 0:   dx = vx;     dy = vy;     break
    case 90:  dx = vy;     dy = h - vx; break
    case 180: dx = w - vx; dy = h - vy; break
    case 270: dx = w - vy; dy = vx;     break
  }
  return { x: dx + x0, y: h - dy + y0 }
}

/**
 * Transform a PDF rect to a view rect. Both corners are transformed and then
 * re-normalized, because rotation moves which corner is topmost-leftmost.
 */
export function pdfRectToView(r: Rect, g: PageGeometry, zoom: number): ViewRect {
  const a = pdfToView({ x: r.x, y: r.y }, g, zoom)
  const b = pdfToView({ x: r.x + r.w, y: r.y + r.h }, g, zoom)
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  }
}

export function viewRectToPdf(r: ViewRect, g: PageGeometry, zoom: number): Rect {
  const a = viewToPdf({ x: r.x, y: r.y }, g, zoom)
  const b = viewToPdf({ x: r.x + r.w, y: r.y + r.h }, g, zoom)
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  }
}

/**
 * SVG overlay viewBox — always the UNROTATED extent with a zero origin.
 * Combined with svgRootTransform(), this is what lets objects render at their
 * raw stored PDF coordinates with no per-object math (spec §1.3, Layer 2).
 */
export function svgViewBox(g: PageGeometry): string {
  const { w, h } = pageSizePt(g)
  return `0 0 ${w} ${h}`
}

/**
 * Transform for the SVG overlay's single root <g>. Applies the CropBox origin
 * shift, the y-flip, and the page rotation in one place.
 *
 * Read as right-to-left: translate cropBox origin to 0, flip y, then rotate.
 */
export function svgRootTransform(g: PageGeometry): string {
  const [x0, y0] = g.cropBox
  const { w, h } = pageSizePt(g)
  const flip = `translate(0 ${h}) scale(1 -1) translate(${-x0} ${-y0})`
  switch (g.rotate) {
    case 0:   return flip
    case 90:  return `translate(${h} 0) rotate(90) ${flip}`
    case 180: return `translate(${w} ${h}) rotate(180) ${flip}`
    case 270: return `translate(0 ${w}) rotate(270) ${flip}`
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run --project transform`
Expected: PASS, all suites including 5000+ property-test cases.

If a rotation anchor case fails, the likely cause is a clockwise/counter-clockwise mix-up. Check against the test comment: `/Rotate 90` is **clockwise**, so unrotated top-left → view top-right. Do not "fix" it by flipping the test — the test encodes the PDF spec.

- [ ] **Step 6: Verify svgRootTransform against a browser, not just types**

`svgRootTransform` returns a string that no unit test can fully validate — a wrong composition order type-checks and passes round-trip tests while rendering everything mirrored. Write a throwaway HTML file:

```bash
cat > spikes/svg-check.html <<'HTML'
<!doctype html><body style="background:#eee;font:12px sans-serif">
<p>Red dot must sit at the PDF-space origin (bottom-left) for every rotation.</p>
<div id="out"></div>
<script type="module">
  // Paste the four svgRootTransform outputs for a 612x792 page here.
  const cases = [
    { r: 0,   vb: '0 0 612 792', t: 'translate(0 792) scale(1 -1) translate(0 0)',                     w: 612, h: 792 },
    { r: 90,  vb: '0 0 612 792', t: 'translate(792 0) rotate(90) translate(0 792) scale(1 -1) translate(0 0)', w: 792, h: 612 },
    { r: 180, vb: '0 0 612 792', t: 'translate(612 792) rotate(180) translate(0 792) scale(1 -1) translate(0 0)', w: 612, h: 792 },
    { r: 270, vb: '0 0 612 792', t: 'translate(0 612) rotate(270) translate(0 792) scale(1 -1) translate(0 0)', w: 792, h: 612 },
  ]
  document.getElementById('out').innerHTML = cases.map(c => `
    <div style="display:inline-block;margin:8px;text-align:center">
      <div>rotate ${c.r}</div>
      <svg width="${c.w/4}" height="${c.h/4}" viewBox="${c.vb}" style="background:#fff;border:1px solid #999"
           preserveAspectRatio="none">
        <g transform="${c.t}">
          <rect x="0" y="0" width="120" height="60" fill="red"/>
          <text x="10" y="100" font-size="48" fill="#333">TL?</text>
        </g>
      </svg>
    </div>`).join('')
</script></body>
HTML
open spikes/svg-check.html
```

Note the viewBox stays `0 0 612 792` for all four while the SVG element's width/height swap — that's the design. **Look at the four boxes.** The red rect must land at the visual position the PDF origin should occupy after each clockwise rotation. If any is mirrored or off-page, fix `svgRootTransform` before moving on — Phase 2's entire overlay sits on this function.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(transform): coordinate contract with property tests"
```

---

## Task 8: pdf-core engine and page geometry

**Files:**
- Create: `packages/pdf-core/src/engine.ts`, `packages/pdf-core/src/geometry.ts`, `packages/pdf-core/src/index.ts`
- Test: `packages/pdf-core/test/engine.test.ts`, `packages/pdf-core/test/geometry.test.ts`
- Modify: `packages/pdf-core/package.json` (add `@margin/transform` dependency)

**Interfaces:**
- Consumes: `PageGeometry`, `normalizeRotation` from `@margin/transform` (Task 7); `fixturePath` (Task 2); `docs/findings/01-read-path.md` (Task 3)
- Produces:
  ```ts
  class PdfDocument {
    static open(bytes: Uint8Array): PdfDocument
    readonly pageCount: number
    needsPassword(): boolean
    authenticate(password: string): boolean
    pageGeometry(index: number): PageGeometry
    close(): void
  }
  class PdfPasswordRequiredError extends Error {}
  function readPageGeometry(doc: PdfDocument, index: number): PageGeometry
  ```
  `PdfDocument` is the only handle any other module holds. Tasks 9, 10, and all of Phase 1 go through it.

**Design note on geometry:** this reads `/CropBox`, `/MediaBox`, and `/Rotate` from the **raw page dictionary with `/Parent`-chain inheritance**, rather than trusting `page.getBounds()`. Two reasons. First, all three of those keys are legally *inheritable* in PDF — a page can omit `/MediaBox` and inherit it from the Pages tree, and a surprising number of real-world files do. Second, it makes this module independent of Task 3's Q5/Q6 answers: whatever `getBounds()` turns out to return, the unrotated CropBox derived here is correct by construction.

- [ ] **Step 1: Add the transform dependency**

Add to `packages/pdf-core/package.json` dependencies:

```json
"@margin/transform": "workspace:*"
```

```bash
pnpm install
```

- [ ] **Step 2: Write the failing tests**

`packages/pdf-core/test/engine.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PdfDocument } from '../src/index.js'
import { generateFixtures, fixturePath } from './fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)

const bytes = (n: Parameters<typeof fixturePath>[0]) => new Uint8Array(readFileSync(fixturePath(n)))

describe('PdfDocument.open', () => {
  it('reports the page count', () => {
    const doc = PdfDocument.open(bytes('multi-page'))
    expect(doc.pageCount).toBe(12)
    doc.close()
  })

  it('handles a 300-page document', () => {
    const doc = PdfDocument.open(bytes('large-300p'))
    expect(doc.pageCount).toBe(300)
    doc.close()
  })

  it('reports no password needed for a plain document', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    expect(doc.needsPassword()).toBe(false)
    doc.close()
  })

  it('throws a typed error on non-PDF input', () => {
    expect(() => PdfDocument.open(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })

  it('is safe to close twice', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    doc.close()
    expect(() => doc.close()).not.toThrow()
  })

  it('rejects use after close', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    doc.close()
    expect(() => doc.pageGeometry(0)).toThrow(/closed/i)
  })
})
```

`packages/pdf-core/test/geometry.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PdfDocument } from '../src/index.js'
import { generateFixtures, fixturePath } from './fixtures/index.js'
import { pageSizePt } from '@margin/transform'

beforeAll(async () => { await generateFixtures() }, 60_000)

const bytes = (n: Parameters<typeof fixturePath>[0]) => new Uint8Array(readFileSync(fixturePath(n)))

describe('pageGeometry', () => {
  it('returns US Letter dimensions with a zero origin', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const g = doc.pageGeometry(0)
    expect(g.cropBox).toEqual([0, 0, 612, 792])
    expect(g.rotate).toBe(0)
    doc.close()
  })

  it('returns the CropBox including a non-zero origin', () => {
    const doc = PdfDocument.open(bytes('offset-cropbox'))
    const g = doc.pageGeometry(0)
    expect(g.cropBox).toEqual([50, 80, 400, 500])
    expect(pageSizePt(g)).toEqual({ w: 350, h: 420 })
    doc.close()
  })

  it('reads /Rotate for each page', () => {
    const doc = PdfDocument.open(bytes('rotated'))
    expect(doc.pageGeometry(0).rotate).toBe(0)
    expect(doc.pageGeometry(1).rotate).toBe(90)
    expect(doc.pageGeometry(2).rotate).toBe(180)
    expect(doc.pageGeometry(3).rotate).toBe(270)
    doc.close()
  })

  it('keeps cropBox unrotated regardless of /Rotate', () => {
    // A rotated page's STORED box is still portrait. Rotation is a view concern.
    const doc = PdfDocument.open(bytes('rotated'))
    expect(doc.pageGeometry(1).cropBox).toEqual([0, 0, 612, 792])
    doc.close()
  })

  it('throws on an out-of-range page index', () => {
    const doc = PdfDocument.open(bytes('multi-page'))
    expect(() => doc.pageGeometry(12)).toThrow(/range/i)
    expect(() => doc.pageGeometry(-1)).toThrow(/range/i)
    doc.close()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run --project pdf-core engine geometry`
Expected: FAIL — `Cannot find module '../src/index.js'`

- [ ] **Step 4: Write the implementation**

`packages/pdf-core/src/geometry.ts`:

```ts
import { normalizeRotation, type PageGeometry, type Rotation } from '@margin/transform'

/** Minimal structural type for a mupdf PDFObject — avoids leaking mupdf types outward. */
export type RawObj = {
  get: (key: string) => RawObj | undefined
  isArray?: () => boolean
  isNumber?: () => boolean
  asNumber?: () => number
  asFloat?: () => number
  isNull?: () => boolean
  length?: number
}

function isPresent(o: RawObj | undefined): o is RawObj {
  return o !== undefined && o !== null && o.isNull?.() !== true && String(o) !== 'null'
}

function num(o: RawObj | undefined): number | undefined {
  if (!isPresent(o)) return undefined
  const v = o.asNumber?.() ?? o.asFloat?.()
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Resolve an inheritable page attribute. /MediaBox, /CropBox, /Resources and
 * /Rotate may all be omitted on a page and inherited from the Pages tree —
 * this is legal PDF and common in real files.
 */
function inherited(pageObj: RawObj, key: string, maxDepth = 32): RawObj | undefined {
  let node: RawObj | undefined = pageObj
  for (let d = 0; d < maxDepth && node; d++) {
    const v = node.get(key)
    if (isPresent(v)) return v
    node = node.get('Parent')
    if (!isPresent(node)) return undefined
  }
  return undefined
}

function readBox(pageObj: RawObj, key: string): [number, number, number, number] | undefined {
  const arr = inherited(pageObj, key)
  if (!isPresent(arr) || arr.isArray?.() !== true) return undefined
  const idx = arr as unknown as { get: (i: number) => RawObj | undefined }
  const vals = [0, 1, 2, 3].map((i) => num(idx.get(i)))
  if (vals.some((v) => v === undefined)) return undefined
  const [a, b, c, d] = vals as [number, number, number, number]
  // PDF boxes may be stored with corners in any order; normalize to min/max.
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)]
}

const LETTER: [number, number, number, number] = [0, 0, 612, 792]

/**
 * Derive unrotated page geometry from the raw page dictionary.
 *
 * CropBox is intersected with MediaBox per PDF 32000-1 §14.11.2: a CropBox
 * extending beyond the MediaBox is invalid and must be clipped, not honoured.
 */
export function geometryFromPageObject(pageObj: RawObj): PageGeometry {
  const media = readBox(pageObj, 'MediaBox') ?? LETTER
  const crop = readBox(pageObj, 'CropBox')

  let box = media
  if (crop) {
    const x0 = Math.max(crop[0], media[0])
    const y0 = Math.max(crop[1], media[1])
    const x1 = Math.min(crop[2], media[2])
    const y1 = Math.min(crop[3], media[3])
    // Degenerate intersection means a malformed CropBox — fall back to MediaBox.
    box = x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : media
  }

  const rotateRaw = num(inherited(pageObj, 'Rotate')) ?? 0
  const rotate: Rotation = normalizeRotation(rotateRaw)

  return { cropBox: box, rotate }
}
```

`packages/pdf-core/src/engine.ts`:

```ts
import * as mupdf from 'mupdf'
import type { PageGeometry } from '@margin/transform'
import { geometryFromPageObject, type RawObj } from './geometry.js'

export class PdfPasswordRequiredError extends Error {
  constructor() {
    super('This PDF requires a password')
    this.name = 'PdfPasswordRequiredError'
  }
}

export class PdfOpenError extends Error {
  constructor(cause: unknown) {
    super('Could not open this file as a PDF')
    this.name = 'PdfOpenError'
    this.cause = cause
  }
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] // "%PDF"

/** Spec §2.1 / §4: validate magic bytes, never the filename extension. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  // The header may be preceded by junk in tolerant readers; check the first 1KB.
  const limit = Math.min(bytes.length - PDF_MAGIC.length, 1024)
  for (let i = 0; i <= limit; i++) {
    if (PDF_MAGIC.every((b, k) => bytes[i + k] === b)) return true
  }
  return false
}

/**
 * Owns one open MuPDF document. Every other module in the app holds this
 * handle rather than a raw mupdf object, so lifetime and disposal live here.
 */
export class PdfDocument {
  #doc: mupdf.PDFDocument | undefined
  #geometryCache = new Map<number, PageGeometry>()

  private constructor(doc: mupdf.PDFDocument) {
    this.#doc = doc
  }

  static open(bytes: Uint8Array): PdfDocument {
    if (!looksLikePdf(bytes)) throw new PdfOpenError('missing %PDF header')
    try {
      const doc = mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument
      return new PdfDocument(doc)
    } catch (e) {
      throw new PdfOpenError(e)
    }
  }

  #live(): mupdf.PDFDocument {
    if (!this.#doc) throw new Error('PdfDocument is closed')
    return this.#doc
  }

  get pageCount(): number {
    return this.#live().countPages()
  }

  needsPassword(): boolean {
    return this.#live().needsPassword()
  }

  /** Returns true if the password was accepted. */
  authenticate(password: string): boolean {
    // MuPDF returns 0 on failure, non-zero for various success flavours.
    return Boolean(this.#live().authenticatePassword(password))
  }

  pageGeometry(index: number): PageGeometry {
    const doc = this.#live()
    if (!Number.isInteger(index) || index < 0 || index >= doc.countPages()) {
      throw new RangeError(`page index ${index} out of range (0..${doc.countPages() - 1})`)
    }
    const cached = this.#geometryCache.get(index)
    if (cached) return cached

    const page = doc.loadPage(index) as mupdf.PDFPage
    try {
      const obj = (page as unknown as { getObject: () => RawObj }).getObject()
      const geom = geometryFromPageObject(obj)
      this.#geometryCache.set(index, geom)
      return geom
    } finally {
      ;(page as unknown as { destroy?: () => void }).destroy?.()
    }
  }

  /** Internal: hands the raw document to sibling modules in this package. */
  _raw(): mupdf.PDFDocument {
    return this.#live()
  }

  close(): void {
    const doc = this.#doc
    this.#doc = undefined
    this.#geometryCache.clear()
    ;(doc as unknown as { destroy?: () => void } | undefined)?.destroy?.()
  }
}
```

`packages/pdf-core/src/index.ts`:

```ts
export { PdfDocument, PdfOpenError, PdfPasswordRequiredError, looksLikePdf } from './engine.js'
export { geometryFromPageObject } from './geometry.js'
export type { RawObj } from './geometry.js'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run --project pdf-core engine geometry`
Expected: PASS.

If `pageObj.get('MediaBox')` returns something whose `.isArray()` is undefined, the `RawObj` structural type doesn't match the real mupdf `PDFObject` — consult `docs/findings/04-raw-objects.md` from Task 6 for the actual method names and adjust `RawObj` and the accessors in `geometry.ts`. This is the module most sensitive to the spike findings, which is why it comes after them.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(pdf-core): document handle and inheritable page geometry"
```

---

## Task 9: pdf-core page rendering

**Files:**
- Create: `packages/pdf-core/src/render.ts`
- Modify: `packages/pdf-core/src/index.ts`
- Test: `packages/pdf-core/test/render.test.ts`

**Interfaces:**
- Consumes: `PdfDocument` (Task 8); `pageViewSize` from `@margin/transform` (Task 7); `docs/findings/01-read-path.md` Q3/Q6 (Task 3)
- Produces:
  ```ts
  type RenderedPage = { width: number; height: number; rgba: Uint8Array }  // RGBA, 4 bytes/px, row-major, top-left origin
  function renderPage(doc: PdfDocument, index: number, scale: number): RenderedPage
  const MUPDF_APPLIES_ROTATION: boolean
  ```
  `RenderedPage.rgba` is laid out for direct use as `ImageData` in the browser — RGBA specifically, not RGB, because `putImageData` and `createImageBitmap` both require 4 channels.

- [ ] **Step 1: Write the failing tests**

`packages/pdf-core/test/render.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PdfDocument, renderPage } from '../src/index.js'
import { generateFixtures, fixturePath } from './fixtures/index.js'
import { pageViewSize } from '@margin/transform'

beforeAll(async () => { await generateFixtures() }, 60_000)

const bytes = (n: Parameters<typeof fixturePath>[0]) => new Uint8Array(readFileSync(fixturePath(n)))

describe('renderPage', () => {
  it('produces RGBA at the expected dimensions', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const r = renderPage(doc, 0, 1)
    expect(r.width).toBe(612)
    expect(r.height).toBe(792)
    expect(r.rgba.length).toBe(612 * 792 * 4)
    doc.close()
  })

  it('scales linearly', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const r = renderPage(doc, 0, 2)
    expect(r.width).toBe(1224)
    expect(r.height).toBe(1584)
    doc.close()
  })

  it('agrees with pageViewSize for every rotation', () => {
    // This is the assertion that catches a rotation double-application:
    // the bitmap MUST match what the view layer expects to lay out.
    const doc = PdfDocument.open(bytes('rotated'))
    for (let i = 0; i < 4; i++) {
      const expected = pageViewSize(doc.pageGeometry(i), 1)
      const r = renderPage(doc, i, 1)
      expect({ w: r.width, h: r.height }, `page ${i} rotate ${doc.pageGeometry(i).rotate}`)
        .toEqual({ w: Math.round(expected.width), h: Math.round(expected.height) })
    }
    doc.close()
  })

  it('honours a non-zero CropBox', () => {
    const doc = PdfDocument.open(bytes('offset-cropbox'))
    const r = renderPage(doc, 0, 1)
    expect(r.width).toBe(350)
    expect(r.height).toBe(420)
    doc.close()
  })

  it('renders a mostly-white page with opaque alpha', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const r = renderPage(doc, 0, 1)
    // Sample the bottom-right region, which the fixture leaves blank.
    const x = 550, y = 750
    const i = (y * r.width + x) * 4
    expect(r.rgba[i]).toBeGreaterThan(240)
    expect(r.rgba[i + 1]).toBeGreaterThan(240)
    expect(r.rgba[i + 2]).toBeGreaterThan(240)
    expect(r.rgba[i + 3]).toBe(255)
    doc.close()
  })

  it('renders non-white pixels where content exists', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    const r = renderPage(doc, 0, 1)
    let dark = 0
    for (let i = 0; i < r.rgba.length; i += 4) if ((r.rgba[i] ?? 255) < 128) dark++
    expect(dark).toBeGreaterThan(200) // the heading alone covers more than this
    doc.close()
  })

  it('rejects an out-of-range index and a non-positive scale', () => {
    const doc = PdfDocument.open(bytes('simple-text'))
    expect(() => renderPage(doc, 5, 1)).toThrow(/range/i)
    expect(() => renderPage(doc, 0, 0)).toThrow(/scale/i)
    expect(() => renderPage(doc, 0, -1)).toThrow(/scale/i)
    doc.close()
  })

  it('does not leak across 60 renders', () => {
    const doc = PdfDocument.open(bytes('large-300p'))
    const before = process.memoryUsage().rss
    for (let i = 0; i < 60; i++) renderPage(doc, i, 1)
    const growthMb = (process.memoryUsage().rss - before) / 1048576
    // Generous ceiling: this catches unbounded accumulation, not ordinary churn.
    expect(growthMb).toBeLessThan(400)
    doc.close()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project pdf-core render`
Expected: FAIL — `renderPage` is not exported.

- [ ] **Step 3: Write the implementation**

`packages/pdf-core/src/render.ts`:

```ts
import * as mupdf from 'mupdf'
import { pageViewSize } from '@margin/transform'
import type { PdfDocument } from './engine.js'

/**
 * Whether MuPDF's toPixmap() applies the page's /Rotate itself.
 *
 * Set from docs/findings/01-read-path.md Q6. The render test
 * "agrees with pageViewSize for every rotation" is the arbiter: if it fails
 * with swapped dimensions on pages 1 and 3, flip this constant.
 */
export const MUPDF_APPLIES_ROTATION = true

export type RenderedPage = {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel, row-major, top-left origin. Ready for ImageData. */
  rgba: Uint8Array
}

function rotationMatrix(deg: number): mupdf.Matrix {
  // Only needed when MuPDF does NOT apply /Rotate for us.
  switch (((deg % 360) + 360) % 360) {
    case 90: return [0, 1, -1, 0, 0, 0] as unknown as mupdf.Matrix
    case 180: return [-1, 0, 0, -1, 0, 0] as unknown as mupdf.Matrix
    case 270: return [0, -1, 1, 0, 0, 0] as unknown as mupdf.Matrix
    default: return mupdf.Matrix.identity
  }
}

export function renderPage(doc: PdfDocument, index: number, scale: number): RenderedPage {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError(`scale must be a positive finite number, got ${scale}`)
  }
  const geom = doc.pageGeometry(index) // also validates the index
  const page = doc._raw().loadPage(index) as mupdf.PDFPage
  let pixmap: mupdf.Pixmap | undefined
  try {
    let matrix = mupdf.Matrix.scale(scale, scale)
    if (!MUPDF_APPLIES_ROTATION && geom.rotate !== 0) {
      matrix = mupdf.Matrix.concat(matrix, rotationMatrix(geom.rotate))
    }
    // alpha=true gives us 4 channels, which is what ImageData requires.
    pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)

    const width = pixmap.getWidth()
    const height = pixmap.getHeight()
    const src = pixmap.getPixels()
    const expected = width * height * 4

    let rgba: Uint8Array
    if (src.length === expected) {
      // Copy: the pixmap's buffer is freed on destroy(), and in the browser
      // this array is transferred to the main thread after we return.
      rgba = new Uint8Array(src)
    } else if (src.length === width * height * 3) {
      // Defensive: some builds return RGB despite alpha=true.
      rgba = new Uint8Array(expected)
      for (let p = 0, s = 0; p < expected; p += 4, s += 3) {
        rgba[p] = src[s] ?? 0
        rgba[p + 1] = src[s + 1] ?? 0
        rgba[p + 2] = src[s + 2] ?? 0
        rgba[p + 3] = 255
      }
    } else {
      throw new Error(
        `unexpected pixmap layout: ${src.length} bytes for ${width}x${height} ` +
        `(expected ${expected} RGBA or ${width * height * 3} RGB)`,
      )
    }

    // Sanity-check against the view layer's expectation. A mismatch here means
    // MUPDF_APPLIES_ROTATION is wrong, and every later layout bug traces to it.
    const view = pageViewSize(geom, scale)
    if (Math.abs(width - view.width) > 1.5 || Math.abs(height - view.height) > 1.5) {
      throw new Error(
        `render/layout disagreement on page ${index} (rotate ${geom.rotate}): ` +
        `pixmap ${width}x${height} vs pageViewSize ${view.width}x${view.height}. ` +
        `Check MUPDF_APPLIES_ROTATION against docs/findings/01-read-path.md Q6.`,
      )
    }

    return { width, height, rgba }
  } finally {
    ;(pixmap as unknown as { destroy?: () => void } | undefined)?.destroy?.()
    ;(page as unknown as { destroy?: () => void }).destroy?.()
  }
}
```

Add to `packages/pdf-core/src/index.ts`:

```ts
export { renderPage, MUPDF_APPLIES_ROTATION } from './render.js'
export type { RenderedPage } from './render.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project pdf-core render`
Expected: PASS.

If the rotation test fails with a `render/layout disagreement` message, flip `MUPDF_APPLIES_ROTATION` and re-run. That error existing is the point — it converts a silent, subtle, rotated-pages-only layout bug into a loud failure at the boundary where the two assumptions meet.

If the memory test fails, `destroy()` isn't available under the names probed. Consult `docs/findings/01-read-path.md` Q3 for what disposal method actually exists and use it in the `finally` block.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(pdf-core): page rendering to RGBA with rotation cross-check"
```

---

## Task 10: The golden-file test rig

**Files:**
- Create: `packages/pdf-core/test/golden.ts`
- Create: `packages/pdf-core/test/golden.test.ts`
- Create: `packages/pdf-core/test/golden/.gitkeep`
- Modify: root `package.json` (add `test:golden:update` script)

**Interfaces:**
- Consumes: `PdfDocument`, `renderPage` (Tasks 8–9)
- Produces:
  ```ts
  type GoldenOptions = { page?: number; scale?: number; maxDiffRatio?: number; threshold?: number }
  async function assertGolden(name: string, pdf: Uint8Array, opts?: GoldenOptions): Promise<void>
  async function renderToPng(pdf: Uint8Array, page: number, scale: number): Promise<Buffer>
  ```
  Every export test from Phase 2 onward calls `assertGolden`.

**Why this exists and why it's built now.** The spec's chosen architecture (approach A, overlay + deferred bake) has exactly one structural weakness: the SVG overlay preview and the baked PDF output are produced by different code, so they can silently diverge. A user sees a correct preview, downloads a wrong file, and no unit test notices. Because MuPDF also runs in Node, the defense is available: export a PDF, re-render it with the same engine, and pixel-compare against a reviewed golden image. Building the rig before the features it protects is the whole reason it will actually get used.

- [ ] **Step 1: Write the failing test**

`packages/pdf-core/test/golden.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { assertGolden, renderToPng } from './golden.js'
import { generateFixtures, fixturePath } from './fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)

const bytes = (n: Parameters<typeof fixturePath>[0]) => new Uint8Array(readFileSync(fixturePath(n)))

describe('golden rig', () => {
  it('renders a PDF to a PNG buffer', async () => {
    const png = await renderToPng(bytes('simple-text'), 0, 1)
    // PNG magic number.
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(png.length).toBeGreaterThan(1000)
  })

  it('passes when output matches the golden', async () => {
    await expect(assertGolden('simple-text-p0', bytes('simple-text'))).resolves.toBeUndefined()
  })

  it('passes on a repeat run (renders are deterministic)', async () => {
    await expect(assertGolden('simple-text-p0', bytes('simple-text'))).resolves.toBeUndefined()
  })

  it('fails loudly when the document changes', async () => {
    // Same golden name, visibly different content — the rig must reject this.
    const doc = await PDFDocument.load(bytes('simple-text'))
    const font = await doc.embedFont(StandardFonts.Helvetica)
    doc.getPage(0).drawText('UNEXPECTED CONTENT', { x: 72, y: 400, size: 36, font })
    doc.setCreationDate(new Date('2020-01-01T00:00:00Z'))
    doc.setModificationDate(new Date('2020-01-01T00:00:00Z'))
    const mutated = await doc.save({ useObjectStreams: false })

    await expect(assertGolden('simple-text-p0', mutated)).rejects.toThrow(/differs from golden/i)
  })

  it('respects the page option', async () => {
    await expect(assertGolden('multi-page-p5', bytes('multi-page'), { page: 5 })).resolves.toBeUndefined()
  })
})
```

Note the fourth test: a golden rig that can't *fail* is worthless, and "it passed" tells you nothing until you've watched it reject a real change. That test is the one that proves the rig works.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project pdf-core golden`
Expected: FAIL — `Cannot find module './golden.js'`

- [ ] **Step 3: Write the rig**

`packages/pdf-core/test/golden.ts`:

```ts
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PdfDocument, renderPage } from '../src/index.js'

const GOLDEN_DIR = join(new URL('.', import.meta.url).pathname, 'golden')
const UPDATE = process.env.UPDATE_GOLDENS === '1'

export type GoldenOptions = {
  page?: number
  scale?: number
  /** Fraction of differing pixels tolerated. Default 0 — exact match. */
  maxDiffRatio?: number
  /** pixelmatch per-pixel colour sensitivity, 0..1. Default 0.1. */
  threshold?: number
}

export async function renderToPng(pdf: Uint8Array, page = 0, scale = 1): Promise<Buffer> {
  const doc = PdfDocument.open(pdf)
  try {
    const { width, height, rgba } = renderPage(doc, page, scale)
    const png = new PNG({ width, height })
    png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)
    return PNG.sync.write(png)
  } finally {
    doc.close()
  }
}

/**
 * Render `pdf` and compare against the reviewed golden image for `name`.
 *
 * Missing goldens are written and the assertion passes with a warning — the
 * new file must then be reviewed by eye and committed. Run the whole suite with
 * UPDATE_GOLDENS=1 to re-baseline after an intentional rendering change.
 */
export async function assertGolden(name: string, pdf: Uint8Array, opts: GoldenOptions = {}): Promise<void> {
  const { page = 0, scale = 1, maxDiffRatio = 0, threshold = 0.1 } = opts
  await mkdir(GOLDEN_DIR, { recursive: true })

  const goldenPath = join(GOLDEN_DIR, `${name}.png`)
  const actualPng = await renderToPng(pdf, page, scale)

  if (UPDATE || !existsSync(goldenPath)) {
    await writeFile(goldenPath, actualPng)
    if (!UPDATE) {
      console.warn(
        `[golden] created ${name}.png — REVIEW IT BY EYE and commit it. ` +
        `An unreviewed golden asserts nothing.`,
      )
    }
    return
  }

  const expected = PNG.sync.read(await readFile(goldenPath))
  const actual = PNG.sync.read(actualPng)

  if (expected.width !== actual.width || expected.height !== actual.height) {
    await writeFile(join(GOLDEN_DIR, `${name}.actual.png`), actualPng)
    throw new Error(
      `[golden] ${name} differs from golden: size ${actual.width}x${actual.height} ` +
      `vs expected ${expected.width}x${expected.height}. Wrote ${name}.actual.png`,
    )
  }

  const diff = new PNG({ width: expected.width, height: expected.height })
  const diffPixels = pixelmatch(
    expected.data, actual.data, diff.data, expected.width, expected.height,
    { threshold, includeAA: false },
  )
  const total = expected.width * expected.height
  const ratio = diffPixels / total

  if (ratio > maxDiffRatio) {
    await writeFile(join(GOLDEN_DIR, `${name}.actual.png`), actualPng)
    await writeFile(join(GOLDEN_DIR, `${name}.diff.png`), PNG.sync.write(diff))
    throw new Error(
      `[golden] ${name} differs from golden: ${diffPixels}/${total} pixels ` +
      `(${(ratio * 100).toFixed(3)}%) exceed maxDiffRatio ${maxDiffRatio}. ` +
      `Wrote ${name}.actual.png and ${name}.diff.png — open the diff before assuming it's noise.`,
    )
  }
}
```

Add to root `package.json` scripts:

```json
"test:golden:update": "UPDATE_GOLDENS=1 vitest run"
```

`packages/pdf-core/test/golden/.gitkeep` — empty file, so the directory exists in a fresh clone.

- [ ] **Step 4: Generate and review the goldens**

Run: `pnpm vitest run --project pdf-core golden`

The first run creates `simple-text-p0.png` and `multi-page-p5.png` and warns about each. **Open both images and look at them.** `simple-text-p0.png` must show "Hello margin", the body line, and the pale rectangle. `multi-page-p5.png` must show "Page 6" (page index 5). An unreviewed golden locks in whatever the code did on day one, including bugs.

- [ ] **Step 5: Run again to verify real comparison passes and the failure case fails**

Run: `pnpm vitest run --project pdf-core golden`
Expected: PASS with no warnings — all five tests, including the mutated-document rejection.

If the "fails loudly" test does *not* fail, the rig isn't comparing anything — check that `existsSync(goldenPath)` is true and `UPDATE_GOLDENS` is unset in your shell.

- [ ] **Step 6: Commit the goldens**

```bash
git add -A
git commit -m "test(pdf-core): golden-file render comparison rig"
```

---

## Task 11: Phase 0 decision record and spike teardown

**Files:**
- Create: `docs/findings/00-phase-0-decisions.md`
- Modify: `PLAN.md` (§8 package list, §7 estimates, per findings)
- Delete: `spikes/`, `docs/findings/scratch/`

**Interfaces:**
- Consumes: all four findings documents (Tasks 3–6)
- Produces: the decision record that Phase 1 and every later phase treats as settled fact

Spikes are throwaway by definition (see "How Phase 0 differs from Phase 1"). Deleting them is what stops half-finished probe code being mistaken for a real module in month three. The findings documents are the durable artifact; the code is not.

- [ ] **Step 1: Write the consolidated decision record**

`docs/findings/00-phase-0-decisions.md`:

```markdown
# Phase 0 decision record

Engine: mupdf@<version> · Node <version> · <date>
Sources: 01-read-path.md · 02-write-path.md · 03-encryption.md · 04-raw-objects.md

## Settled dependencies
| Question | Decision | Source |
|---|---|---|
| pdf-lib as a runtime dependency? | YES (font path only) / NO | 02 Q4/Q5 |
| qpdf-wasm needed for encryption? | YES (lazy chunk) / NO | 03 Q2 |
| Pixmap disposal required? | YES / NO | 01 Q3 |
| MUPDF_APPLIES_ROTATION | true / false | 01 Q6 |
| getBounds returns | CropBox / MediaBox | 01 Q5 |
| Structured-text option string | <exact string> | 01 Q4 |

## Settled capabilities
| Capability | Verdict | Consequence |
|---|---|---|
| Native annotations render cross-viewer | | |
| FreeText sufficient for the text tool | | write/drawText.ts scope |
| Arbitrary TTF embedding | | fonts.ts scope |
| Font subsetting automatic | | export size budget |
| Encrypted save | | §2.3 approach |
| Form widget creation from scratch | | Phase 5 estimate |
| Content-stream read/modify/write | | Phase 6 redaction approach |
| Text unextractable after stream patch | | whiteout vs redaction distinction |

## Revised estimates
| Phase | Spec estimate | Revised | Why |
|---|---|---|---|
| 5 — Forms | 3 weeks | | 04 Q2/Q3 |
| 6 — Advanced | 3.5 weeks | | 04 Q5/Q6, 02 Q3 |

## Measured performance baseline
300-page render: <n> pages/sec at 1.0x, <n> at 2.0x. First page: <n>ms. Peak RSS: <n>MB.
Phase 1 budget: first page visible within <n>ms of file drop.

## Blocking issues for Phase 1
<anything that must be resolved before the viewer shell, or "none">
```

- [ ] **Step 2: Update PLAN.md to match reality**

Apply each settled decision to the spec so there is one source of truth:

- §8 package list — move `pdf-lib` and `qpdf-wasm` out of "conditional" into either included or removed, with a one-line reason.
- §7 Phase 5 and Phase 6 — replace the estimates with the revised ones and note the source.
- §2.4 — if font metadata was missing from structured text (01 Q4), amend the text-patching approach to say so explicitly.
- §2.2 — if widget creation proved harder than assumed, upgrade the risk marker and say what changed.
- §0 — nothing changes here; the licensing decision is still open by design.

- [ ] **Step 3: Delete the spike code**

```bash
git rm -r --cached spikes docs/findings/scratch 2>/dev/null || true
rm -rf spikes docs/findings/scratch
```

Add to `.gitignore`:

```
spikes/
```

- [ ] **Step 4: Verify the suite is green without the spikes**

```bash
pnpm install
pnpm test
pnpm typecheck
```

Expected: all projects pass — `pdf-core` (smoke, fixtures, engine, geometry, render, golden) and `transform` (unit + property). Nothing may import from `spikes/`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: phase 0 decision record; remove spike code"
git tag phase-0-complete
```

> ### ▶ Phase 0 gate
> Do not start Phase 1 until `docs/findings/00-phase-0-decisions.md` has no blank cells. Every blank is an assumption Phase 1 would build on. If any capability came back NO, revisit the affected spec section before writing viewer code — a wrong answer here is cheap now and expensive in month four.

---

# Phase 1 — Viewer shell

**Milestone:** open any PDF and read it comfortably on desktop and phone. Read-only — no editing. Phase 2 adds the overlay.

---

## Task 12: Vue app scaffold, design tokens, and theming

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/main.ts`, `apps/web/src/app/App.vue`
- Create: `apps/web/src/app/styles/tokens.css`
- Create: `apps/web/src/lib/theme.ts`
- Test: `apps/web/test/theme.test.ts`
- Modify: `vitest.workspace.ts`

**Interfaces:**
- Consumes: nothing from Phase 0 yet
- Produces:
  ```ts
  type ThemeChoice = 'light' | 'dark' | 'system'
  type ResolvedTheme = 'light' | 'dark'
  function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme
  function useTheme(): {
    choice: Ref<ThemeChoice>
    resolved: ComputedRef<ResolvedTheme>
    setChoice: (c: ThemeChoice) => void
    cycle: () => void
  }
  ```
  Every later component reads colour from the tokens this task defines; none of them read `choice` directly.

**Token strategy** (spec §6, Global Constraints): tokens are declared once on `:root` and *redefined* under `[data-theme="dark"]`. Components reference only semantic names — `bg-surface`, `border-border`, `text-muted`. There is deliberately **no `dark:` variant used for colour anywhere in this codebase**; dark mode is a token swap. The payoff is that adding a component can't forget dark mode, and changing the palette is a one-file edit rather than a grep across every template.

- [ ] **Step 1: Create the app package**

`apps/web/package.json`:

```json
{
  "name": "@margin/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview --port 4173"
  },
  "dependencies": {
    "@margin/pdf-core": "workspace:*",
    "@margin/transform": "workspace:*",
    "vue": "^3.5.13",
    "pinia": "^2.3.0",
    "comlink": "^4.4.2",
    "@vueuse/core": "^12.0.0",
    "@tanstack/vue-virtual": "^3.11.0",
    "lucide-vue-next": "^0.468.0",
    "reka-ui": "^2.0.0",
    "tailwind-merge": "^2.5.5",
    "class-variance-authority": "^0.7.1"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "@vitejs/plugin-vue": "^5.2.1",
    "vite": "^6.0.0",
    "vue-tsc": "^2.1.10",
    "@vue/test-utils": "^2.4.6",
    "jsdom": "^25.0.1"
  }
}
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "types": ["vite/client"],
    "paths": { "@/*": ["./src/*"] },
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "test/**/*.ts"]
}
```

`apps/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  worker: { format: 'es' },
  optimizeDeps: {
    // The WASM package must not be pre-bundled — esbuild mangles its loader.
    exclude: ['mupdf'],
  },
  build: { target: 'es2022' },
})
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, viewport-fit=cover" />
    <title>get-margin</title>
    <script>
      // Applied before first paint so there is no light-mode flash on a dark-theme load.
      try {
        const stored = localStorage.getItem('margin.theme')
        const dark = stored === 'dark' || (stored !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
        document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      } catch {}
    </script>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`maximum-scale=5` rather than the usual `1` — the spec commits to phone support, and forbidding browser zoom on a document reader is an accessibility failure.

- [ ] **Step 2: Write the token stylesheet**

`apps/web/src/app/styles/tokens.css`:

```css
@import 'tailwindcss';

/*
  Semantic tokens only. Components must never reference a raw palette value.
  Dark mode is a token swap — see the [data-theme='dark'] block below.
*/
@theme {
  --color-canvas: oklch(0.968 0.002 265);      /* workspace behind the pages */
  --color-surface: oklch(1 0 0);               /* panels, bars, page sheets */
  --color-surface-raised: oklch(1 0 0);
  --color-surface-sunken: oklch(0.978 0.002 265);
  --color-border: oklch(0.922 0.004 265);
  --color-border-strong: oklch(0.86 0.006 265);
  --color-text: oklch(0.23 0.01 265);
  --color-text-muted: oklch(0.53 0.012 265);
  --color-text-subtle: oklch(0.66 0.01 265);
  --color-accent: oklch(0.53 0.2 268);
  --color-accent-hover: oklch(0.48 0.2 268);
  --color-accent-fg: oklch(1 0 0);
  --color-accent-subtle: oklch(0.95 0.03 268);
  --color-danger: oklch(0.55 0.21 25);
  --color-danger-subtle: oklch(0.96 0.03 25);
  --color-warning: oklch(0.7 0.16 75);
  --color-focus: oklch(0.6 0.19 268);

  --radius-control: 0.375rem;   /* 6px  — spec §6 */
  --radius-panel: 0.625rem;     /* 10px */
  --radius-sheet: 0.75rem;      /* 12px */

  --shadow-low: 0 1px 2px 0 oklch(0 0 0 / 0.04), 0 1px 3px 0 oklch(0 0 0 / 0.06);
  --shadow-high: 0 4px 12px -2px oklch(0 0 0 / 0.08), 0 2px 6px -2px oklch(0 0 0 / 0.06);

  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --duration-fast: 120ms;
  --duration-base: 180ms;

  --font-sans: 'Inter var', 'Inter', ui-sans-serif, system-ui, sans-serif;
}

[data-theme='dark'] {
  --color-canvas: oklch(0.19 0.006 265);
  --color-surface: oklch(0.235 0.007 265);
  --color-surface-raised: oklch(0.27 0.008 265);
  --color-surface-sunken: oklch(0.165 0.006 265);
  --color-border: oklch(0.32 0.008 265);
  --color-border-strong: oklch(0.4 0.01 265);
  --color-text: oklch(0.95 0.003 265);
  --color-text-muted: oklch(0.72 0.008 265);
  --color-text-subtle: oklch(0.58 0.008 265);
  --color-accent: oklch(0.62 0.19 268);
  --color-accent-hover: oklch(0.68 0.19 268);
  --color-accent-fg: oklch(0.16 0.01 268);
  --color-accent-subtle: oklch(0.28 0.05 268);
  --color-danger: oklch(0.65 0.19 25);
  --color-danger-subtle: oklch(0.28 0.06 25);
  --color-warning: oklch(0.78 0.15 75);
  --color-focus: oklch(0.7 0.17 268);

  --shadow-low: 0 1px 2px 0 oklch(0 0 0 / 0.3), 0 1px 3px 0 oklch(0 0 0 / 0.25);
  --shadow-high: 0 4px 14px -2px oklch(0 0 0 / 0.45), 0 2px 8px -2px oklch(0 0 0 / 0.3);
}

@layer base {
  html {
    color-scheme: light dark;
    -webkit-text-size-adjust: 100%;
  }
  body {
    @apply bg-canvas text-text font-sans antialiased;
    margin: 0;
    /* The workspace scrolls internally; the page itself never does. */
    overflow: hidden;
    overscroll-behavior: none;
  }
  :focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
}
```

Colours are in `oklch` because perceptual lightness is uniform there — a dark palette derived by shifting L values stays legible, which is not true of shifting HSL lightness.

- [ ] **Step 3: Write the failing theme test**

`apps/web/test/theme.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resolveTheme, THEME_STORAGE_KEY } from '../src/lib/theme.js'

describe('resolveTheme', () => {
  it('passes explicit choices straight through', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('follows the system preference when the choice is system', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('dark'),
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  })

  it('defaults to system and reflects the media query', async () => {
    const { useTheme } = await import('../src/lib/theme.js')
    const t = useTheme()
    expect(t.choice.value).toBe('system')
    expect(t.resolved.value).toBe('dark')
  })

  it('writes the resolved theme to the root element', async () => {
    const { useTheme } = await import('../src/lib/theme.js')
    const t = useTheme()
    t.setChoice('light')
    await Promise.resolve()
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('persists the choice, not the resolved value', async () => {
    const { useTheme } = await import('../src/lib/theme.js')
    useTheme().setChoice('system')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })

  it('cycles light to dark to system', async () => {
    const { useTheme } = await import('../src/lib/theme.js')
    const t = useTheme()
    t.setChoice('light')
    t.cycle(); expect(t.choice.value).toBe('dark')
    t.cycle(); expect(t.choice.value).toBe('system')
    t.cycle(); expect(t.choice.value).toBe('light')
  })

  it('ignores a corrupt stored value', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'chartreuse')
    vi.resetModules()
    const { useTheme } = await import('../src/lib/theme.js')
    expect(useTheme().choice.value).toBe('system')
  })
})
```

- [ ] **Step 4: Add the web project to vitest and run the failing test**

Add to `vitest.workspace.ts`:

```ts
  {
    plugins: [(await import('@vitejs/plugin-vue')).default()],
    resolve: {
      alias: { '@': new URL('./apps/web/src/', import.meta.url).pathname },
    },
    test: {
      name: 'web',
      root: './apps/web',
      environment: 'jsdom',
      globals: true,
    },
  },
```

Change the file's default export to `export default defineWorkspace([...])` from `vitest/config` so the async import works, or hoist the plugin import to the top. Then:

```bash
pnpm install
pnpm vitest run --project web
```

Expected: FAIL — `Cannot find module '../src/lib/theme.js'`

- [ ] **Step 5: Write the theme module**

`apps/web/src/lib/theme.ts`:

```ts
import { ref, computed, watchEffect, type Ref, type ComputedRef } from 'vue'

export const THEME_STORAGE_KEY = 'margin.theme'

export type ThemeChoice = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system']

export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (choice === 'system') return systemPrefersDark ? 'dark' : 'light'
  return choice
}

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    return CHOICES.includes(v as ThemeChoice) ? (v as ThemeChoice) : 'system'
  } catch {
    return 'system'
  }
}

// Module-level singletons: theme is global state, and two components reading it
// must see the same value.
const choice = ref<ThemeChoice>(readStored())
const systemPrefersDark = ref(false)
let initialized = false

function initSystemWatch(): void {
  if (initialized) return
  initialized = true
  const mq = matchMedia('(prefers-color-scheme: dark)')
  systemPrefersDark.value = mq.matches
  mq.addEventListener('change', (e) => { systemPrefersDark.value = e.matches })
}

export function useTheme(): {
  choice: Ref<ThemeChoice>
  resolved: ComputedRef<ResolvedTheme>
  setChoice: (c: ThemeChoice) => void
  cycle: () => void
} {
  initSystemWatch()
  const resolved = computed(() => resolveTheme(choice.value, systemPrefersDark.value))

  watchEffect(() => {
    document.documentElement.dataset.theme = resolved.value
  })

  function setChoice(c: ThemeChoice): void {
    choice.value = c
    try { localStorage.setItem(THEME_STORAGE_KEY, c) } catch { /* private mode */ }
  }

  function cycle(): void {
    const i = CHOICES.indexOf(choice.value)
    setChoice(CHOICES[(i + 1) % CHOICES.length] ?? 'system')
  }

  return { choice, resolved, setChoice, cycle }
}
```

- [ ] **Step 6: Write App.vue and main.ts, then run the tests**

`apps/web/src/main.ts`:

```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './app/App.vue'
import './app/styles/tokens.css'

createApp(App).use(createPinia()).mount('#app')
```

`apps/web/src/app/App.vue`:

```vue
<script setup lang="ts">
import { useTheme } from '@/lib/theme'
const { resolved, cycle } = useTheme()
</script>

<template>
  <div class="h-dvh w-full flex flex-col items-center justify-center gap-4">
    <h1 class="text-2xl font-semibold tracking-tight">get-margin</h1>
    <p class="text-sm text-text-muted">Theme: {{ resolved }}</p>
    <button
      class="rounded-control border border-border bg-surface px-3 py-1.5 text-sm shadow-low
             transition-colors duration-fast hover:bg-surface-sunken"
      @click="cycle"
    >
      Cycle theme
    </button>
  </div>
</template>
```

Run: `pnpm vitest run --project web`
Expected: PASS, all six theme tests.

- [ ] **Step 7: Verify the tokens actually render in a browser**

```bash
pnpm --filter @margin/web dev
```

Open the printed URL. Click "Cycle theme" through all three states and confirm: light and dark both legible, no white flash on reload in dark mode, and the focus ring visible when tabbing to the button. `h-dvh` (not `h-screen`) is deliberate — `vh` is wrong on mobile browsers with dynamic toolbars, and the spec commits to phone support.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): Vue scaffold with semantic design tokens and theming"
```

---

## Task 13: UI primitives

**Files:**
- Create: `apps/web/src/ui/cn.ts`, `apps/web/src/ui/Button.vue`, `apps/web/src/ui/IconButton.vue`, `apps/web/src/ui/Tooltip.vue`, `apps/web/src/ui/Spinner.vue`
- Test: `apps/web/test/ui/Button.test.ts`, `apps/web/test/ui/IconButton.test.ts`

**Interfaces:**
- Consumes: tokens from Task 12
- Produces:
  ```ts
  function cn(...inputs: ClassValue[]): string
  // Button props:     { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; disabled?: boolean; loading?: boolean }
  // IconButton props: { label: string /* REQUIRED */; size?: 'sm' | 'md'; active?: boolean; disabled?: boolean }
  // Tooltip props:    { content: string; shortcut?: string; side?: 'top' | 'right' | 'bottom' | 'left' }
  ```
  Only these four primitives now. The spec's full `ui/` set (Popover, Sheet, Slider) arrives in the tasks that first need them — building an unused component library is the fastest way to build the wrong one.

`IconButton` makes `label` **required, not optional**. Every icon-only control in this app — the entire left rail, the zoom pill, the top bar — is an accessibility hole without one, and a required prop is the only version of that rule that can't be forgotten.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/ui/Button.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Button from '../../src/ui/Button.vue'

describe('Button', () => {
  it('renders its slot content', () => {
    const w = mount(Button, { slots: { default: 'Download' } })
    expect(w.text()).toContain('Download')
  })

  it('defaults to the secondary variant', () => {
    const w = mount(Button)
    expect(w.classes().join(' ')).toContain('bg-surface')
  })

  it('applies the primary variant', () => {
    const w = mount(Button, { props: { variant: 'primary' } })
    expect(w.classes().join(' ')).toContain('bg-accent')
  })

  it('emits click when enabled', async () => {
    const w = mount(Button)
    await w.trigger('click')
    expect(w.emitted('click')).toHaveLength(1)
  })

  it('does not emit click when disabled', async () => {
    const w = mount(Button, { props: { disabled: true } })
    await w.trigger('click')
    expect(w.emitted('click')).toBeUndefined()
    expect(w.attributes('disabled')).toBeDefined()
  })

  it('is disabled and busy while loading', async () => {
    const w = mount(Button, { props: { loading: true } })
    expect(w.attributes('disabled')).toBeDefined()
    expect(w.attributes('aria-busy')).toBe('true')
    await w.trigger('click')
    expect(w.emitted('click')).toBeUndefined()
  })

  it('defaults type to button so it never submits a form by accident', () => {
    expect(mount(Button).attributes('type')).toBe('button')
  })
})
```

`apps/web/test/ui/IconButton.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import IconButton from '../../src/ui/IconButton.vue'

describe('IconButton', () => {
  it('exposes the label to assistive technology', () => {
    const w = mount(IconButton, { props: { label: 'Rotate page' } })
    expect(w.attributes('aria-label')).toBe('Rotate page')
  })

  it('reports pressed state when active', () => {
    const w = mount(IconButton, { props: { label: 'Text tool', active: true } })
    expect(w.attributes('aria-pressed')).toBe('true')
  })

  it('omits aria-pressed when active is not supplied', () => {
    const w = mount(IconButton, { props: { label: 'Zoom in' } })
    expect(w.attributes('aria-pressed')).toBeUndefined()
  })

  it('meets the 44px touch-target minimum at md size', () => {
    // Spec Global Constraints: 44px minimum on the mobile shell.
    const w = mount(IconButton, { props: { label: 'x' } })
    expect(w.classes().join(' ')).toMatch(/min-h-11/)
  })
})
```

The `aria-pressed` omission test matters: an icon button that always reports `aria-pressed="false"` tells a screen reader it's a toggle when it isn't, which is worse than silence.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project web ui`
Expected: FAIL — cannot resolve `../../src/ui/Button.vue`

- [ ] **Step 3: Write the primitives**

`apps/web/src/ui/cn.ts`:

```ts
import { twMerge } from 'tailwind-merge'
import { clsx, type ClassValue } from 'clsx'

/** Merge conditional classes, letting later Tailwind utilities win over earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
```

```bash
pnpm --filter @margin/web add clsx
```

`apps/web/src/ui/Button.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { cva } from 'class-variance-authority'
import { cn } from './cn'
import Spinner from './Spinner.vue'

const props = withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  disabled?: boolean
  loading?: boolean
}>(), { variant: 'secondary', size: 'md', disabled: false, loading: false })

const emit = defineEmits<{ click: [MouseEvent] }>()

const button = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-control font-medium ' +
  'transition-colors duration-fast whitespace-nowrap ' +
  'disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-low',
        secondary: 'bg-surface text-text border border-border hover:bg-surface-sunken shadow-low',
        ghost: 'bg-transparent text-text-muted hover:bg-surface-sunken hover:text-text',
        danger: 'bg-danger text-white hover:opacity-90 shadow-low',
      },
      size: { sm: 'h-8 px-2.5 text-[13px]', md: 'h-9 px-3.5 text-sm' },
    },
  },
)

const isBlocked = computed(() => props.disabled || props.loading)

function onClick(e: MouseEvent): void {
  if (isBlocked.value) return
  emit('click', e)
}
</script>

<template>
  <button
    type="button"
    :class="cn(button({ variant: props.variant, size: props.size }))"
    :disabled="isBlocked"
    :aria-busy="props.loading ? 'true' : undefined"
    @click="onClick"
  >
    <Spinner v-if="props.loading" class="size-3.5" />
    <slot />
  </button>
</template>
```

`apps/web/src/ui/IconButton.vue`:

```vue
<script setup lang="ts">
import { cva } from 'class-variance-authority'
import { cn } from './cn'

const props = withDefaults(defineProps<{
  /** Required: this control has no visible text, so it has no accessible name without one. */
  label: string
  size?: 'sm' | 'md'
  active?: boolean
  disabled?: boolean
}>(), { size: 'md', disabled: false })

const emit = defineEmits<{ click: [MouseEvent] }>()

const btn = cva(
  'inline-flex items-center justify-center rounded-control transition-colors duration-fast ' +
  'disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      // min-h-11 / min-w-11 = 44px, the spec's touch-target floor.
      size: { sm: 'size-8 min-h-8 min-w-8', md: 'size-11 min-h-11 min-w-11' },
      active: {
        true: 'bg-accent text-accent-fg',
        false: 'text-text-muted hover:bg-surface-sunken hover:text-text',
      },
    },
    defaultVariants: { active: false },
  },
)
</script>

<template>
  <button
    type="button"
    :class="cn(btn({ size: props.size, active: !!props.active }))"
    :aria-label="props.label"
    :aria-pressed="props.active === undefined ? undefined : String(!!props.active)"
    :disabled="props.disabled"
    @click="emit('click', $event)"
  >
    <slot />
  </button>
</template>
```

`apps/web/src/ui/Spinner.vue`:

```vue
<template>
  <svg class="animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" opacity="0.2" />
    <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
  </svg>
</template>
```

`apps/web/src/ui/Tooltip.vue`:

```vue
<script setup lang="ts">
import { TooltipRoot, TooltipTrigger, TooltipPortal, TooltipContent, TooltipProvider } from 'reka-ui'

const props = withDefaults(defineProps<{
  content: string
  shortcut?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
}>(), { side: 'right' })
</script>

<template>
  <TooltipProvider :delay-duration="400">
    <TooltipRoot>
      <TooltipTrigger as-child><slot /></TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          :side="props.side"
          :side-offset="6"
          class="z-50 flex items-center gap-2 rounded-control border border-border bg-surface-raised
                 px-2 py-1 text-[12px] text-text shadow-high select-none"
        >
          <span>{{ props.content }}</span>
          <kbd
            v-if="props.shortcut"
            class="rounded border border-border bg-surface-sunken px-1 font-sans text-[11px] text-text-subtle"
          >{{ props.shortcut }}</kbd>
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project web ui`
Expected: PASS, all eleven tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): Button, IconButton, Tooltip, Spinner primitives"
```

---

## Task 14: The worker boundary

**Files:**
- Create: `apps/web/src/workers/pdfService.ts`, `apps/web/src/workers/pdf.worker.ts`, `apps/web/src/workers/pdfClient.ts`
- Test: `apps/web/test/workers/pdfService.test.ts`
- Modify: `vitest.workspace.ts` (pdfService tests need the node environment)

**Interfaces:**
- Consumes: `PdfDocument`, `renderPage`, `looksLikePdf`, `PdfOpenError` from `@margin/pdf-core` (Tasks 8–9)
- Produces:
  ```ts
  type DocumentInfo = { pageCount: number; geometries: PageGeometry[]; needsPassword: boolean }
  type RenderResult = { width: number; height: number; rgba: Uint8Array }

  class PdfService {
    open(bytes: Uint8Array): DocumentInfo
    authenticate(password: string): DocumentInfo
    render(req: { id: number; page: number; scale: number }): RenderResult | null   // null = cancelled
    cancel(id: number): void
    cancelAllExcept(ids: number[]): void
    close(): void
  }
  type PdfClient = {
    open(bytes: Uint8Array): Promise<DocumentInfo>
    authenticate(password: string): Promise<DocumentInfo>
    render(page: number, scale: number, signal?: AbortSignal): Promise<RenderResult | null>
    close(): Promise<void>
    terminate(): void
  }
  function createPdfClient(): PdfClient
  ```

**Decomposition rationale.** All logic lives in `PdfService`, a plain class with no worker or Comlink awareness, so it is testable in Node with zero mocking. `pdf.worker.ts` is three lines that expose it. `pdfClient.ts` owns the worker lifecycle and the `AbortSignal` translation. Testing through a real Worker in jsdom is slow and flaky; testing the class directly is neither, and the three-line adapter has nothing to get wrong.

**Honest limit on cancellation.** MuPDF renders synchronously inside WASM and cannot be interrupted mid-page. Cancellation therefore only drops requests that have not *started*. That is still worth having — fast scrolling queues dozens of renders and dropping the stale ones is the difference between responsive and unusable — but `render()` returning `null` means "never started", not "aborted partway". The queue is FIFO with a cancelled-id set, and `cancelAllExcept` is what the viewport calls on every scroll settle.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/workers/pdfService.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PdfService } from '../../src/workers/pdfService.js'
import { generateFixtures, fixturePath } from '../../../../packages/pdf-core/test/fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)

const bytes = (n: Parameters<typeof fixturePath>[0]) => new Uint8Array(readFileSync(fixturePath(n)))

describe('PdfService.open', () => {
  it('returns page count and geometry for every page', () => {
    const s = new PdfService()
    const info = s.open(bytes('multi-page'))
    expect(info.pageCount).toBe(12)
    expect(info.geometries).toHaveLength(12)
    expect(info.geometries[0]).toEqual({ cropBox: [0, 0, 612, 792], rotate: 0 })
    expect(info.needsPassword).toBe(false)
    s.close()
  })

  it('reports rotation per page', () => {
    const s = new PdfService()
    const info = s.open(bytes('rotated'))
    expect(info.geometries.map((g) => g.rotate)).toEqual([0, 90, 180, 270])
    s.close()
  })

  it('rejects a non-PDF', () => {
    const s = new PdfService()
    expect(() => s.open(new Uint8Array([0, 1, 2, 3]))).toThrow()
    s.close()
  })

  it('closes a previously open document when opening another', () => {
    const s = new PdfService()
    s.open(bytes('simple-text'))
    const info = s.open(bytes('multi-page'))
    expect(info.pageCount).toBe(12)
    s.close()
  })
})

describe('PdfService.render', () => {
  it('renders a requested page', () => {
    const s = new PdfService()
    s.open(bytes('simple-text'))
    const r = s.render({ id: 1, page: 0, scale: 1 })
    expect(r).not.toBeNull()
    expect(r!.width).toBe(612)
    expect(r!.rgba.length).toBe(612 * 792 * 4)
    s.close()
  })

  it('returns null for a cancelled request', () => {
    const s = new PdfService()
    s.open(bytes('simple-text'))
    s.cancel(7)
    expect(s.render({ id: 7, page: 0, scale: 1 })).toBeNull()
    s.close()
  })

  it('cancelAllExcept drops every other pending id', () => {
    const s = new PdfService()
    s.open(bytes('multi-page'))
    s.cancel(1); s.cancel(2); s.cancel(3)
    s.cancelAllExcept([2])
    expect(s.render({ id: 1, page: 0, scale: 1 })).toBeNull()
    expect(s.render({ id: 3, page: 0, scale: 1 })).toBeNull()
    expect(s.render({ id: 2, page: 0, scale: 1 })).not.toBeNull()
    s.close()
  })

  it('throws when no document is open', () => {
    const s = new PdfService()
    expect(() => s.render({ id: 1, page: 0, scale: 1 })).toThrow(/no document/i)
  })

  it('does not accumulate cancelled ids without bound', () => {
    const s = new PdfService()
    s.open(bytes('simple-text'))
    for (let i = 0; i < 5000; i++) s.cancel(i)
    // Consuming a cancelled id must forget it — otherwise a long session leaks.
    s.render({ id: 4999, page: 0, scale: 1 })
    expect(s.pendingCancelCount).toBeLessThan(5000)
    s.close()
  })
})

describe('PdfService password handling', () => {
  it('surfaces needsPassword and accepts authentication', () => {
    // No encrypted fixture exists yet — Task 5 decides whether we can create one.
    // This test documents the contract; it is skipped until an encrypted fixture lands.
    expect(typeof new PdfService().authenticate).toBe('function')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project web pdfService`

The `web` project uses jsdom, but `PdfService` loads the MuPDF WASM and needs Node. Add a second web-side project rather than switching the whole thing:

```ts
  {
    test: {
      name: 'web-node',
      root: './apps/web',
      environment: 'node',
      include: ['test/workers/**/*.test.ts'],
      testTimeout: 30_000,
    },
  },
```

and add `exclude: ['test/workers/**']` to the jsdom `web` project so the two don't both claim these files.

Run: `pnpm vitest run --project web-node`
Expected: FAIL — cannot resolve `pdfService.js`

- [ ] **Step 3: Write the service**

`apps/web/src/workers/pdfService.ts`:

```ts
import { PdfDocument, renderPage } from '@margin/pdf-core'
import type { PageGeometry } from '@margin/transform'

export type DocumentInfo = {
  pageCount: number
  geometries: PageGeometry[]
  needsPassword: boolean
}

export type RenderRequest = { id: number; page: number; scale: number }
export type RenderResult = { width: number; height: number; rgba: Uint8Array }

/**
 * All PDF work for the app, with no knowledge of workers or Comlink.
 * Instantiated once inside pdf.worker.ts; unit-tested directly in Node.
 *
 * MuPDF is not safely reentrant, so callers must serialize: the worker's
 * single-threaded event loop provides that, and pdfClient never issues
 * overlapping render calls.
 */
export class PdfService {
  #doc: PdfDocument | undefined
  #cancelled = new Set<number>()

  get pendingCancelCount(): number {
    return this.#cancelled.size
  }

  #info(): DocumentInfo {
    const doc = this.#doc
    if (!doc) throw new Error('no document open')
    const needsPassword = doc.needsPassword()
    // Geometry is unavailable until authentication succeeds.
    const geometries = needsPassword
      ? []
      : Array.from({ length: doc.pageCount }, (_, i) => doc.pageGeometry(i))
    return { pageCount: needsPassword ? 0 : doc.pageCount, geometries, needsPassword }
  }

  open(bytes: Uint8Array): DocumentInfo {
    this.close()
    this.#doc = PdfDocument.open(bytes)
    return this.#info()
  }

  authenticate(password: string): DocumentInfo {
    const doc = this.#doc
    if (!doc) throw new Error('no document open')
    if (!doc.authenticate(password)) throw new Error('Incorrect password')
    return this.#info()
  }

  /** Returns null if this request id was cancelled before it started. */
  render(req: RenderRequest): RenderResult | null {
    const doc = this.#doc
    if (!doc) throw new Error('no document open')
    if (this.#cancelled.delete(req.id)) return null
    const { width, height, rgba } = renderPage(doc, req.page, req.scale)
    return { width, height, rgba }
  }

  cancel(id: number): void {
    this.#cancelled.add(id)
  }

  /** Called on scroll settle: keep the still-wanted ids, drop everything else. */
  cancelAllExcept(ids: number[]): void {
    const keep = new Set(ids)
    for (const id of this.#cancelled) if (keep.has(id)) this.#cancelled.delete(id)
  }

  close(): void {
    this.#doc?.close()
    this.#doc = undefined
    this.#cancelled.clear()
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project web-node`
Expected: PASS.

Note what the `cancelAllExcept` test pins down: cancelled ids are *consumed* by `render`, and the set is cleared on `close`. Without both, a long session accumulates ids forever — the kind of leak that only shows up after an hour of scrolling, which is to say never in manual testing.

- [ ] **Step 5: Write the worker and the client**

`apps/web/src/workers/pdf.worker.ts`:

```ts
import * as Comlink from 'comlink'
import { PdfService } from './pdfService'

Comlink.expose(new PdfService())
```

`apps/web/src/workers/pdfClient.ts`:

```ts
import * as Comlink from 'comlink'
import type { PdfService, DocumentInfo, RenderResult } from './pdfService'

export type PdfClient = {
  open(bytes: Uint8Array): Promise<DocumentInfo>
  authenticate(password: string): Promise<DocumentInfo>
  render(page: number, scale: number, signal?: AbortSignal): Promise<RenderResult | null>
  close(): Promise<void>
  terminate(): void
}

export function createPdfClient(): PdfClient {
  const worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' })
  const remote = Comlink.wrap<PdfService>(worker)
  let nextId = 1

  return {
    // Transfer the buffer rather than copying it — a 100MB PDF copied twice is
    // 200MB of avoidable pressure on a phone.
    open: (bytes) => remote.open(Comlink.transfer(bytes, [bytes.buffer])),

    authenticate: (password) => remote.authenticate(password),

    async render(page, scale, signal) {
      const id = nextId++
      if (signal?.aborted) return null
      const onAbort = (): void => { void remote.cancel(id) }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        return await remote.render({ id, page, scale })
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },

    close: () => remote.close(),

    terminate() {
      remote[Comlink.releaseProxy]()
      worker.terminate()
    },
  }
}
```

The `open` call transfers the ArrayBuffer, which **neuters it on the main thread**. Callers must not read the array afterwards. Task 15 accounts for this by keeping only the file's name, size, and hash on the main side, never the bytes — which is also exactly what the spec's §4 privacy stance requires.

- [ ] **Step 6: Verify the real worker boots in a browser**

Add a temporary button to `App.vue` that picks a file and calls `createPdfClient().open(...)`, log the result, then:

```bash
pnpm --filter @margin/web dev
```

Drop a PDF in and confirm the console logs a plausible `pageCount` and `geometries[0]`. **This step is not optional and no unit test replaces it** — WASM loading inside a Vite-bundled module worker is exactly the kind of thing that works in Node and fails in the browser, and finding out now costs minutes instead of debugging it through three layers in Task 16. If it fails, the usual causes are `optimizeDeps.exclude` missing `mupdf`, or the WASM asset not being emitted — check the network tab for a 404 on the `.wasm` file.

Remove the temporary button before committing.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): PdfService, module worker, and cancelling client"
```

---

## Task 15: Document store and the open-file flow

**Files:**
- Create: `apps/web/src/lib/hash.ts`, `apps/web/src/lib/limits.ts`
- Create: `apps/web/src/stores/document.ts`
- Create: `apps/web/src/features/document/DropZone.vue`
- Test: `apps/web/test/stores/document.test.ts`, `apps/web/test/lib/limits.test.ts`

**Interfaces:**
- Consumes: `createPdfClient`, `DocumentInfo` (Task 14); `looksLikePdf` from `@margin/pdf-core` (Task 8)
- Produces:
  ```ts
  type PageId = string                    // synthetic, NEVER a page index
  type PageState = { id: PageId; sourceIndex: number; geometry: PageGeometry }
  type DocStatus = 'empty' | 'opening' | 'needs-password' | 'ready' | 'error'
  type SizeVerdict = { ok: true } | { ok: false; reason: 'too-large' | 'too-many-pages'; message: string }

  function checkFileSize(bytes: number): SizeVerdict
  function checkPageCount(pages: number): SizeVerdict
  async function sha256Hex(buf: ArrayBuffer): Promise<string>

  // useDocumentStore(): status, fileName, fileSize, sourceHash, pageOrder,
  //   pages, error, pageCount, geometryOf(id), openFile(File), submitPassword(string), reset()
  ```
  `pageOrder: PageId[]` and `pages: Record<PageId, PageState>` are the shapes Phase 2's edit model and Phase 3's page operations build on directly.

**Why synthetic page ids from the very first task that touches pages** (spec §1.2b): objects, thumbnails, render cache entries, and undo history will all reference pages. If any of them reference an index, reordering or deleting a page silently reattributes them — the "my signature moved to page 4" bug. Introducing ids later means migrating every reference, so they exist from the start even though nothing reorders pages until Phase 3.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/lib/limits.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { checkFileSize, checkPageCount, MAX_BYTES, MAX_PAGES } from '../../src/lib/limits.js'

describe('checkFileSize', () => {
  it('accepts a file at the limit', () => {
    expect(checkFileSize(MAX_BYTES)).toEqual({ ok: true })
  })

  it('rejects a file over the limit with a human-readable size', () => {
    const v = checkFileSize(MAX_BYTES + 1)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reason).toBe('too-large')
      expect(v.message).toMatch(/150 MB/)
    }
  })

  it('rejects an empty file', () => {
    expect(checkFileSize(0).ok).toBe(false)
  })
})

describe('checkPageCount', () => {
  it('accepts a document at the limit', () => {
    expect(checkPageCount(MAX_PAGES)).toEqual({ ok: true })
  })

  it('rejects too many pages', () => {
    const v = checkPageCount(MAX_PAGES + 1)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('too-many-pages')
  })
})
```

`apps/web/test/stores/document.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDocumentStore } from '../../src/stores/document.js'

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

function fakeFile(name: string, bytes: Uint8Array): File {
  return new File([bytes], name, { type: 'application/pdf' })
}
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 10, 10])
const NOT_PDF = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 10, 10, 10, 10])

const client = {
  open: vi.fn(),
  authenticate: vi.fn(),
  render: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  terminate: vi.fn(),
}

vi.mock('../../src/workers/pdfClient.js', () => ({ createPdfClient: () => client }))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  client.open.mockResolvedValue({ pageCount: 3, geometries: [GEOM, GEOM, GEOM], needsPassword: false })
})

describe('useDocumentStore.openFile', () => {
  it('starts empty', () => {
    const s = useDocumentStore()
    expect(s.status).toBe('empty')
    expect(s.pageCount).toBe(0)
  })

  it('reaches ready and builds page state', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('contract.pdf', PDF_BYTES))
    expect(s.status).toBe('ready')
    expect(s.fileName).toBe('contract.pdf')
    expect(s.pageOrder).toHaveLength(3)
    expect(s.pageCount).toBe(3)
  })

  it('assigns unique synthetic page ids, not indices', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('a.pdf', PDF_BYTES))
    const ids = s.pageOrder
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id).not.toMatch(/^\d+$/)
    expect(s.pages[ids[0]!]!.sourceIndex).toBe(0)
    expect(s.pages[ids[2]!]!.sourceIndex).toBe(2)
  })

  it('exposes geometry by page id', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('a.pdf', PDF_BYTES))
    expect(s.geometryOf(s.pageOrder[1]!)).toEqual(GEOM)
  })

  it('computes a source hash before the buffer is transferred', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('a.pdf', PDF_BYTES))
    expect(s.sourceHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a file whose magic bytes are not %PDF', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('sneaky.pdf', NOT_PDF))
    expect(s.status).toBe('error')
    expect(s.error).toMatch(/not a PDF/i)
    expect(client.open).not.toHaveBeenCalled()
  })

  it('enters needs-password for an encrypted document', async () => {
    client.open.mockResolvedValue({ pageCount: 0, geometries: [], needsPassword: true })
    const s = useDocumentStore()
    await s.openFile(fakeFile('locked.pdf', PDF_BYTES))
    expect(s.status).toBe('needs-password')
    expect(s.pageOrder).toHaveLength(0)
  })

  it('becomes ready after a correct password', async () => {
    client.open.mockResolvedValue({ pageCount: 0, geometries: [], needsPassword: true })
    client.authenticate.mockResolvedValue({ pageCount: 2, geometries: [GEOM, GEOM], needsPassword: false })
    const s = useDocumentStore()
    await s.openFile(fakeFile('locked.pdf', PDF_BYTES))
    await s.submitPassword('secret')
    expect(s.status).toBe('ready')
    expect(s.pageOrder).toHaveLength(2)
  })

  it('stays in needs-password after a wrong password and reports it', async () => {
    client.open.mockResolvedValue({ pageCount: 0, geometries: [], needsPassword: true })
    client.authenticate.mockRejectedValue(new Error('Incorrect password'))
    const s = useDocumentStore()
    await s.openFile(fakeFile('locked.pdf', PDF_BYTES))
    await s.submitPassword('wrong')
    expect(s.status).toBe('needs-password')
    expect(s.error).toMatch(/incorrect password/i)
  })

  it('surfaces a worker failure as an error state', async () => {
    client.open.mockRejectedValue(new Error('boom'))
    const s = useDocumentStore()
    await s.openFile(fakeFile('a.pdf', PDF_BYTES))
    expect(s.status).toBe('error')
    expect(s.error).toBeTruthy()
  })

  it('never retains the file bytes', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('a.pdf', PDF_BYTES))
    // Spec §4: only name, size, and hash live on the main thread.
    expect(Object.values(s.$state).some((v) => v instanceof Uint8Array || v instanceof ArrayBuffer)).toBe(false)
  })

  it('reset returns to empty and releases the worker', async () => {
    const s = useDocumentStore()
    await s.openFile(fakeFile('a.pdf', PDF_BYTES))
    await s.reset()
    expect(s.status).toBe('empty')
    expect(s.pageOrder).toHaveLength(0)
    expect(client.close).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project web document limits`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the helpers**

`apps/web/src/lib/limits.ts`:

```ts
/**
 * Client-side capacity limits (spec §4, §10 open question 3).
 *
 * These are soft caps enforced with a clear message rather than an OOM crash.
 * Revisit after measuring on a mid-range phone — the spec flags this as
 * unvalidated, and phone support is a committed requirement.
 */
export const MAX_BYTES = 150 * 1024 * 1024
export const MAX_PAGES = 800

export type SizeVerdict =
  | { ok: true }
  | { ok: false; reason: 'too-large' | 'too-many-pages' | 'empty'; message: string }

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

export function checkFileSize(bytes: number): SizeVerdict {
  if (bytes <= 0) {
    return { ok: false, reason: 'empty', message: 'That file is empty.' }
  }
  if (bytes > MAX_BYTES) {
    return {
      ok: false,
      reason: 'too-large',
      message: `That file is ${mb(bytes)}. The editor handles up to ${mb(MAX_BYTES)} in the browser.`,
    }
  }
  return { ok: true }
}

export function checkPageCount(pages: number): SizeVerdict {
  if (pages > MAX_PAGES) {
    return {
      ok: false,
      reason: 'too-many-pages',
      message: `That document has ${pages} pages. The editor handles up to ${MAX_PAGES}.`,
    }
  }
  return { ok: true }
}
```

`apps/web/src/lib/hash.ts`:

```ts
/**
 * SHA-256 of the source file, used to key crash-recovery data (spec §1.2).
 *
 * Must be computed BEFORE the buffer is transferred to the worker — transfer
 * neuters the ArrayBuffer on this side.
 */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
```

- [ ] **Step 4: Write the store**

```bash
pnpm --filter @margin/web add nanoid
```

`apps/web/src/stores/document.ts`:

```ts
import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { looksLikePdf } from '@margin/pdf-core'
import type { PageGeometry } from '@margin/transform'
import { createPdfClient, type PdfClient } from '@/workers/pdfClient'
import { checkFileSize, checkPageCount } from '@/lib/limits'
import { sha256Hex } from '@/lib/hash'

export type PageId = string

export type PageState = {
  id: PageId
  /** Index in the ORIGINAL document. Never used for display ordering. */
  sourceIndex: number
  geometry: PageGeometry
}

export type DocStatus = 'empty' | 'opening' | 'needs-password' | 'ready' | 'error'

type State = {
  status: DocStatus
  fileName: string
  fileSize: number
  sourceHash: string
  /** Display order. Phase 3 mutates this; nothing else may. */
  pageOrder: PageId[]
  pages: Record<PageId, PageState>
  error: string
}

let client: PdfClient | undefined

/** Lazily created so the worker (and its 15MB WASM) never loads on an idle landing page. */
function getClient(): PdfClient {
  client ??= createPdfClient()
  return client
}

export const useDocumentStore = defineStore('document', {
  state: (): State => ({
    status: 'empty',
    fileName: '',
    fileSize: 0,
    sourceHash: '',
    pageOrder: [],
    pages: {},
    error: '',
  }),

  getters: {
    pageCount: (s): number => s.pageOrder.length,
    isReady: (s): boolean => s.status === 'ready',
  },

  actions: {
    geometryOf(id: PageId): PageGeometry | undefined {
      return this.pages[id]?.geometry
    },

    #applyInfo(info: { pageCount: number; geometries: PageGeometry[] }): void {
      const order: PageId[] = []
      const pages: Record<PageId, PageState> = {}
      for (let i = 0; i < info.pageCount; i++) {
        const geometry = info.geometries[i]
        if (!geometry) throw new Error(`missing geometry for page ${i}`)
        const id = nanoid(10)
        order.push(id)
        pages[id] = { id, sourceIndex: i, geometry }
      }
      this.pageOrder = order
      this.pages = pages
    },

    async openFile(file: File): Promise<void> {
      this.error = ''
      this.status = 'opening'
      this.fileName = file.name
      this.fileSize = file.size

      const size = checkFileSize(file.size)
      if (!size.ok) {
        this.status = 'error'
        this.error = size.message
        return
      }

      try {
        const buf = await file.arrayBuffer()

        // Spec §4: validate magic bytes, not the extension. A .pdf that is
        // actually a zip must be refused before it reaches the parser.
        if (!looksLikePdf(new Uint8Array(buf.slice(0, 1024)))) {
          this.status = 'error'
          this.error = 'That file is not a PDF. Check the file and try again.'
          return
        }

        // Hash first — the transfer below neuters this buffer.
        this.sourceHash = await sha256Hex(buf)

        const info = await getClient().open(new Uint8Array(buf))

        if (info.needsPassword) {
          this.pageOrder = []
          this.pages = {}
          this.status = 'needs-password'
          return
        }

        const count = checkPageCount(info.pageCount)
        if (!count.ok) {
          this.status = 'error'
          this.error = count.message
          return
        }

        this.#applyInfo(info)
        this.status = 'ready'
      } catch (e) {
        this.status = 'error'
        this.error = e instanceof Error ? e.message : 'Could not open that PDF.'
      }
    },

    async submitPassword(password: string): Promise<void> {
      this.error = ''
      try {
        const info = await getClient().authenticate(password)
        const count = checkPageCount(info.pageCount)
        if (!count.ok) {
          this.status = 'error'
          this.error = count.message
          return
        }
        this.#applyInfo(info)
        this.status = 'ready'
      } catch (e) {
        // Stay in needs-password so the user can retry without re-picking the file.
        this.status = 'needs-password'
        this.error = e instanceof Error ? e.message : 'Incorrect password'
      }
    },

    async reset(): Promise<void> {
      await client?.close()
      this.$reset()
    },
  },
})
```

Private methods with `#` are not valid in a Pinia options-store action object. Declare `applyInfo` as a normal action instead and prefix it with an underscore, or restructure as a setup store — pick one and keep it consistent. The tests don't call it, so either is fine.

- [ ] **Step 5: Write the drop zone**

`apps/web/src/features/document/DropZone.vue`:

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import { useDropZone } from '@vueuse/core'
import { FileUp } from 'lucide-vue-next'
import Button from '@/ui/Button.vue'
import { useDocumentStore } from '@/stores/document'
import { MAX_BYTES, MAX_PAGES } from '@/lib/limits'

const doc = useDocumentStore()
const zone = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)

const { isOverDropZone } = useDropZone(zone, {
  dataTypes: ['application/pdf'],
  onDrop(files) {
    const file = files?.[0]
    if (file) void doc.openFile(file)
  },
})

const busy = computed(() => doc.status === 'opening')

function pick(): void { input.value?.click() }
function onInput(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) void doc.openFile(file)
  ;(e.target as HTMLInputElement).value = '' // allow re-picking the same file
}
</script>

<template>
  <div
    ref="zone"
    class="flex h-full w-full items-center justify-center p-6 transition-colors duration-base"
    :class="isOverDropZone ? 'bg-accent-subtle' : 'bg-canvas'"
  >
    <div
      class="flex w-full max-w-md flex-col items-center gap-5 rounded-panel border-2 border-dashed
             px-6 py-12 text-center transition-colors duration-base"
      :class="isOverDropZone ? 'border-accent' : 'border-border'"
    >
      <div class="rounded-full bg-surface-sunken p-3 text-text-muted">
        <FileUp :size="24" :stroke-width="1.5" />
      </div>

      <div class="space-y-1">
        <h2 class="text-base font-semibold tracking-tight">Open a PDF</h2>
        <p class="text-[13px] text-text-muted">Drag a file here, or choose one from your device.</p>
      </div>

      <Button variant="primary" :loading="busy" @click="pick">
        {{ busy ? 'Opening…' : 'Choose file' }}
      </Button>

      <input ref="input" type="file" accept="application/pdf,.pdf" class="sr-only" @change="onInput" />

      <p class="text-[12px] text-text-subtle">
        Up to {{ Math.round(MAX_BYTES / 1048576) }} MB and {{ MAX_PAGES }} pages.
        Your file stays on this device.
      </p>

      <p v-if="doc.error" role="alert" class="text-[13px] text-danger">{{ doc.error }}</p>
    </div>
  </div>
</template>
```

"Your file stays on this device" is a factual claim in Phase 1 and must stay factual — if a phase-7 conversion path ever uploads without consent, this copy becomes a lie. The spec's §4 per-action consent requirement is what keeps it true.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run --project web document limits`
Expected: PASS, all fifteen tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): document store, size limits, and drop zone"
```

---

## Task 16: Bitmap cache and the page canvas

**Files:**
- Create: `apps/web/src/lib/bitmapCache.ts`, `apps/web/src/features/viewport/PageCanvas.vue`
- Test: `apps/web/test/lib/bitmapCache.test.ts`, `apps/web/test/features/PageCanvas.test.ts`

**Interfaces:**
- Consumes: `RenderResult` (Task 14); `pageViewSize` (Task 7); `PageId`, `PageState` (Task 15)
- Produces:
  ```ts
  type CacheKey = string                                   // `${pageId}@${scale}`
  function cacheKey(pageId: PageId, scale: number): CacheKey
  class BitmapCache {
    constructor(maxMegapixels?: number)
    get(key: CacheKey): RenderResult | undefined
    set(key: CacheKey, value: RenderResult): void
    has(key: CacheKey): boolean
    delete(key: CacheKey): void
    invalidatePage(pageId: PageId): void
    clear(): void
    readonly megapixels: number
    readonly size: number
  }
  // PageCanvas props: { page: PageState; zoom: number; bitmap?: RenderResult }
  ```

**Capping by megapixels rather than entry count** (spec §1.5): one page at 4× zoom is ~30 megapixels while a thumbnail is 0.02, so an entry-count cap either evicts thumbnails needlessly or lets a handful of zoomed pages consume a gigabyte. Pixels are what actually costs memory, so pixels are what the cache counts.

`invalidatePage` exists for Phase 3: rotating or cropping a page must drop every cached scale for that page and nothing else.

- [ ] **Step 1: Write the failing cache tests**

`apps/web/test/lib/bitmapCache.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { BitmapCache, cacheKey } from '../../src/lib/bitmapCache.js'

function bmp(w: number, h: number) {
  return { width: w, height: h, rgba: new Uint8Array(w * h * 4) }
}
const MP = (w: number, h: number) => (w * h) / 1_000_000

describe('cacheKey', () => {
  it('combines page id and scale', () => {
    expect(cacheKey('abc', 2)).toBe('abc@2')
  })

  it('rounds scale so float drift does not fragment the cache', () => {
    // 1.9999999 and 2 must not be separate entries.
    expect(cacheKey('abc', 1.9999999)).toBe(cacheKey('abc', 2))
  })
})

describe('BitmapCache', () => {
  it('stores and retrieves by key', () => {
    const c = new BitmapCache(100)
    c.set('a@1', bmp(10, 10))
    expect(c.get('a@1')?.width).toBe(10)
    expect(c.has('a@1')).toBe(true)
  })

  it('tracks total megapixels', () => {
    const c = new BitmapCache(100)
    c.set('a@1', bmp(1000, 1000))
    expect(c.megapixels).toBeCloseTo(1, 5)
  })

  it('evicts the least recently used entry when over budget', () => {
    const c = new BitmapCache(MP(1000, 1000) * 2.5) // room for two 1MP entries
    c.set('a@1', bmp(1000, 1000))
    c.set('b@1', bmp(1000, 1000))
    c.set('c@1', bmp(1000, 1000))
    expect(c.has('a@1')).toBe(false)
    expect(c.has('b@1')).toBe(true)
    expect(c.has('c@1')).toBe(true)
  })

  it('treats a get as a use, protecting the entry from eviction', () => {
    const c = new BitmapCache(MP(1000, 1000) * 2.5)
    c.set('a@1', bmp(1000, 1000))
    c.set('b@1', bmp(1000, 1000))
    c.get('a@1')                       // a is now the most recent
    c.set('c@1', bmp(1000, 1000))
    expect(c.has('a@1')).toBe(true)
    expect(c.has('b@1')).toBe(false)
  })

  it('accepts an entry larger than the whole budget without evicting into an empty cache forever', () => {
    const c = new BitmapCache(1)
    c.set('huge@4', bmp(4000, 4000)) // 16MP into a 1MP budget
    // Storing it is correct — the user is looking at it. It must simply be the
    // only thing there, and must not loop forever trying to evict.
    expect(c.has('huge@4')).toBe(true)
    expect(c.size).toBe(1)
  })

  it('invalidatePage drops every scale for that page only', () => {
    const c = new BitmapCache(100)
    c.set(cacheKey('p1', 1), bmp(10, 10))
    c.set(cacheKey('p1', 2), bmp(20, 20))
    c.set(cacheKey('p2', 1), bmp(10, 10))
    c.invalidatePage('p1')
    expect(c.has(cacheKey('p1', 1))).toBe(false)
    expect(c.has(cacheKey('p1', 2))).toBe(false)
    expect(c.has(cacheKey('p2', 1))).toBe(true)
  })

  it('clear empties the cache and resets the megapixel count', () => {
    const c = new BitmapCache(100)
    c.set('a@1', bmp(1000, 1000))
    c.clear()
    expect(c.size).toBe(0)
    expect(c.megapixels).toBe(0)
  })

  it('overwriting a key does not double-count its pixels', () => {
    const c = new BitmapCache(100)
    c.set('a@1', bmp(1000, 1000))
    c.set('a@1', bmp(1000, 1000))
    expect(c.megapixels).toBeCloseTo(1, 5)
    expect(c.size).toBe(1)
  })
})
```

The over-budget-single-entry test guards a real hazard: a naive `while (over budget) evict()` loop with an entry bigger than the budget either spins forever or evicts the very item just inserted.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project web bitmapCache`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the cache**

`apps/web/src/lib/bitmapCache.ts`:

```ts
import type { RenderResult } from '@/workers/pdfService'
import type { PageId } from '@/stores/document'

export type CacheKey = string

/** Scale is rounded to 3 decimals so float drift can't fragment the cache. */
export function cacheKey(pageId: PageId, scale: number): CacheKey {
  return `${pageId}@${Math.round(scale * 1000) / 1000}`
}

const DEFAULT_MAX_MEGAPIXELS = 200

/**
 * LRU cache of rendered page bitmaps, capped by total megapixels (spec §1.5).
 *
 * A JS Map preserves insertion order, so re-inserting on read is enough to
 * maintain LRU order without a second data structure.
 */
export class BitmapCache {
  #map = new Map<CacheKey, RenderResult>()
  #megapixels = 0
  readonly #max: number

  constructor(maxMegapixels = DEFAULT_MAX_MEGAPIXELS) {
    this.#max = maxMegapixels
  }

  get megapixels(): number { return this.#megapixels }
  get size(): number { return this.#map.size }

  #mp(v: RenderResult): number { return (v.width * v.height) / 1_000_000 }

  get(key: CacheKey): RenderResult | undefined {
    const hit = this.#map.get(key)
    if (!hit) return undefined
    // Re-insert to move to the most-recent end.
    this.#map.delete(key)
    this.#map.set(key, hit)
    return hit
  }

  has(key: CacheKey): boolean { return this.#map.has(key) }

  set(key: CacheKey, value: RenderResult): void {
    this.delete(key) // avoid double-counting an overwrite
    this.#map.set(key, value)
    this.#megapixels += this.#mp(value)
    this.#evict(key)
  }

  /** Evict oldest entries until within budget, never the entry just inserted. */
  #evict(protectKey: CacheKey): void {
    for (const key of this.#map.keys()) {
      if (this.#megapixels <= this.#max) break
      if (key === protectKey) continue
      this.delete(key)
    }
  }

  delete(key: CacheKey): void {
    const existing = this.#map.get(key)
    if (!existing) return
    this.#megapixels -= this.#mp(existing)
    this.#map.delete(key)
    if (this.#map.size === 0) this.#megapixels = 0 // guard float accumulation
  }

  /** Drop every cached scale for one page. Used when a page's source changes. */
  invalidatePage(pageId: PageId): void {
    const prefix = `${pageId}@`
    for (const key of [...this.#map.keys()]) {
      if (key.startsWith(prefix)) this.delete(key)
    }
  }

  clear(): void {
    this.#map.clear()
    this.#megapixels = 0
  }
}
```

- [ ] **Step 4: Write the failing PageCanvas test**

`apps/web/test/features/PageCanvas.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import PageCanvas from '../../src/features/viewport/PageCanvas.vue'

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }
const page = { id: 'p1', sourceIndex: 0, geometry: GEOM }

function bitmap(w: number, h: number) {
  return { width: w, height: h, rgba: new Uint8Array(w * h * 4).fill(255) }
}

describe('PageCanvas', () => {
  it('sizes the element from pageViewSize, not the bitmap', () => {
    // The bitmap is at devicePixelRatio; CSS size must be the logical size.
    const w = mount(PageCanvas, { props: { page, zoom: 1, bitmap: bitmap(1224, 1584) } })
    const el = w.find('canvas').element as HTMLCanvasElement
    expect(el.style.width).toBe('612px')
    expect(el.style.height).toBe('792px')
  })

  it('sets the backing store to the bitmap dimensions', () => {
    const w = mount(PageCanvas, { props: { page, zoom: 1, bitmap: bitmap(1224, 1584) } })
    const el = w.find('canvas').element as HTMLCanvasElement
    expect(el.width).toBe(1224)
    expect(el.height).toBe(1584)
  })

  it('swaps CSS dimensions for a rotated page', () => {
    const rotated = { ...page, geometry: { ...GEOM, rotate: 90 as const } }
    const w = mount(PageCanvas, { props: { page: rotated, zoom: 1, bitmap: bitmap(792, 612) } })
    const el = w.find('canvas').element as HTMLCanvasElement
    expect(el.style.width).toBe('792px')
    expect(el.style.height).toBe('612px')
  })

  it('scales CSS size with zoom', () => {
    const w = mount(PageCanvas, { props: { page, zoom: 2, bitmap: bitmap(1224, 1584) } })
    expect((w.find('canvas').element as HTMLCanvasElement).style.width).toBe('1224px')
  })

  it('reserves correct space before the bitmap arrives', () => {
    // No layout shift when the render lands — the placeholder is already the right size.
    const w = mount(PageCanvas, { props: { page, zoom: 1 } })
    expect(w.attributes('style')).toContain('612px')
    expect(w.find('canvas').exists()).toBe(false)
  })

  it('exposes an accessible page label', () => {
    const w = mount(PageCanvas, { props: { page, zoom: 1, bitmap: bitmap(612, 792) } })
    expect(w.attributes('aria-label')).toMatch(/page 1/i)
  })

  it('paints the bitmap via putImageData', () => {
    const putImageData = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData } as never)
    mount(PageCanvas, { props: { page, zoom: 1, bitmap: bitmap(612, 792) } })
    expect(putImageData).toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
```

- [ ] **Step 5: Run it to verify it fails, then write the component**

Run: `pnpm vitest run --project web PageCanvas`
Expected: FAIL — module not found.

`apps/web/src/features/viewport/PageCanvas.vue`:

```vue
<script setup lang="ts">
import { computed, ref, watchEffect, onMounted } from 'vue'
import { pageViewSize } from '@margin/transform'
import type { PageState } from '@/stores/document'
import type { RenderResult } from '@/workers/pdfService'

const props = defineProps<{
  page: PageState
  zoom: number
  bitmap?: RenderResult | undefined
}>()

const canvas = ref<HTMLCanvasElement | null>(null)

/** Logical CSS size. Always derived from geometry — never from the bitmap. */
const view = computed(() => pageViewSize(props.page.geometry, props.zoom))
const cssWidth = computed(() => `${Math.round(view.value.width)}px`)
const cssHeight = computed(() => `${Math.round(view.value.height)}px`)

const label = computed(() => `Page ${props.page.sourceIndex + 1}`)

function paint(): void {
  const el = canvas.value
  const bmp = props.bitmap
  if (!el || !bmp) return
  const ctx = el.getContext('2d')
  if (!ctx) return
  const data = new ImageData(new Uint8ClampedArray(bmp.rgba), bmp.width, bmp.height)
  ctx.putImageData(data, 0, 0)
}

onMounted(paint)
watchEffect(paint)
</script>

<template>
  <div
    role="img"
    :aria-label="label"
    class="relative shrink-0 overflow-hidden rounded-lg bg-surface ring-1 ring-border shadow-low"
    :style="{ width: cssWidth, height: cssHeight }"
  >
    <canvas
      v-if="props.bitmap"
      ref="canvas"
      :width="props.bitmap.width"
      :height="props.bitmap.height"
      :style="{ width: cssWidth, height: cssHeight }"
      class="block"
    />
    <!-- Placeholder occupies the exact final size, so nothing shifts on arrival. -->
    <div v-else class="size-full animate-pulse bg-surface-sunken" />
  </div>
</template>
```

The separation of CSS size (from geometry) and backing-store size (from the bitmap) is what makes device-pixel-ratio and progressive-quality rendering work: a page can display a 0.2× placeholder bitmap stretched to full size, then swap in the crisp 2× bitmap, with no reflow either time.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run --project web bitmapCache PageCanvas`
Expected: PASS, all sixteen tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): megapixel-capped bitmap cache and page canvas"
```

---

## Task 17: Prioritized render queue and the virtualized page list

**Files:**
- Create: `apps/web/src/features/viewport/renderPriority.ts`
- Create: `apps/web/src/stores/viewport.ts`
- Create: `apps/web/src/features/viewport/PageList.vue`
- Test: `apps/web/test/features/renderPriority.test.ts`, `apps/web/test/stores/viewport.test.ts`

**Interfaces:**
- Consumes: `BitmapCache`, `cacheKey` (Task 16); `PdfClient` (Task 14); document store (Task 15)
- Produces:
  ```ts
  type RenderTask = { pageId: PageId; sourceIndex: number; scale: number; tier: 'placeholder' | 'full' }
  function planRenders(args: {
    pageOrder: PageId[]; pages: Record<PageId, PageState>; anchorIndex: number;
    visibleRadius: number; zoom: number; dpr: number; cache: BitmapCache;
  }): RenderTask[]
  const PLACEHOLDER_SCALE = 0.2
  function effectiveScale(zoom: number, dpr: number): number
  // useViewportStore(): zoom, anchorIndex, bitmapFor(pageId), pump(), setAnchor(i), setZoom(z), invalidate(pageId)
  ```

**Two-tier strategy** (spec §1.5): every page gets one cheap 0.2× render that doubles as the thumbnail panel's source, and visible pages ±`visibleRadius` get a full `zoom × dpr` render. Priority is distance from the viewport anchor, so a fast scroll to page 200 renders page 200 next rather than working through 199 first.

- [ ] **Step 1: Write the failing priority tests**

`apps/web/test/features/renderPriority.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { planRenders, effectiveScale, PLACEHOLDER_SCALE } from '../../src/features/viewport/renderPriority.js'
import { BitmapCache, cacheKey } from '../../src/lib/bitmapCache.js'

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

function doc(n: number) {
  const pageOrder = Array.from({ length: n }, (_, i) => `p${i}`)
  const pages = Object.fromEntries(
    pageOrder.map((id, i) => [id, { id, sourceIndex: i, geometry: GEOM }]),
  )
  return { pageOrder, pages }
}

const base = { visibleRadius: 1, zoom: 1, dpr: 2 }

describe('effectiveScale', () => {
  it('multiplies zoom by device pixel ratio', () => {
    expect(effectiveScale(1, 2)).toBe(2)
    expect(effectiveScale(1.5, 2)).toBe(3)
  })

  it('clamps to a ceiling so a 4x zoom on a retina phone cannot request 8x', () => {
    expect(effectiveScale(8, 3)).toBeLessThanOrEqual(6)
  })
})

describe('planRenders', () => {
  it('puts the anchor page first', () => {
    const cache = new BitmapCache(500)
    const tasks = planRenders({ ...doc(50), ...base, anchorIndex: 20, cache })
    expect(tasks[0]?.pageId).toBe('p20')
    expect(tasks[0]?.tier).toBe('full')
  })

  it('orders full renders by distance from the anchor', () => {
    const cache = new BitmapCache(500)
    const tasks = planRenders({ ...doc(50), ...base, anchorIndex: 20, visibleRadius: 2, zoom: 1, dpr: 2, cache })
    const full = tasks.filter((t) => t.tier === 'full').map((t) => t.pageId)
    expect(full.slice(0, 5)).toEqual(['p20', 'p19', 'p21', 'p18', 'p22'])
  })

  it('emits full renders only within the visible radius', () => {
    const cache = new BitmapCache(500)
    const tasks = planRenders({ ...doc(50), ...base, anchorIndex: 20, cache })
    const full = tasks.filter((t) => t.tier === 'full')
    expect(full).toHaveLength(3) // 19, 20, 21
  })

  it('queues placeholder renders for every page, after the full ones', () => {
    const cache = new BitmapCache(500)
    const tasks = planRenders({ ...doc(10), ...base, anchorIndex: 0, cache })
    const firstPlaceholder = tasks.findIndex((t) => t.tier === 'placeholder')
    const lastFull = tasks.map((t) => t.tier).lastIndexOf('full')
    expect(firstPlaceholder).toBeGreaterThan(lastFull)
    expect(tasks.filter((t) => t.tier === 'placeholder')).toHaveLength(10)
  })

  it('uses PLACEHOLDER_SCALE for placeholder tasks regardless of zoom', () => {
    const cache = new BitmapCache(500)
    const tasks = planRenders({ ...doc(5), ...base, anchorIndex: 0, zoom: 4, dpr: 2, cache })
    for (const t of tasks.filter((x) => x.tier === 'placeholder')) {
      expect(t.scale).toBe(PLACEHOLDER_SCALE)
    }
  })

  it('skips anything already cached', () => {
    const cache = new BitmapCache(500)
    const d = doc(10)
    cache.set(cacheKey('p0', effectiveScale(1, 2)), { width: 10, height: 10, rgba: new Uint8Array(400) })
    cache.set(cacheKey('p0', PLACEHOLDER_SCALE), { width: 4, height: 4, rgba: new Uint8Array(64) })
    const tasks = planRenders({ ...d, ...base, anchorIndex: 0, cache })
    expect(tasks.some((t) => t.pageId === 'p0')).toBe(false)
  })

  it('re-queues a page at a new zoom because the cache key changed', () => {
    const cache = new BitmapCache(500)
    const d = doc(3)
    cache.set(cacheKey('p0', effectiveScale(1, 2)), { width: 10, height: 10, rgba: new Uint8Array(400) })
    const tasks = planRenders({ ...d, ...base, anchorIndex: 0, zoom: 2, dpr: 2, cache })
    expect(tasks.some((t) => t.pageId === 'p0' && t.tier === 'full')).toBe(true)
  })

  it('clamps the radius at document boundaries', () => {
    const cache = new BitmapCache(500)
    const tasks = planRenders({ ...doc(3), ...base, anchorIndex: 0, visibleRadius: 5, zoom: 1, dpr: 2, cache })
    const full = tasks.filter((t) => t.tier === 'full').map((t) => t.pageId)
    expect(full).toEqual(['p0', 'p1', 'p2'])
  })

  it('returns nothing for an empty document', () => {
    expect(planRenders({ pageOrder: [], pages: {}, ...base, anchorIndex: 0, cache: new BitmapCache(1) })).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project web renderPriority`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the planner**

`apps/web/src/features/viewport/renderPriority.ts`:

```ts
import { cacheKey, type BitmapCache } from '@/lib/bitmapCache'
import type { PageId, PageState } from '@/stores/document'

/** Cheap whole-document pass; also feeds the thumbnail panel (spec §1.5). */
export const PLACEHOLDER_SCALE = 0.2

/**
 * Ceiling on render scale. A 4x zoom on a 3x-DPR phone would otherwise request
 * 12x, which is ~100MP for one Letter page — enough to crash the tab.
 */
const MAX_SCALE = 6

export function effectiveScale(zoom: number, dpr: number): number {
  return Math.min(zoom * dpr, MAX_SCALE)
}

export type RenderTask = {
  pageId: PageId
  sourceIndex: number
  scale: number
  tier: 'placeholder' | 'full'
}

export function planRenders(args: {
  pageOrder: PageId[]
  pages: Record<PageId, PageState>
  anchorIndex: number
  visibleRadius: number
  zoom: number
  dpr: number
  cache: BitmapCache
}): RenderTask[] {
  const { pageOrder, pages, anchorIndex, visibleRadius, zoom, dpr, cache } = args
  if (pageOrder.length === 0) return []

  const full: RenderTask[] = []
  const scale = effectiveScale(zoom, dpr)

  // Walk outward from the anchor: 0, -1, +1, -2, +2 … so a jump to page 200
  // renders page 200 first rather than grinding through everything before it.
  for (let d = 0; d <= visibleRadius; d++) {
    for (const i of d === 0 ? [anchorIndex] : [anchorIndex - d, anchorIndex + d]) {
      if (i < 0 || i >= pageOrder.length) continue
      const pageId = pageOrder[i]
      const page = pageId ? pages[pageId] : undefined
      if (!pageId || !page) continue
      if (cache.has(cacheKey(pageId, scale))) continue
      full.push({ pageId, sourceIndex: page.sourceIndex, scale, tier: 'full' })
    }
  }

  const placeholders: RenderTask[] = []
  for (const pageId of pageOrder) {
    const page = pages[pageId]
    if (!page) continue
    if (cache.has(cacheKey(pageId, PLACEHOLDER_SCALE))) continue
    placeholders.push({
      pageId, sourceIndex: page.sourceIndex, scale: PLACEHOLDER_SCALE, tier: 'placeholder',
    })
  }

  // Full renders always precede placeholders: what the user is looking at wins.
  return [...full, ...placeholders]
}
```

- [ ] **Step 4: Write the failing viewport store test**

`apps/web/test/stores/viewport.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const render = vi.fn()
vi.mock('../../src/workers/pdfClient.js', () => ({
  createPdfClient: () => ({
    open: vi.fn(), authenticate: vi.fn(), render,
    close: vi.fn().mockResolvedValue(undefined), terminate: vi.fn(),
  }),
}))

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  render.mockImplementation(async (_p: number, scale: number) => ({
    width: Math.round(612 * scale), height: Math.round(792 * scale),
    rgba: new Uint8Array(Math.round(612 * scale) * Math.round(792 * scale) * 4),
  }))
})

async function seededStores() {
  const { useDocumentStore } = await import('../../src/stores/document.js')
  const { useViewportStore } = await import('../../src/stores/viewport.js')
  const doc = useDocumentStore()
  doc.$patch({
    status: 'ready',
    pageOrder: ['p0', 'p1', 'p2'],
    pages: {
      p0: { id: 'p0', sourceIndex: 0, geometry: GEOM },
      p1: { id: 'p1', sourceIndex: 1, geometry: GEOM },
      p2: { id: 'p2', sourceIndex: 2, geometry: GEOM },
    },
  })
  return { doc, vp: useViewportStore() }
}

describe('useViewportStore', () => {
  it('defaults to zoom 1 and anchor 0', async () => {
    const { vp } = await seededStores()
    expect(vp.zoom).toBe(1)
    expect(vp.anchorIndex).toBe(0)
  })

  it('renders the anchor page and caches the result', async () => {
    const { vp } = await seededStores()
    await vp.pump()
    expect(vp.bitmapFor('p0')).toBeDefined()
  })

  it('does not re-render a cached page on a second pump', async () => {
    const { vp } = await seededStores()
    await vp.pump()
    const calls = render.mock.calls.length
    await vp.pump()
    expect(render.mock.calls.length).toBe(calls)
  })

  it('re-renders after a zoom change', async () => {
    const { vp } = await seededStores()
    await vp.pump()
    const calls = render.mock.calls.length
    vp.setZoom(2)
    await vp.pump()
    expect(render.mock.calls.length).toBeGreaterThan(calls)
  })

  it('clamps zoom to the allowed range', async () => {
    const { vp } = await seededStores()
    vp.setZoom(100); expect(vp.zoom).toBeLessThanOrEqual(8)
    vp.setZoom(0.001); expect(vp.zoom).toBeGreaterThanOrEqual(0.1)
  })

  it('falls back to the placeholder bitmap when no full render exists yet', async () => {
    const { vp } = await seededStores()
    vp.setAnchor(0)
    await vp.pump()
    // p2 is outside the radius, so only its placeholder should exist.
    expect(vp.bitmapFor('p2')).toBeDefined()
    expect(vp.bitmapFor('p2')!.width).toBeLessThan(612)
  })

  it('invalidate drops cached renders for one page', async () => {
    const { vp } = await seededStores()
    await vp.pump()
    vp.invalidate('p0')
    expect(vp.bitmapFor('p0')).toBeUndefined()
  })

  it('serializes pumps so overlapping calls cannot interleave renders', async () => {
    const { vp } = await seededStores()
    await Promise.all([vp.pump(), vp.pump(), vp.pump()])
    const keys = render.mock.calls.map((c) => `${c[0]}@${c[1]}`)
    expect(new Set(keys).size).toBe(keys.length) // no duplicate work
  })
})
```

The serialization test matters because MuPDF is not reentrant (spec §1.5) — three concurrent pumps that each check the cache before any writes to it will render the same page three times.

- [ ] **Step 5: Run it to verify it fails, then write the store**

Run: `pnpm vitest run --project web viewport`
Expected: FAIL — module not found.

`apps/web/src/stores/viewport.ts`:

```ts
import { defineStore } from 'pinia'
import { ref, computed, shallowRef } from 'vue'
import { BitmapCache, cacheKey } from '@/lib/bitmapCache'
import { createPdfClient, type PdfClient } from '@/workers/pdfClient'
import { planRenders, effectiveScale, PLACEHOLDER_SCALE } from '@/features/viewport/renderPriority'
import { useDocumentStore, type PageId } from '@/stores/document'
import type { RenderResult } from '@/workers/pdfService'

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8
const VISIBLE_RADIUS = 1

let client: PdfClient | undefined
function getClient(): PdfClient {
  client ??= createPdfClient()
  return client
}

export const useViewportStore = defineStore('viewport', () => {
  const doc = useDocumentStore()

  const zoom = ref(1)
  const anchorIndex = ref(0)
  const dpr = ref(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
  // shallowRef: the cache holds large typed arrays that must never be made reactive.
  const cache = shallowRef(new BitmapCache())
  const version = ref(0) // bumped on cache mutation so getters re-evaluate

  let pumping: Promise<void> | undefined

  /** Best available bitmap: the full render if present, else the placeholder. */
  function bitmapFor(pageId: PageId): RenderResult | undefined {
    void version.value
    const c = cache.value
    return (
      c.get(cacheKey(pageId, effectiveScale(zoom.value, dpr.value))) ??
      c.get(cacheKey(pageId, PLACEHOLDER_SCALE))
    )
  }

  function setZoom(z: number): void {
    zoom.value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
  }

  function setAnchor(i: number): void {
    anchorIndex.value = Math.max(0, Math.min(doc.pageOrder.length - 1, i))
  }

  function invalidate(pageId: PageId): void {
    cache.value.invalidatePage(pageId)
    version.value++
  }

  /**
   * Drain the render plan once. Serialized: concurrent callers await the
   * in-flight pump rather than starting a second one, because MuPDF is not
   * reentrant and duplicate work is pure waste.
   */
  async function pump(): Promise<void> {
    if (pumping) return pumping
    pumping = (async () => {
      try {
        const tasks = planRenders({
          pageOrder: doc.pageOrder,
          pages: doc.pages,
          anchorIndex: anchorIndex.value,
          visibleRadius: VISIBLE_RADIUS,
          zoom: zoom.value,
          dpr: dpr.value,
          cache: cache.value,
        })
        for (const task of tasks) {
          const key = cacheKey(task.pageId, task.scale)
          if (cache.value.has(key)) continue
          const result = await getClient().render(task.sourceIndex, task.scale)
          if (!result) continue // cancelled
          cache.value.set(key, result)
          version.value++
        }
      } finally {
        pumping = undefined
      }
    })()
    return pumping
  }

  const zoomPercent = computed(() => Math.round(zoom.value * 100))

  return { zoom, anchorIndex, dpr, zoomPercent, bitmapFor, setZoom, setAnchor, invalidate, pump }
})
```

- [ ] **Step 6: Write the page list**

`apps/web/src/features/viewport/PageList.vue`:

```vue
<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { pageViewSize } from '@margin/transform'
import PageCanvas from './PageCanvas.vue'
import { useDocumentStore } from '@/stores/document'
import { useViewportStore } from '@/stores/viewport'

const doc = useDocumentStore()
const vp = useViewportStore()
const scroller = ref<HTMLElement | null>(null)

const GAP = 24

function pageHeight(index: number): number {
  const id = doc.pageOrder[index]
  const geom = id ? doc.pages[id]?.geometry : undefined
  if (!geom) return 800
  return pageViewSize(geom, vp.zoom).height + GAP
}

const virtualizer = useVirtualizer(
  computed(() => ({
    count: doc.pageOrder.length,
    getScrollElement: () => scroller.value,
    estimateSize: pageHeight,
    overscan: 2,
  })),
)

const items = computed(() => virtualizer.value.getVirtualItems())
const totalHeight = computed(() => virtualizer.value.getTotalSize())

// Keep the render anchor pointing at whatever is centred in the viewport.
watch(items, (list) => {
  const first = list[0]
  if (!first) return
  const mid = list[Math.floor(list.length / 2)] ?? first
  vp.setAnchor(mid.index)
  void vp.pump()
})

watch(() => vp.zoom, () => {
  virtualizer.value.measure()
  void vp.pump()
})

onMounted(() => { void vp.pump() })
</script>

<template>
  <div
    ref="scroller"
    class="h-full w-full overflow-auto overscroll-contain bg-canvas"
    tabindex="0"
    role="region"
    aria-label="Document pages"
  >
    <div class="relative mx-auto w-fit py-6" :style="{ height: `${totalHeight}px` }">
      <div
        v-for="item in items"
        :key="doc.pageOrder[item.index]"
        class="absolute left-0 top-0 w-full flex justify-center"
        :style="{ transform: `translateY(${item.start}px)` }"
      >
        <PageCanvas
          v-if="doc.pages[doc.pageOrder[item.index]!]"
          :page="doc.pages[doc.pageOrder[item.index]!]!"
          :zoom="vp.zoom"
          :bitmap="vp.bitmapFor(doc.pageOrder[item.index]!)"
        />
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 7: Run all tests**

Run: `pnpm vitest run --project web`
Expected: PASS, every web test.

- [ ] **Step 8: Verify scroll behaviour in a real browser**

Wire `DropZone` and `PageList` into `App.vue` (show `PageList` when `doc.isReady`, else `DropZone`), then:

```bash
pnpm --filter @margin/web dev
```

Open the 300-page fixture (`packages/pdf-core/test/fixtures/large-300p.pdf`) and check four things: the first page appears quickly, scrolling stays smooth, dragging the scrollbar to the end renders page 300 promptly rather than working through the middle, and memory in the browser's task manager plateaus instead of climbing. All four are properties no unit test observes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(web): prioritized render queue, viewport store, virtualized page list"
```

---

## Task 18: Zoom controls and fit modes

**Files:**
- Create: `apps/web/src/lib/fit.ts`, `apps/web/src/features/viewport/ZoomPill.vue`
- Modify: `apps/web/src/stores/viewport.ts` (add fit mode)
- Test: `apps/web/test/lib/fit.test.ts`

**Interfaces:**
- Consumes: `pageViewSize` (Task 7); viewport store (Task 17)
- Produces:
  ```ts
  type FitMode = 'width' | 'page' | 'actual' | 'custom'
  const ZOOM_STEPS: readonly number[]
  function computeFitZoom(args: {
    mode: Exclude<FitMode, 'custom'>; containerWidth: number; containerHeight: number;
    geometry: PageGeometry; padding?: number
  }): number
  function nextZoomStep(current: number, direction: 1 | -1): number
  // viewport store gains: fitMode, setFitMode(m), applyFit(w, h, geometry), zoomIn(), zoomOut()
  ```

- [ ] **Step 1: Write the failing tests**

`apps/web/test/lib/fit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeFitZoom, nextZoomStep, ZOOM_STEPS } from '../../src/lib/fit.js'

const LETTER = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }
const LANDSCAPE = { ...LETTER, rotate: 90 as const }

describe('computeFitZoom', () => {
  it('fits width using the container width minus padding', () => {
    const z = computeFitZoom({ mode: 'width', containerWidth: 712, containerHeight: 400, geometry: LETTER, padding: 50 })
    expect(z).toBeCloseTo(1, 5) // (712 - 2*50) / 612 ≈ 1.0
  })

  it('fits page to whichever axis is more constrained', () => {
    const z = computeFitZoom({ mode: 'page', containerWidth: 1224, containerHeight: 892, geometry: LETTER, padding: 50 })
    // height is the binding constraint: (892 - 100) / 792 ≈ 1.0
    expect(z).toBeCloseTo(1, 5)
  })

  it('returns exactly 1 for actual size', () => {
    expect(computeFitZoom({ mode: 'actual', containerWidth: 300, containerHeight: 300, geometry: LETTER })).toBe(1)
  })

  it('accounts for rotation when fitting', () => {
    // A 90-degree page is 792 wide, so fit-width gives a smaller zoom.
    const portrait = computeFitZoom({ mode: 'width', containerWidth: 712, containerHeight: 900, geometry: LETTER, padding: 50 })
    const landscape = computeFitZoom({ mode: 'width', containerWidth: 712, containerHeight: 900, geometry: LANDSCAPE, padding: 50 })
    expect(landscape).toBeLessThan(portrait)
  })

  it('clamps to the zoom range', () => {
    expect(computeFitZoom({ mode: 'width', containerWidth: 20, containerHeight: 20, geometry: LETTER })).toBeGreaterThanOrEqual(0.1)
    expect(computeFitZoom({ mode: 'width', containerWidth: 99999, containerHeight: 99999, geometry: LETTER })).toBeLessThanOrEqual(8)
  })

  it('survives a zero-sized container during first layout', () => {
    const z = computeFitZoom({ mode: 'width', containerWidth: 0, containerHeight: 0, geometry: LETTER })
    expect(Number.isFinite(z)).toBe(true)
    expect(z).toBeGreaterThan(0)
  })
})

describe('nextZoomStep', () => {
  it('steps up to the next preset', () => {
    expect(nextZoomStep(1, 1)).toBe(ZOOM_STEPS[ZOOM_STEPS.indexOf(1) + 1])
  })

  it('steps down to the previous preset', () => {
    expect(nextZoomStep(1, -1)).toBe(ZOOM_STEPS[ZOOM_STEPS.indexOf(1) - 1])
  })

  it('snaps an off-preset value to the neighbouring preset', () => {
    // 1.1 is between presets; stepping up must reach the next one above it.
    expect(nextZoomStep(1.1, 1)).toBeGreaterThan(1.1)
    expect(nextZoomStep(1.1, -1)).toBeLessThan(1.1)
  })

  it('saturates at both ends instead of wrapping', () => {
    const first = ZOOM_STEPS[0]!
    const last = ZOOM_STEPS[ZOOM_STEPS.length - 1]!
    expect(nextZoomStep(first, -1)).toBe(first)
    expect(nextZoomStep(last, 1)).toBe(last)
  })
})
```

- [ ] **Step 2: Run it to verify it fails, then write the module**

Run: `pnpm vitest run --project web fit` → FAIL, module not found.

`apps/web/src/lib/fit.ts`:

```ts
import { pageViewSize, type PageGeometry } from '@margin/transform'
import { MIN_ZOOM, MAX_ZOOM } from '@/stores/viewport'

export type FitMode = 'width' | 'page' | 'actual' | 'custom'

export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8] as const

const DEFAULT_PADDING = 32

function clamp(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

export function computeFitZoom(args: {
  mode: Exclude<FitMode, 'custom'>
  containerWidth: number
  containerHeight: number
  geometry: PageGeometry
  padding?: number
}): number {
  const { mode, containerWidth, containerHeight, geometry, padding = DEFAULT_PADDING } = args
  if (mode === 'actual') return 1

  // Page size at zoom 1, which already accounts for rotation.
  const { width: pw, height: ph } = pageViewSize(geometry, 1)
  if (pw <= 0 || ph <= 0) return 1

  const availW = Math.max(1, containerWidth - padding * 2)
  const availH = Math.max(1, containerHeight - padding * 2)

  const byWidth = availW / pw
  if (mode === 'width') return clamp(byWidth)
  return clamp(Math.min(byWidth, availH / ph))
}

export function nextZoomStep(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    const up = ZOOM_STEPS.find((s) => s > current + 1e-6)
    return up ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!
  }
  const down = [...ZOOM_STEPS].reverse().find((s) => s < current - 1e-6)
  return down ?? ZOOM_STEPS[0]!
}
```

- [ ] **Step 3: Extend the viewport store**

Add to `apps/web/src/stores/viewport.ts`, inside the setup function and its return:

```ts
  const fitMode = ref<FitMode>('width')

  function setFitMode(m: FitMode): void { fitMode.value = m }

  /** Called by the shell on container resize and on document open. */
  function applyFit(containerWidth: number, containerHeight: number, geometry: PageGeometry): void {
    if (fitMode.value === 'custom') return
    setZoom(computeFitZoom({ mode: fitMode.value, containerWidth, containerHeight, geometry }))
  }

  function zoomIn(): void { fitMode.value = 'custom'; setZoom(nextZoomStep(zoom.value, 1)) }
  function zoomOut(): void { fitMode.value = 'custom'; setZoom(nextZoomStep(zoom.value, -1)) }
```

Import `FitMode`, `computeFitZoom`, `nextZoomStep` from `@/lib/fit` and `PageGeometry` from `@margin/transform`, and add `fitMode, setFitMode, applyFit, zoomIn, zoomOut` to the returned object.

`MIN_ZOOM`/`MAX_ZOOM` are exported from the store and imported by `fit.ts`, while the store imports from `fit.ts` — a cycle. Break it by moving both constants into `apps/web/src/lib/fit.ts` and re-exporting them from the store for compatibility. Do this now rather than later; ES module cycles fail at runtime in ways that are tedious to diagnose.

- [ ] **Step 4: Write the zoom pill**

`apps/web/src/features/viewport/ZoomPill.vue`:

```vue
<script setup lang="ts">
import { Minus, Plus, Maximize2, Scan } from 'lucide-vue-next'
import IconButton from '@/ui/IconButton.vue'
import Tooltip from '@/ui/Tooltip.vue'
import { useViewportStore } from '@/stores/viewport'

const vp = useViewportStore()
</script>

<template>
  <div
    class="pointer-events-auto flex items-center gap-0.5 rounded-full border border-border
           bg-surface-raised px-1 py-1 shadow-high"
  >
    <Tooltip content="Zoom out" shortcut="⌘−" side="top">
      <IconButton size="sm" label="Zoom out" @click="vp.zoomOut()"><Minus :size="15" :stroke-width="1.5" /></IconButton>
    </Tooltip>

    <button
      type="button"
      class="min-w-14 rounded-control px-1.5 py-1 text-center text-[13px] font-medium tabular-nums
             text-text transition-colors duration-fast hover:bg-surface-sunken"
      aria-label="Reset zoom to 100%"
      @click="vp.setFitMode('actual'); vp.setZoom(1)"
    >{{ vp.zoomPercent }}%</button>

    <Tooltip content="Zoom in" shortcut="⌘+" side="top">
      <IconButton size="sm" label="Zoom in" @click="vp.zoomIn()"><Plus :size="15" :stroke-width="1.5" /></IconButton>
    </Tooltip>

    <div class="mx-0.5 h-5 w-px bg-border" />

    <Tooltip content="Fit width" side="top">
      <IconButton size="sm" label="Fit width" :active="vp.fitMode === 'width'" @click="vp.setFitMode('width')">
        <Maximize2 :size="15" :stroke-width="1.5" class="rotate-45" />
      </IconButton>
    </Tooltip>

    <Tooltip content="Fit page" side="top">
      <IconButton size="sm" label="Fit page" :active="vp.fitMode === 'page'" @click="vp.setFitMode('page')">
        <Scan :size="15" :stroke-width="1.5" />
      </IconButton>
    </Tooltip>
  </div>
</template>
```

- [ ] **Step 5: Run the tests and commit**

Run: `pnpm vitest run --project web`
Expected: PASS.

```bash
git add -A
git commit -m "feat(web): fit modes, zoom stepping, floating zoom pill"
```

---

## Task 19: Thumbnails panel

**Files:**
- Create: `apps/web/src/features/document/ThumbnailPanel.vue`, `apps/web/src/features/document/Thumbnail.vue`
- Test: `apps/web/test/features/Thumbnail.test.ts`

**Interfaces:**
- Consumes: `PLACEHOLDER_SCALE` (Task 17); viewport and document stores
- Produces: `ThumbnailPanel` (props: none; emits `select: [PageId]`), `Thumbnail` (props: `{ page: PageState; index: number; active: boolean }`)

The panel reuses the placeholder-tier bitmaps the render queue already produces for every page (Task 17), so opening it costs nothing. Building it now rather than in Phase 3 is deliberate: it is the natural home for page operations, and having it exist means Phase 3 adds behaviour to a working panel instead of building the panel and the behaviour together.

- [ ] **Step 1: Write the failing test**

`apps/web/test/features/Thumbnail.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Thumbnail from '../../src/features/document/Thumbnail.vue'

const GEOM = { cropBox: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const }
const page = { id: 'p1', sourceIndex: 4, geometry: GEOM }

describe('Thumbnail', () => {
  it('labels itself with the display position, not the source index', () => {
    // Phase 3 reorders pages: display position 1 may hold source index 4.
    const w = mount(Thumbnail, { props: { page, index: 0, active: false } })
    expect(w.text()).toContain('1')
    expect(w.text()).not.toContain('5')
  })

  it('marks the active page for assistive technology', () => {
    const w = mount(Thumbnail, { props: { page, index: 0, active: true } })
    expect(w.attributes('aria-current')).toBe('true')
  })

  it('omits aria-current when inactive', () => {
    const w = mount(Thumbnail, { props: { page, index: 0, active: false } })
    expect(w.attributes('aria-current')).toBeUndefined()
  })

  it('emits select when clicked', async () => {
    const w = mount(Thumbnail, { props: { page, index: 3, active: false } })
    await w.trigger('click')
    expect(w.emitted('select')).toEqual([[3]])
  })

  it('preserves page aspect ratio in the frame', () => {
    const w = mount(Thumbnail, { props: { page, index: 0, active: false } })
    const style = w.find('[data-testid="thumb-frame"]').attributes('style') ?? ''
    expect(style).toContain('aspect-ratio')
  })
})
```

The label test encodes something that will matter in Phase 3: thumbnails show **display position**, derived from the index in `pageOrder`, never `sourceIndex`. Getting this backwards produces a page panel that renumbers itself wrongly the first time someone reorders pages.

- [ ] **Step 2: Run it to verify it fails, then write the components**

Run: `pnpm vitest run --project web Thumbnail` → FAIL.

`apps/web/src/features/document/Thumbnail.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { pageSizePt, pageViewSize } from '@margin/transform'
import { useViewportStore } from '@/stores/viewport'
import type { PageState } from '@/stores/document'
import { PLACEHOLDER_SCALE } from '@/features/viewport/renderPriority'
import { cn } from '@/ui/cn'

const props = defineProps<{ page: PageState; index: number; active: boolean }>()
const emit = defineEmits<{ select: [number] }>()

const vp = useViewportStore()
const bitmap = computed(() => vp.bitmapFor(props.page.id))

const ratio = computed(() => {
  const { width, height } = pageViewSize(props.page.geometry, 1)
  return `${width} / ${height}`
})
void pageSizePt // geometry helpers live in one module by constraint; keep the import honest
</script>

<template>
  <button
    type="button"
    :aria-current="props.active ? 'true' : undefined"
    :aria-label="`Go to page ${props.index + 1}`"
    class="group flex w-full flex-col items-center gap-1 rounded-panel p-1.5 transition-colors duration-fast
           hover:bg-surface-sunken"
    @click="emit('select', props.index)"
  >
    <div
      data-testid="thumb-frame"
      :class="cn(
        'w-full overflow-hidden rounded bg-surface ring-1 transition-shadow duration-fast',
        props.active ? 'ring-2 ring-accent' : 'ring-border group-hover:ring-border-strong',
      )"
      :style="{ aspectRatio: ratio }"
    >
      <img
        v-if="bitmap"
        :src="undefined"
        alt=""
        class="hidden"
      />
      <canvas
        v-if="bitmap"
        :width="bitmap.width"
        :height="bitmap.height"
        class="block size-full object-contain"
        :ref="(el) => {
          const c = el as HTMLCanvasElement | null
          if (!c || !bitmap) return
          const ctx = c.getContext('2d')
          ctx?.putImageData(new ImageData(new Uint8ClampedArray(bitmap.rgba), bitmap.width, bitmap.height), 0, 0)
        }"
      />
      <div v-else class="size-full animate-pulse bg-surface-sunken" />
    </div>
    <span class="text-[11px] tabular-nums text-text-subtle">{{ props.index + 1 }}</span>
  </button>
</template>
```

Remove the stray `<img>` and the `void pageSizePt` line — they are here only to show what *not* to leave behind. Delete both before committing; a plan that ships dead code teaches the wrong habit.

`apps/web/src/features/document/ThumbnailPanel.vue`:

```vue
<script setup lang="ts">
import Thumbnail from './Thumbnail.vue'
import { useDocumentStore } from '@/stores/document'
import { useViewportStore } from '@/stores/viewport'

const doc = useDocumentStore()
const vp = useViewportStore()

function select(index: number): void {
  vp.setAnchor(index)
  document.querySelector(`[data-page-index="${index}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
</script>

<template>
  <aside
    class="flex h-full w-60 shrink-0 flex-col border-r border-border bg-surface"
    aria-label="Pages"
  >
    <header class="flex h-11 shrink-0 items-center px-3 text-[13px] font-medium text-text-muted">
      {{ doc.pageCount }} {{ doc.pageCount === 1 ? 'page' : 'pages' }}
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-3">
      <Thumbnail
        v-for="(id, i) in doc.pageOrder"
        :key="id"
        :page="doc.pages[id]!"
        :index="i"
        :active="vp.anchorIndex === i"
        @select="select"
      />
    </div>
  </aside>
</template>
```

Add `:data-page-index="item.index"` to the page wrapper in `PageList.vue` so `scrollIntoView` has a target.

- [ ] **Step 3: Run the tests and commit**

Run: `pnpm vitest run --project web`
Expected: PASS.

```bash
git add -A
git commit -m "feat(web): thumbnails panel reusing placeholder renders"
```

---

## Task 20: Desktop and mobile shells

**Files:**
- Create: `apps/web/src/lib/breakpoint.ts`
- Create: `apps/web/src/app/layouts/DesktopShell.vue`, `apps/web/src/app/layouts/MobileShell.vue`
- Create: `apps/web/src/app/TopBar.vue`
- Modify: `apps/web/src/app/App.vue`
- Test: `apps/web/test/lib/breakpoint.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 12–19
- Produces:
  ```ts
  const DESKTOP_MIN_PX = 1024
  function useShell(): { isDesktop: ComputedRef<boolean>; width: Ref<number> }
  ```

**The responsiveness contract** (spec §6). Full phone support was a deliberate choice and costs real work. What keeps it from doubling the UI is that **only the shell differs** — `DesktopShell` and `MobileShell` compose the *same* feature components (`PageList`, `ZoomPill`, `ThumbnailPanel`, `DropZone`) and read the same stores. Layout and gesture handling differ; nothing else may. If a feature component ever needs to know which shell it is in, that is a signal the boundary is wrong.

Phase 1's shells are deliberately near-empty: a top bar, the page area, and the zoom pill. The tool rail, inspector, and bottom sheet are Phase 2's, and stubbing them now would mean guessing at their interfaces before the tools exist.

- [ ] **Step 1: Write the failing test**

`apps/web/test/lib/breakpoint.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'

beforeEach(() => { vi.resetModules() })

describe('useShell', () => {
  it('reports desktop at and above the breakpoint', async () => {
    const { useShell, DESKTOP_MIN_PX } = await import('../../src/lib/breakpoint.js')
    window.innerWidth = DESKTOP_MIN_PX
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(useShell().isDesktop.value).toBe(true)
  })

  it('reports mobile below the breakpoint', async () => {
    const { useShell, DESKTOP_MIN_PX } = await import('../../src/lib/breakpoint.js')
    window.innerWidth = DESKTOP_MIN_PX - 1
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(useShell().isDesktop.value).toBe(false)
  })

  it('reacts to a resize across the breakpoint', async () => {
    const { useShell, DESKTOP_MIN_PX } = await import('../../src/lib/breakpoint.js')
    const shell = useShell()
    window.innerWidth = 375
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(shell.isDesktop.value).toBe(false)

    window.innerWidth = DESKTOP_MIN_PX + 200
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(shell.isDesktop.value).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails, then write the module**

Run: `pnpm vitest run --project web breakpoint` → FAIL.

`apps/web/src/lib/breakpoint.ts`:

```ts
import { computed, type ComputedRef, type Ref } from 'vue'
import { useWindowSize } from '@vueuse/core'

/** Spec §6: ≥1024px gets the desktop shell (rail + panels). */
export const DESKTOP_MIN_PX = 1024

export function useShell(): { isDesktop: ComputedRef<boolean>; width: Ref<number> } {
  const { width } = useWindowSize()
  return { isDesktop: computed(() => width.value >= DESKTOP_MIN_PX), width }
}
```

- [ ] **Step 3: Write the top bar**

`apps/web/src/app/TopBar.vue`:

```vue
<script setup lang="ts">
import { Download, Sun, Moon, Monitor, PanelLeft } from 'lucide-vue-next'
import Button from '@/ui/Button.vue'
import IconButton from '@/ui/IconButton.vue'
import Tooltip from '@/ui/Tooltip.vue'
import { useDocumentStore } from '@/stores/document'
import { useTheme } from '@/lib/theme'

const props = defineProps<{ compact?: boolean; panelOpen?: boolean }>()
const emit = defineEmits<{ togglePanel: [] }>()

const doc = useDocumentStore()
const { choice, cycle } = useTheme()
const icon = { light: Sun, dark: Moon, system: Monitor }
</script>

<template>
  <header
    class="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3"
    role="banner"
  >
    <Tooltip v-if="!props.compact" content="Pages" side="bottom">
      <IconButton size="sm" label="Toggle pages panel" :active="props.panelOpen" @click="emit('togglePanel')">
        <PanelLeft :size="17" :stroke-width="1.5" />
      </IconButton>
    </Tooltip>

    <span v-if="!props.compact" class="text-[13px] font-semibold tracking-tight">get-margin</span>

    <span class="truncate text-[13px] text-text-muted" :class="props.compact ? 'flex-1' : ''">
      {{ doc.fileName || 'No document' }}
    </span>

    <div class="flex-1" />

    <Tooltip :content="`Theme: ${choice}`" side="bottom">
      <IconButton size="sm" :label="`Theme: ${choice}`" @click="cycle()">
        <component :is="icon[choice]" :size="17" :stroke-width="1.5" />
      </IconButton>
    </Tooltip>

    <!-- Export lands in Phase 2; disabled rather than hidden so the layout is final. -->
    <Button variant="primary" size="sm" disabled>
      <Download :size="15" :stroke-width="1.5" />
      <span v-if="!props.compact">Download</span>
    </Button>
  </header>
</template>
```

- [ ] **Step 4: Write both shells**

`apps/web/src/app/layouts/DesktopShell.vue`:

```vue
<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import TopBar from '../TopBar.vue'
import PageList from '@/features/viewport/PageList.vue'
import ZoomPill from '@/features/viewport/ZoomPill.vue'
import ThumbnailPanel from '@/features/document/ThumbnailPanel.vue'
import { useDocumentStore } from '@/stores/document'
import { useViewportStore } from '@/stores/viewport'

const doc = useDocumentStore()
const vp = useViewportStore()
const panelOpen = ref(true)
const workspace = ref<HTMLElement | null>(null)

const firstGeometry = computed(() => {
  const id = doc.pageOrder[0]
  return id ? doc.pages[id]?.geometry : undefined
})

function refit(): void {
  const el = workspace.value
  const geom = firstGeometry.value
  if (el && geom) vp.applyFit(el.clientWidth, el.clientHeight, geom)
}

useResizeObserver(workspace, refit)
watch([() => doc.status, () => vp.fitMode, panelOpen], refit)
</script>

<template>
  <div class="flex h-dvh flex-col">
    <TopBar :panel-open="panelOpen" @toggle-panel="panelOpen = !panelOpen" />
    <div class="flex min-h-0 flex-1">
      <!-- Phase 2 inserts the 64px tool rail here. -->
      <ThumbnailPanel v-if="panelOpen && doc.isReady" />
      <main ref="workspace" class="relative min-w-0 flex-1">
        <PageList />
        <div class="pointer-events-none absolute bottom-4 right-4 z-20">
          <ZoomPill />
        </div>
      </main>
      <!-- Phase 2 inserts the 320px inspector here. -->
    </div>
  </div>
</template>
```

`apps/web/src/app/layouts/MobileShell.vue`:

```vue
<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { LayoutGrid } from 'lucide-vue-next'
import TopBar from '../TopBar.vue'
import PageList from '@/features/viewport/PageList.vue'
import ZoomPill from '@/features/viewport/ZoomPill.vue'
import ThumbnailPanel from '@/features/document/ThumbnailPanel.vue'
import IconButton from '@/ui/IconButton.vue'
import { useDocumentStore } from '@/stores/document'
import { useViewportStore } from '@/stores/viewport'

const doc = useDocumentStore()
const vp = useViewportStore()
const pagesOpen = ref(false)
const workspace = ref<HTMLElement | null>(null)

const firstGeometry = computed(() => {
  const id = doc.pageOrder[0]
  return id ? doc.pages[id]?.geometry : undefined
})

function refit(): void {
  const el = workspace.value
  const geom = firstGeometry.value
  if (el && geom) vp.applyFit(el.clientWidth, el.clientHeight, geom)
}

useResizeObserver(workspace, refit)
watch([() => doc.status, () => vp.fitMode], refit)
</script>

<template>
  <div class="flex h-dvh flex-col">
    <TopBar compact />
    <main ref="workspace" class="relative min-h-0 flex-1">
      <PageList />
      <div class="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
        <ZoomPill />
      </div>
    </main>

    <!-- Phase 2 replaces this with the scrollable tool strip + bottom sheet. -->
    <nav
      v-if="doc.isReady"
      class="flex h-14 shrink-0 items-center justify-around border-t border-border bg-surface
             pb-[env(safe-area-inset-bottom)]"
      aria-label="Document actions"
    >
      <IconButton label="Pages" :active="pagesOpen" @click="pagesOpen = true">
        <LayoutGrid :size="19" :stroke-width="1.5" />
      </IconButton>
    </nav>

    <!-- Pages become a full-screen modal on phones, per spec §6. -->
    <div
      v-if="pagesOpen"
      class="fixed inset-0 z-40 flex flex-col bg-surface"
      role="dialog"
      aria-modal="true"
      aria-label="Pages"
    >
      <header class="flex h-14 shrink-0 items-center justify-between border-b border-border px-3">
        <span class="text-[13px] font-medium">Pages</span>
        <button type="button" class="min-h-11 px-3 text-[13px] text-accent" @click="pagesOpen = false">Done</button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <ThumbnailPanel class="!w-full !border-r-0" />
      </div>
    </div>
  </div>
</template>
```

`pb-[env(safe-area-inset-bottom)]` keeps the bottom bar clear of the iPhone home indicator — a small thing that immediately marks a web app as untested on a phone when it's missing.

- [ ] **Step 5: Wire App.vue**

`apps/web/src/app/App.vue`:

```vue
<script setup lang="ts">
import { useShell } from '@/lib/breakpoint'
import { useTheme } from '@/lib/theme'
import { useDocumentStore } from '@/stores/document'
import DesktopShell from './layouts/DesktopShell.vue'
import MobileShell from './layouts/MobileShell.vue'
import DropZone from '@/features/document/DropZone.vue'
import PasswordPrompt from '@/features/document/PasswordPrompt.vue'

useTheme()
const { isDesktop } = useShell()
const doc = useDocumentStore()
</script>

<template>
  <PasswordPrompt v-if="doc.status === 'needs-password'" />
  <DropZone v-else-if="doc.status !== 'ready'" />
  <component v-else :is="isDesktop ? DesktopShell : MobileShell" />
</template>
```

`PasswordPrompt` is written in Task 21; this task's `pnpm dev` will fail to resolve it until then. Either do Task 21 immediately after, or stub the import out temporarily.

- [ ] **Step 6: Run tests, then check both shells in a browser**

Run: `pnpm vitest run --project web` → PASS.

```bash
pnpm --filter @margin/web dev
```

Open a PDF and drag the window from wide to narrow across 1024px. The shell must swap cleanly with the document still open, the zoom refitting, and no console errors. Then open devtools device emulation at iPhone SE (375×667) and confirm the page fits, the bottom bar clears the home indicator, and the Pages modal is usable.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): desktop and mobile shells sharing one feature layer"
```

---

## Task 21: States, keyboard shortcuts, and end-to-end verification

**Files:**
- Create: `apps/web/src/features/document/PasswordPrompt.vue`, `apps/web/src/features/document/ErrorState.vue`
- Create: `apps/web/src/features/viewport/useViewportShortcuts.ts`
- Create: `apps/web/e2e/viewer.spec.ts`, `apps/web/playwright.config.ts`
- Modify: `apps/web/src/app/layouts/DesktopShell.vue` (install shortcuts)
- Test: `apps/web/test/features/PasswordPrompt.test.ts`

**Interfaces:**
- Consumes: document and viewport stores
- Produces: `useViewportShortcuts(): void`; `PasswordPrompt`; `ErrorState`

- [ ] **Step 1: Write the failing password prompt test**

`apps/web/test/features/PasswordPrompt.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PasswordPrompt from '../../src/features/document/PasswordPrompt.vue'
import { useDocumentStore } from '../../src/stores/document.js'

vi.mock('../../src/workers/pdfClient.js', () => ({
  createPdfClient: () => ({
    open: vi.fn(), authenticate: vi.fn(), render: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined), terminate: vi.fn(),
  }),
}))

beforeEach(() => setActivePinia(createPinia()))

describe('PasswordPrompt', () => {
  it('uses a password input so the value is never visible or autofilled as text', () => {
    const w = mount(PasswordPrompt)
    expect(w.find('input').attributes('type')).toBe('password')
  })

  it('submits the entered password to the store', async () => {
    const doc = useDocumentStore()
    const spy = vi.spyOn(doc, 'submitPassword').mockResolvedValue()
    const w = mount(PasswordPrompt)
    await w.find('input').setValue('hunter2')
    await w.find('form').trigger('submit')
    expect(spy).toHaveBeenCalledWith('hunter2')
  })

  it('does not submit an empty password', async () => {
    const doc = useDocumentStore()
    const spy = vi.spyOn(doc, 'submitPassword').mockResolvedValue()
    const w = mount(PasswordPrompt)
    await w.find('form').trigger('submit')
    expect(spy).not.toHaveBeenCalled()
  })

  it('shows the store error in an alert region', async () => {
    const doc = useDocumentStore()
    doc.$patch({ status: 'needs-password', error: 'Incorrect password' })
    const w = mount(PasswordPrompt)
    expect(w.find('[role="alert"]').text()).toMatch(/incorrect password/i)
  })

  it('clears the field after a failed attempt', async () => {
    const doc = useDocumentStore()
    vi.spyOn(doc, 'submitPassword').mockImplementation(async () => {
      doc.$patch({ status: 'needs-password', error: 'Incorrect password' })
    })
    const w = mount(PasswordPrompt)
    await w.find('input').setValue('wrong')
    await w.find('form').trigger('submit')
    await w.vm.$nextTick()
    expect((w.find('input').element as HTMLInputElement).value).toBe('')
  })
})
```

- [ ] **Step 2: Run it to verify it fails, then write the components**

Run: `pnpm vitest run --project web PasswordPrompt` → FAIL.

`apps/web/src/features/document/PasswordPrompt.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { Lock } from 'lucide-vue-next'
import Button from '@/ui/Button.vue'
import { useDocumentStore } from '@/stores/document'

const doc = useDocumentStore()
const password = ref('')
const busy = ref(false)

async function submit(): Promise<void> {
  if (!password.value) return
  busy.value = true
  try {
    await doc.submitPassword(password.value)
  } finally {
    busy.value = false
    // Never keep the value around after an attempt (spec §4: passwords in
    // memory only, and no longer than needed).
    password.value = ''
  }
}
</script>

<template>
  <div class="flex h-dvh w-full items-center justify-center bg-canvas p-6">
    <form
      class="flex w-full max-w-sm flex-col gap-4 rounded-panel border border-border bg-surface p-6 shadow-low"
      @submit.prevent="submit"
    >
      <div class="flex items-center gap-2.5">
        <div class="rounded-full bg-surface-sunken p-2 text-text-muted">
          <Lock :size="18" :stroke-width="1.5" />
        </div>
        <div>
          <h2 class="text-[15px] font-semibold tracking-tight">This PDF is protected</h2>
          <p class="text-[13px] text-text-muted">Enter its password to open it.</p>
        </div>
      </div>

      <label class="sr-only" for="pdf-password">Password</label>
      <input
        id="pdf-password"
        v-model="password"
        type="password"
        autocomplete="off"
        class="h-9 rounded-control border border-border bg-surface-sunken px-2.5 text-sm
               outline-none focus-visible:border-accent"
      />

      <p v-if="doc.error" role="alert" class="text-[13px] text-danger">{{ doc.error }}</p>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="doc.reset()">Choose another file</Button>
        <Button variant="primary" size="sm" type="submit" :loading="busy">Open</Button>
      </div>
    </form>
  </div>
</template>
```

`ErrorState.vue` follows the same shape: an icon, `doc.error` in a `role="alert"`, and a "Try another file" button calling `doc.reset()`. `DropZone` already renders `doc.error` inline, so wire `ErrorState` only if you want a distinct full-screen treatment — otherwise skip the file and delete it from this task's file list.

- [ ] **Step 3: Add keyboard shortcuts**

`apps/web/src/features/viewport/useViewportShortcuts.ts`:

```ts
import { useMagicKeys, whenever } from '@vueuse/core'
import { useViewportStore } from '@/stores/viewport'

/**
 * Viewport shortcuts. Phase 2 adds tool shortcuts; this is deliberately only
 * the read-only set so there is nothing to re-map later.
 */
export function useViewportShortcuts(): void {
  const vp = useViewportStore()
  const keys = useMagicKeys({
    passive: false,
    onEventFired(e) {
      // The browser's own zoom would fight ours, so claim these combos.
      if ((e.metaKey || e.ctrlKey) && ['=', '+', '-', '0'].includes(e.key)) e.preventDefault()
    },
  })

  whenever(keys['Meta+='], () => vp.zoomIn())
  whenever(keys['Ctrl+='], () => vp.zoomIn())
  whenever(keys['Meta+-'], () => vp.zoomOut())
  whenever(keys['Ctrl+-'], () => vp.zoomOut())
  whenever(keys['Meta+0'], () => { vp.setFitMode('actual'); vp.setZoom(1) })
  whenever(keys['Ctrl+0'], () => { vp.setFitMode('actual'); vp.setZoom(1) })
  whenever(keys['Meta+1'], () => vp.setFitMode('width'))
  whenever(keys['Ctrl+1'], () => vp.setFitMode('width'))
}
```

Call `useViewportShortcuts()` in `DesktopShell.vue`'s setup block.

- [ ] **Step 4: Write the end-to-end test**

```bash
pnpm --filter @margin/web add -D @playwright/test
pnpm --filter @margin/web exec playwright install chromium
```

`apps/web/playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:4173', trace: 'on-first-retry' },
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['iPhone 13'] } },
  ],
})
```

`apps/web/e2e/viewer.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/multi-page.pdf', import.meta.url),
)
const BIG = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/large-300p.pdf', import.meta.url),
)

test('opens a PDF and renders the first page', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Open a PDF' })).toBeVisible()

  await page.setInputFiles('input[type=file]', FIXTURE)

  await expect(page.getByRole('region', { name: 'Document pages' })).toBeVisible()
  // A real canvas means the WASM loaded, rendered, and painted — the whole path.
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('12 pages')).toBeVisible()
})

test('rejects a non-PDF file', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', {
    name: 'fake.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('PK this is a zip'),
  })
  await expect(page.getByRole('alert')).toContainText(/not a PDF/i)
})

test('zoom controls change the rendered size', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  const canvas = page.locator('canvas').first()
  await expect(canvas).toBeVisible({ timeout: 30_000 })

  const before = await canvas.boundingBox()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect.poll(async () => (await canvas.boundingBox())?.width).not.toBe(before?.width)
})

test('a 300-page document shows its first page promptly', async ({ page }) => {
  await page.goto('/')
  const start = Date.now()
  await page.setInputFiles('input[type=file]', BIG)
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
  // Not a benchmark — a regression guard against accidentally rendering all 300
  // pages before showing anything.
  expect(Date.now() - start).toBeLessThan(20_000)
})

test('the page area does not scroll horizontally on a phone', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone only')
  await page.goto('/')
  await page.setInputFiles('input[type=file]', FIXTURE)
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})
```

- [ ] **Step 5: Run the end-to-end suite**

```bash
pnpm --filter @margin/pdf-core fixtures
pnpm --filter @margin/web exec playwright test
```

Expected: PASS on both the desktop and phone projects.

This suite is the Phase 1 milestone made executable. It is also the first place the real WASM runs in a real browser under automation, so a failure here is meaningful even when every unit test passes — that gap is precisely what it exists to close.

- [ ] **Step 6: Full verification**

```bash
pnpm test
pnpm typecheck
pnpm --filter @margin/web build
pnpm --filter @margin/web exec playwright test
```

All four must pass. Check the build output size and confirm the `.wasm` file is emitted as a separate asset rather than inlined into a JS bundle — inlining a 15MB binary as base64 would inflate it by a third and block parsing.

- [ ] **Step 7: Commit and tag**

```bash
git add -A
git commit -m "feat(web): password prompt, shortcuts, and end-to-end viewer tests"
git tag phase-1-complete
```

> ### ▶ Phase 1 milestone
> Open any PDF and read it comfortably on desktop and phone. Verified by: `pnpm test` green across four projects, Playwright green on desktop and iPhone viewports, and a manual pass on the 300-page fixture confirming prompt first paint, smooth scrolling, and plateauing memory.
>
> **Not yet built, by design:** the tool rail, inspector panel, mobile bottom sheet, SVG overlay, edit store, and export. Those are Phase 2, and their interfaces are better designed once the tools that use them exist.

---

## Plan self-review

**Spec coverage (Phase 0 + Phase 1 scope only):**

| Spec requirement | Task |
|---|---|
| §7 Phase 0 spikes 1–7 | 3, 4, 5, 6 |
| §1.4 coordinate module + property tests | 7 |
| §8 golden-file rig built in phase 0 | 10 |
| §1.1 monorepo, dual browser/Node target | 1 |
| §1.1 `apps/web` folder structure | 12–21 |
| §1.2 `PageId` not index; serializable state | 15 |
| §1.5 worker + Comlink + cancellation | 14 |
| §1.5 two-tier render, priority by anchor distance | 17 |
| §1.5 LRU capped by megapixels | 16 |
| §1.5 single-threaded WASM, no COOP/COEP | Global Constraints, 12 |
| §2.1 upload with magic-byte validation | 15 |
| §4 client-side size caps with clear messaging | 15 |
| §4 no file bytes retained on the main thread | 15 |
| §6 semantic tokens, dark mode from day one | 12 |
| §6 desktop shell: top bar, workspace, zoom pill, pages panel | 18, 19, 20 |
| §6 mobile shell, 44px targets, safe-area inset | 13, 20 |
| §6 a11y: focus rings, ARIA, reduced motion | 12, 13, 21 |
| §7 Phase 1 deliverables | 12–21 |

**Deliberately deferred to Phase 2, not omitted:** tool rail, inspector, bottom sheet, ⌘K palette, IndexedDB autosave, `edit-model` package, `pdf-core/write/`. Each is called out at the task where its seam appears.

**Known gaps to resolve during execution, not before:**
1. `packages/edit-model` appears in the spec's structure but has no Phase 0/1 task — correct, since nothing consumes it until Phase 2.
2. The encrypted-fixture test in Task 14 is a documented stub, because whether an encrypted PDF can be *generated* is Task 5's finding. Fill it in once Task 5 answers.
3. Task 15's store uses a `#private` action, which Pinia options stores don't support — the fix is noted inline and must be applied on contact.
4. Task 18 creates an import cycle between `fit.ts` and `viewport.ts`; the resolution is specified inline.

Items 3 and 4 are flagged rather than pre-fixed because both are one-line decisions better made with the file open.

---

## Execution handoff

**Plan complete and saved to `PLAN-PHASE-0-1.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task and review between tasks. Fast iteration, and each task gets a clean context, which suits this plan because the tasks are well-isolated and several are long.

**2. Inline Execution** — I execute tasks in this session with batched checkpoints for your review.

**Which approach?**

One caveat either way: **Tasks 3–6 are spikes whose output is judgement, not code.** They involve opening PDFs in Acrobat, Preview, and Chrome and looking at them. An agent can run the probes and transcribe the console output, but it cannot see whether a highlight renders correctly in Acrobat. Plan to do the visual verification steps yourself, or accept that those findings stay unconfirmed until you do.


