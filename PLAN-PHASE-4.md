# get-margin Phase 4 — MVP Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the editor safe to ship — a hostile PDF cannot pass through it unchanged, an hour of work cannot be lost to a crashed tab, every control is reachable without a mouse, and a 300-page document behaves.

**Architecture:** Four tranches, ordered by what "shippable" requires: **4A Trust** (active-content stripping in the write path, error boundaries, privacy page), **4B Not losing work** (Dexie autosave of the `EditDocument`, matched back to a re-picked file by its SHA-256), **4C Reach** (a11y, onboarding, ⌘K palette), **4D Scale and touch** (300-page measurement, memory pressure, mobile gestures, phone page selection).

**Tech Stack:** TypeScript, Vue 3 + Pinia, mupdf 1.28.0 in a Comlink worker, Dexie, Vitest, Playwright. **No new runtime dependencies.**

**Spec:** `PHASE-4-DESIGN.md`. Measurements it argues from: `docs/findings/09-phase-4-preflight.md`.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node `>=22`**, pnpm 9.15.0, workspaces `apps/web`, `packages/pdf-core`, `packages/transform`.
- **Four Vitest projects**: `pdf-core` (node), `transform` (node), `web` (jsdom), `web-node` (node, `test/workers/**`). `e2e/**` is Playwright.
- **`packages/pdf-core` imports use explicit `.js` extensions.** `apps/web` uses `@/`.
- **Disposal is a correctness requirement.** Every `loadPage()` in a `try/finally` with `.destroy()`.
- **Every mutation of `EditDocument` goes through `applyOp`.**
- **No new runtime dependencies.** Dexie, fflate, Immer, perfect-freehand and nanoid are already present; nothing else is added this phase.
- **Stripping is always on**, never a setting, and its cost is stated in the UI (`PHASE-4-DESIGN.md` §1.1).
- **Autosave stores the `EditDocument`, never the source PDF** (`PHASE-4-DESIGN.md` §2.1).
- **Honest copy.** The privacy page must match what the code actually does; it is written last in 4A and re-checked against 4B.
- **Commit after every task**, conventional commits.

---

## File Structure

**Created in `packages/pdf-core/src/`:**

| File | Responsibility |
|---|---|
| `write/sanitize.ts` | `stripActiveContent(raw)` → what was found and removed. Sole owner of the traversal |

**Created in `apps/web/src/`:**

| File | Responsibility |
|---|---|
| `app/ErrorBoundary.vue` | Catches, records, and surfaces a named failure without blanking the app |
| `stores/autosave.ts` | Debounced persistence of the edit document, and the restore offer's state |
| `lib/autosaveDb.ts` | Dexie schema and the read/write/prune primitives |
| `features/document/RestorePrompt.vue` | The offer to restore, never automatic |
| `features/document/PrivacyPage.vue` | What is and is not stored |
| `features/command/CommandPalette.vue` | ⌘K over the commands that already exist |
| `features/command/commands.ts` | One registry of named commands, shared by the palette and the rail |

**Modified:** `write/index.ts` (strip on export) · `workers/pdfService.ts`, `pdfClient.ts` (report what was stripped) · `app/App.vue` (boundaries) · `features/document/DropZone.vue` (onboarding) · `features/pages/PageGrid.vue` (touch select).

---

# Tranche 4A — Trust

## Task 52: Strip active content on export

**Files:**
- Create: `packages/pdf-core/src/write/sanitize.ts`
- Modify: `packages/pdf-core/src/write/index.ts`
- Test: `packages/pdf-core/test/write/sanitize.test.ts`

**Interfaces:**
- Produces: `type StrippedContent = { openAction: boolean; documentJavaScript: boolean; catalogActions: boolean; pageActions: number; embeddedFiles: number }`, `stripActiveContent(raw: mupdf.PDFDocument): StrippedContent`, and `ReplayOptions.onStripped?: (found: StrippedContent) => void`.

- [ ] **Step 1: Write the failing test**

Create `packages/pdf-core/test/write/sanitize.test.ts`. It needs a fixture that actually carries active content, so build one in the test rather than committing a hostile PDF:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import { replay } from '../../src/write/index.js'
import { EDIT_DOCUMENT_VERSION, type EditDocument } from '../../src/write/types.js'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)
const SRC = 'src-0'

/**
 * A PDF carrying every vector this strips. Built here rather than committed:
 * a hostile file in the repo is a hazard to whoever clones it, and building
 * it makes the vectors legible.
 */
function hostile(): Uint8Array {
  const doc = mupdf.PDFDocument.openDocument(
    new Uint8Array(readFileSync(fixturePath('simple-text'))),
    'application/pdf',
  ) as mupdf.PDFDocument
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

describe('active-content stripping', () => {
  it('the hostile fixture really is hostile', () => {
    // Without this, every assertion below could pass against a clean file.
    const before = inspect(hostile())
    expect(before).toMatchObject({
      openAction: true, documentJavaScript: true, catalogActions: true,
      pageActions: true, rawScript: true,
    })
  })

  it('removes every vector on export', () => {
    const out = replay(new Map([[SRC, hostile()]]), edited())
    expect(inspect(out)).toMatchObject({
      openAction: false, documentJavaScript: false, catalogActions: false, pageActions: false,
    })
  })

  // Deleting a key only unlinks the object. If the export did not collect
  // the orphan, the script text would still be sitting in the file for
  // anyone reading the bytes.
  it('removes the script TEXT, not just the reference', () => {
    const out = replay(new Map([[SRC, hostile()]]), edited())
    expect(Buffer.from(out).includes('app.alert')).toBe(false)
  })

  it('reports what it found', () => {
    let found: unknown
    replay(new Map([[SRC, hostile()]]), edited(), { onStripped: (f) => { found = f } })
    expect(found).toMatchObject({
      openAction: true, documentJavaScript: true, catalogActions: true, pageActions: 1,
    })
  })

  it('reports nothing for a clean document', () => {
    let found: { openAction: boolean; pageActions: number } | undefined
    replay(
      new Map([[SRC, new Uint8Array(readFileSync(fixturePath('simple-text')))]]),
      edited(),
      { onStripped: (f) => { found = f } },
    )
    expect(found).toMatchObject({ openAction: false, pageActions: 0 })
  })

  it('leaves the page content intact', () => {
    const out = replay(new Map([[SRC, hostile()]]), edited())
    const d = mupdf.PDFDocument.openDocument(out, 'application/pdf') as mupdf.PDFDocument
    const p = d.loadPage(0)
    try {
      expect(p.toStructuredText('').asJSON()).toContain('Hello margin')
    } finally { p.destroy(); d.destroy() }
  })

  // The pass-through tier returns the user's original bytes untouched, so a
  // hostile file downloaded WITHOUT edits would still carry its scripts.
  // Stripping must therefore defeat the pass-through.
  it('strips even when nothing else was edited', () => {
    const untouched: EditDocument = {
      ...edited(),
      pages: { p0: { sourceId: SRC, sourceIndex: 0, rotation: 0, cropBox: null } },
    }
    const out = replay(new Map([[SRC, hostile()]]), untouched)
    expect(Buffer.from(out).includes('app.alert')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`pnpm vitest run --project pdf-core sanitize`)

- [ ] **Step 3: Implement the traversal**

Create `packages/pdf-core/src/write/sanitize.ts`:

```ts
import type * as mupdf from 'mupdf'

/** What a document was carrying, so the UI can say so. */
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
  return found.openAction || found.documentJavaScript || found.catalogActions || found.pageActions > 0
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
 * script text would remain in the file. The caller saves with
 * `garbage=compact` (SAVE_OPTIONS), which collects the orphans -- measured
 * in docs/findings/09-phase-4-preflight.md, and asserted directly by
 * sanitize.test.ts rather than assumed.
 *
 * COST: a source document whose form fields carry validation scripts loses
 * them. That is the right default for a consumer editor, and the return
 * value exists so the UI can say it happened rather than leaving the user
 * to discover it.
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
```

- [ ] **Step 4: Call it from `replay`, defeating the pass-through**

In `write/index.ts`, add `onStripped?: (found: StrippedContent) => void` to `ReplayOptions`, and run the strip on the assembled document **before** page boxes and objects.

The pass-through tier needs care: it returns the user's original bytes, which for a hostile file would still carry the scripts. Assemble first, strip, and only take the pass-through when **nothing was stripped**:

```ts
  const { raw, unchanged } = assemble(sources, editDoc)
  try {
    // Before the pass-through decision, not after: an unedited hostile file
    // must not be handed back with its scripts intact.
    const stripped = stripActiveContent(raw)
    opts.onStripped?.(stripped)

    if (unchanged && !hasObjects && !anythingStripped(stripped)) {
      const original = sources.get(Object.keys(editDoc.sources)[0]!)
      if (original) return original
    }
    ...
```

- [ ] **Step 5: Run the tests — expect PASS**

- [ ] **Step 6: Run everything and commit**

Run: `pnpm test && pnpm typecheck && pnpm --filter @margin/web typecheck`

```bash
git add packages/pdf-core
git commit -m "feat(pdf-core): strip scripted actions from every export

Removes /OpenAction, /Names /JavaScript, and /AA on both the catalog and
every page. Asserted not just that the keys are gone but that the script
TEXT is absent from the output bytes -- deleting a key only unlinks the
object, and it is the export's existing garbage=compact that collects the
orphan.

Stripping runs BEFORE the pass-through decision: an unedited hostile file
would otherwise be handed straight back with its scripts intact.

The test builds its hostile fixture rather than committing one -- a
malicious PDF in the repo is a hazard to whoever clones it -- and asserts
the fixture really is hostile first, so the removal assertions cannot pass
against a clean file."
```

---

## Task 53: Say what was stripped

**Files:**
- Modify: `apps/web/src/workers/pdfService.ts`, `pdfClient.ts`, `apps/web/src/app/TopBar.vue`
- Create: `apps/web/e2e/sanitize.spec.ts`
- Test: `apps/web/test/features/strippedNotice.test.ts`

**Interfaces:** consumes `StrippedContent`; `PdfClient.save` gains an `onStripped` proxied callback, mirroring `onProgress`.

- [ ] **Step 1: Write the failing component test**

Assert that after a download of a document that carried active content, the UI says so; that it says nothing for a clean document; and that the wording names what it removed rather than being vague.

```ts
it('says when a downloaded file had active content removed', async () => {
  save.mockImplementation(async (_d, _f, _p, onStripped) => {
    onStripped?.({ openAction: true, documentJavaScript: true, catalogActions: false, pageActions: 2 })
    return new Uint8Array([1])
  })
  const w = mount(TopBar)
  await w.get('[data-download]').trigger('click')
  await flushPromises()
  expect(w.get('[data-stripped-notice]').text()).toContain('removed')
})

it('names scripts rather than saying "some content"', async () => { /* ... */ })

it('says nothing for a clean document', async () => {
  save.mockImplementation(async (_d, _f, _p, onStripped) => {
    onStripped?.({ openAction: false, documentJavaScript: false, catalogActions: false, pageActions: 0 })
    return new Uint8Array([1])
  })
  const w = mount(TopBar)
  await w.get('[data-download]').trigger('click')
  await flushPromises()
  expect(w.find('[data-stripped-notice]').exists()).toBe(false)
})
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Thread `onStripped` through the worker**

Same shape as Task 39's `onProgress`: a Comlink-proxied callback on `save`, fire-and-forget in the worker.

- [ ] **Step 4: Surface it in `TopBar`**

A dismissible note after a download, not a modal — the download has already succeeded and blocking on an acknowledgement would be theatre. Copy names what went:

> Removed JavaScript that would have run when this file opened. Form-field scripts, if the original had any, are gone too.

- [ ] **Step 5: Write the e2e**

`apps/web/e2e/sanitize.spec.ts` — the test that exercises the whole path a hostile file actually takes. The fixture is generated alongside the others rather than committed: add a `hostile.pdf` case to `packages/pdf-core/test/fixtures/generate.ts` so both Vitest and Playwright can reach it.

Open it, download, and assert the downloaded bytes contain no `app.alert`.

- [ ] **Step 6: Run everything and commit**

---

## Task 54: Error boundaries

**Files:**
- Create: `apps/web/src/app/ErrorBoundary.vue`
- Modify: `apps/web/src/app/App.vue`, `apps/web/src/main.ts`
- Test: `apps/web/test/features/ErrorBoundary.test.ts`

**Interfaces:** produces `ErrorBoundary` with props `{ label: string }` and a `#fallback` slot; records via `useDocumentStore().error`.

- [ ] **Step 1: Write the failing test**

```ts
const Boom = defineComponent({ setup: () => () => { throw new Error('render exploded') } })

it('catches a child’s error instead of blanking the app', () => {
  const w = mount(ErrorBoundary, { props: { label: 'The page view' }, slots: { default: Boom } })
  expect(w.text()).toContain('The page view')
})

// A boundary that swallows an error silently is worse than no boundary.
it('names what failed', () => {
  const w = mount(ErrorBoundary, { props: { label: 'The page view' }, slots: { default: Boom } })
  expect(w.text()).toContain('render exploded')
})

it('renders its children normally when nothing throws', () => {
  const w = mount(ErrorBoundary, {
    props: { label: 'x' },
    slots: { default: '<p>fine</p>' },
  })
  expect(w.text()).toContain('fine')
  expect(w.find('[data-boundary-failed]').exists()).toBe(false)
})

it('recovers when retried', async () => { /* toggles a flag and re-renders children */ })
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement**

`onErrorCaptured` returning `false` to stop propagation, holding the error in local state, rendering a recoverable panel that names the failure and offers Retry. Plus `app.config.errorHandler` in `main.ts` for anything outside a boundary.

- [ ] **Step 4: Wrap the viewport and the app root** in `App.vue`, with distinct labels so the surfaced message says which part failed.

- [ ] **Step 5: Run everything and commit**

---

## Task 55: Privacy page

**Files:**
- Create: `apps/web/src/features/document/PrivacyPage.vue`
- Modify: `apps/web/src/app/TopBar.vue`
- Test: `apps/web/test/features/PrivacyPage.test.ts`

**Written after Task 56's design is settled**, and re-checked against it: a privacy page that describes storage the code does not do, or omits storage it does, is worse than none.

- [ ] **Step 1: Write the failing test**

Assert it states: files are never uploaded; what IS stored locally (autosaved edits, saved signatures — both by name); that the source PDF is not stored; and how to clear it. Assert it does not claim "nothing is stored", which would be false.

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement**, reachable from `TopBar`.

- [ ] **Step 4: Run everything and commit**

---

# Tranche 4B — Not losing work

## Task 56: Autosave the edit document

**Files:**
- Create: `apps/web/src/lib/autosaveDb.ts`, `apps/web/src/stores/autosave.ts`
- Test: `apps/web/test/lib/autosaveDb.test.ts`, `apps/web/test/stores/autosave.test.ts`

**Interfaces:**
- Produces: `type SavedEdit = { hash: string; name: string; savedAt: number; doc: EditDocument }`; `putEdit`, `findEdit(hash)`, `deleteEdit(hash)`, `pruneEdits(now)` from `autosaveDb`; `useAutosaveStore()` exposing `pending`, `lastSavedAt`, `start()`, `stop()`, `flush()`.

- [ ] **Step 1: Write the failing db test**

```ts
describe('autosaveDb', () => {
  it('round-trips an edit document by hash', async () => { /* put then find */ })

  it('overwrites the record for the same document rather than accumulating', async () => {
    await putEdit(record('h', 1))
    await putEdit(record('h', 2))
    expect((await findEdit('h'))!.savedAt).toBe(2)
  })

  it('returns undefined for a document it has never seen', async () => {
    expect(await findEdit('nope')).toBeUndefined()
  })

  // Storage must not grow without bound across every document ever opened.
  it('prunes records older than the retention window', async () => { /* ... */ })
  it('prunes the oldest first when over the record cap', async () => { /* ... */ })

  // Private browsing and storage-blocked contexts reject IndexedDB. Losing
  // autosave is not a reason to break editing -- the same rule the signature
  // store already follows.
  it('degrades to a no-op when IndexedDB is unavailable', async () => { /* ... */ })
})
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement `autosaveDb`**

Dexie, a second table alongside the signature store's, keyed by `hash`. Constants: `RETENTION_MS = 30 days`, `MAX_RECORDS = 20`. Every call wrapped so a rejected IndexedDB degrades to a no-op, matching `signatureStore.ts`.

- [ ] **Step 4: Write the failing store test**

```ts
// An autosave per keystroke is a write per keystroke.
it('coalesces a burst of edits into one write', async () => {
  const store = useAutosaveStore()
  store.start()
  for (let i = 0; i < 20; i++) edits.applyOp(/* ... */, 'Edit')
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2)
  expect(putEdit).toHaveBeenCalledTimes(1)
})

it('writes the current edit document, keyed by the primary source hash', async () => { /* ... */ })
it('does not write when there is nothing open', async () => { /* ... */ })
it('flush() writes immediately, for beforeunload', async () => { /* ... */ })
it('stop() cancels a pending write', async () => { /* ... */ })

// A save that fails must not take the editor down with it.
it('survives a rejected write', async () => { /* ... */ })
```

- [ ] **Step 5: Implement the store**

`$subscribe` on the edit store, debounced at `AUTOSAVE_DEBOUNCE_MS = 1500`. `flush()` bound to `beforeunload` so a deliberate close keeps the last edit. Started when a document becomes ready, stopped on reset.

- [ ] **Step 6: Run everything and commit**

```bash
git commit -m "feat(web): autosave the edit document, not the source PDF

Keyed by the primary source's SHA-256, which schema v2 has recorded since
Phase 3, so a restored edit can be matched to a re-picked file. The source
is up to 150MB and keeping a copy of every document the user has opened is
a privacy cost the never-leaves-the-browser promise does not license by
itself.

Debounced, because an autosave per keystroke is a write per keystroke, and
flushed on beforeunload so a deliberate close keeps the last edit. Every
storage call degrades to a no-op when IndexedDB is unavailable -- private
browsing must not break editing."
```

---

## Task 57: Offer to restore

**Files:**
- Create: `apps/web/src/features/document/RestorePrompt.vue`
- Modify: `apps/web/src/stores/document.ts`, `apps/web/src/app/App.vue`
- Create: `apps/web/e2e/autosave.spec.ts`
- Test: `apps/web/test/features/RestorePrompt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// NEVER restore silently: a user who deliberately started over would find
// their old annotations back with no explanation.
it('offers rather than restoring automatically', async () => {
  await openMatchingDocument()
  expect(edits.doc.objects).toEqual({})
  expect(wrapper.find('[data-restore-prompt]').exists()).toBe(true)
})

it('says when the edits were made', async () => { /* relative time */ })

it('applies the stored edits on accept', async () => { /* ... */ })

// Declining must leave a clean document AND stop re-offering on every open.
it('discards the record on decline', async () => {
  await decline()
  expect(deleteEdit).toHaveBeenCalledWith(HASH)
  expect(edits.doc.objects).toEqual({})
})

it('does not offer for a document with no stored edits', async () => { /* ... */ })

// A record written by an older build must be lifted, and one written by a
// newer build refused rather than mangled.
it('migrates an older stored schema', async () => { /* v1 record restores */ })
it('refuses a record from a newer build, and says so', async () => { /* ... */ })
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement**

`openFile` looks up `findEdit(hash)` after hashing and, on a hit, puts the record in the autosave store rather than applying it. `RestorePrompt` renders the offer. Accepting runs the record through `migrateEditDocument` and seeds the edit store; declining calls `deleteEdit`.

- [ ] **Step 4: Write the e2e**

`apps/web/e2e/autosave.spec.ts`: open a fixture, draw a rectangle, reload the page, re-pick the same file, accept the restore, and assert the object is back. This is the test that proves the feature end to end; the unit tests only prove the parts.

- [ ] **Step 5: Run everything and commit**

---

# Tranche 4C — Reach

## Task 58: Accessibility pass

**Files:** modify `features/pages/PageGrid.vue`, `features/signature/SignatureModal.vue`, `features/pages/SplitDialog.vue`, `features/pages/CropOverlay.vue`, `app/styles/tokens.css`; test `apps/web/test/features/a11y.test.ts`

- [ ] **Step 1: Write the failing tests**

One suite asserting, for each modal surface (signature, split, crop): focus moves into it on open, `Escape` closes it, focus returns to the control that opened it, and `Tab` does not escape it. Plus: the page grid's tiles sit inside a `role="listbox"`, every icon-only control has an accessible name, and no interactive element relies on colour alone for state.

```ts
it.each(['signature', 'split', 'crop'])('%s traps focus and returns it on close', async (surface) => { /* ... */ })

it('puts the page tiles in a listbox', () => {
  expect(mount(PageGrid).get('[role="listbox"]').exists()).toBe(true)
})

it('gives every icon-only control an accessible name', () => { /* walk buttons with no text */ })
```

- [ ] **Step 2: Run them — expect FAIL**

- [ ] **Step 3: Implement** a small `useFocusTrap(el, { onEscape })` composable and apply it to the three surfaces; add the listbox role; fix any unnamed control the test finds.

- [ ] **Step 4: Run everything and commit**

---

## Task 59: Onboarding empty state

**Files:** modify `apps/web/src/features/document/DropZone.vue`; test `apps/web/test/features/DropZone.test.ts`

- [ ] **Step 1: Write the failing test** — the empty state names what the app does, states that files stay on the device, and names the limits (150 MB, 800 pages) rather than surfacing them only as errors after a failed open.

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement.** Copy must match `lib/limits.ts`'s actual constants, imported rather than retyped, so the two cannot drift.

- [ ] **Step 4: Run everything and commit**

---

## Task 60: Command palette

**Files:** create `apps/web/src/features/command/commands.ts`, `CommandPalette.vue`; modify `features/tools/toolList.ts`, `app/App.vue`; test `apps/web/test/features/CommandPalette.test.ts`

**Interfaces:** produces `type Command = { id: string; label: string; group: string; run: () => void; available: () => boolean }`, `useCommands(): Command[]`.

- [ ] **Step 1: Write the failing test** — ⌘K opens it; typing filters by label; Enter runs the highlighted command; Escape closes and returns focus; unavailable commands (page ops with nothing open) do not appear; and **every tool in `toolList.ts` is reachable as a command**, so the palette cannot silently fall behind the rail.

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement.** `commands.ts` derives tool commands from `toolList.ts` rather than repeating them — that is what the "cannot fall behind" test pins — and adds page and document commands.

- [ ] **Step 4: Run everything and commit**

---

# Tranche 4D — Scale and touch

## Task 61: Measure a 300-page document

**Files:** create `docs/findings/10-large-document-performance.md`

Measurement before change: every cap in the app is a hand-chosen constant and at least one is probably wrong.

- [ ] **Step 1: Measure**, in a real browser via Playwright against `large-300p.pdf`: time to first page, time to interactive, scroll frame timing through 50 pages, peak bitmap-cache megapixels, and `performance.memory` where available.

- [ ] **Step 2: Record the numbers** in the findings file, with the environment stated, as numbers rather than adjectives.

- [ ] **Step 3: Only then decide** what to change, and say what was left alone and why.

- [ ] **Step 4: Commit**

---

## Task 62: Memory-pressure handling

**Files:** create `apps/web/src/lib/memoryBudget.ts`; modify `lib/bitmapCache.ts`, `stores/viewport.ts`, `workers/pdfService.ts`; test `apps/web/test/lib/memoryBudget.test.ts`

- [ ] **Step 1: Write the failing test** — the budget scales with `navigator.deviceMemory` when present, **degrades to today's constants when absent** (Safari and Firefox do not expose it), never returns a budget below a floor that would make the app unusable, and is clamped above so a 64 GB machine does not cache unboundedly.

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement** and wire into `BitmapCache`'s megapixel bound.

- [ ] **Step 4: Address the merged-source hole** from Phase 3: when a merged file's pages are all gone AND its removal is beyond the undo horizon, its bytes may be dropped. If that condition cannot be established cheaply, leave it and say so in the findings rather than shipping a drop that breaks redo.

- [ ] **Step 5: Run everything and commit**

---

## Task 63: Mobile gestures

**Files:** create `apps/web/src/features/viewport/useGestures.ts`; modify `features/viewport/PageList.vue`; test `apps/web/test/features/useGestures.test.ts`

- [ ] **Step 1: Write the failing test** — two-pointer pinch changes zoom about the midpoint; one-pointer drag pans; a second pointer arriving mid-drag switches to pinch without a jump; **a palm (a contact with a large radius, or a third pointer) is ignored**; and pointercancel ends cleanly.

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement.** Zoom goes through `vp.setZoom`; no component does its own coordinate maths.

- [ ] **Step 4: Run everything and commit**

---

## Task 64: Page selection on phones

**Files:** modify `features/pages/PageGrid.vue`; modify `apps/web/e2e/pages.spec.ts`

Phase 3's recorded capability gap: rotate and delete are desktop-only because the phone's pages panel closes when a thumbnail is tapped.

- [ ] **Step 1: Write the failing test** — on a touch layout, each tile carries a select control that toggles selection **without** navigating or closing the panel, while tapping the thumbnail itself still navigates and closes (Phase 1 behaviour, which `viewer.spec.ts` asserts and must keep passing).

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement** a per-tile select control, shown always on touch and on hover/focus on desktop, so both platforms use one mechanism rather than two.

- [ ] **Step 4: Un-skip the three desktop-only e2e tests** in `pages.spec.ts` and delete the `desktopOnly` helper.

- [ ] **Step 5: Run everything and commit**

---

## Task 65: Phase verification and the MVP gate

**Files:** create `docs/findings/11-phase-4-verification.md`; modify `PLAN.md` §7, `PLAN-PHASE-4.md`

- [ ] **Step 1: Full run** — `pnpm test && pnpm typecheck && pnpm --filter @margin/web typecheck && pnpm --filter @margin/web build && pnpm --filter @margin/web e2e`

- [ ] **Step 2: Write the verification record**, in the same shape as Phases 2 and 3: what is verified automatically, what needs a human, and what is outstanding. The MVP gate additionally needs a **human pass on a real device** — a phone, not an emulated viewport — which no agent can do.

- [ ] **Step 3: Update `PLAN.md` §7**, marking Phase 4 and stating honestly whether the MVP milestone is met.

- [ ] **Step 4: Commit**

---

## Plan self-review

**Spec coverage — every design section maps to a task:**

| Design section | Tasks |
|---|---|
| §0 tranches and deferrals | structure of this plan; deferrals restated in `PLAN.md` §7 by Task 65 |
| §1.1 stripping | 52 (write path) · 53 (UI + e2e) |
| §1.2 error boundaries | 54 |
| §1.3 privacy page | 55, written after 56's design |
| §2.1–2.3 autosave and restore | 56 · 57 |
| §3 a11y, onboarding, palette | 58 · 59 · 60 |
| §4 perf, memory, gestures, phone selection | 61 · 62 · 63 · 64 |
| §5 testing | per task, plus 65 |
| §6 out of scope | stated, no task |

**Type consistency:** `StrippedContent` is defined once in Task 52 and consumed by 53. `SavedEdit` is defined in Task 56 and consumed by 57. `Command` is defined in Task 60 only. `ReplayOptions` gains exactly one member (`onStripped`) and every existing call site stays valid.

**Known gaps, stated rather than hidden:**

1. **Task 62's merged-source drop may not be implementable safely.** Phase 3 established that freeing a merged file's bytes breaks redo. The task says to leave it and record why if the "beyond the undo horizon" condition cannot be established cheaply — that is a real possible outcome, not a hedge.
2. **Task 61 measures before it changes anything**, so the work it implies is not fully specified here. That is deliberate: specifying fixes for unmeasured problems is how caps get tuned to imaginary conditions.
3. **The MVP gate needs a human on a real phone.** No agent can do it, and an emulated viewport is not the same test.
