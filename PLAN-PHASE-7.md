# Phase 7 — Conversion backend Implementation Plan

> **For agentic workers:** implement task-by-task. Each task ends green on all four gates
> (`pnpm test`, `pnpm -r typecheck`, `pnpm -r build`, `pnpm --filter @margin/web e2e`) and commits.

**Goal:** A conversion backend for the work that cannot happen in a browser, plus the client-side
PDF → JPG export that can.

**Architecture:** Stateless async jobs. API and worker are separate processes and, in deployment,
separate containers. The queue and storage sit behind interfaces so the in-process implementations
used here can be swapped for BullMQ and S3 without touching call sites.

**Spec:** `PHASE-7-DESIGN.md`. **Pre-flight:** `docs/findings/16-phase-7-preflight.md`.

## Global Constraints

- **Never log a filename, file contents, or a job payload.** Job id, type, byte size, duration, and
  outcome only. `PLAN.md` §4.
- **Deletion is unconditional** and never contingent on a job succeeding. Four paths: on download, on
  TTL, on explicit purge, on sweep.
- **Job ids are 32 random bytes**, base64url — the id is the only credential for reading a result.
- **No upload without explicit per-action consent** naming the file and the deletion policy.
- **Every unverifiable file carries an in-file marker** saying it has never been executed and naming
  what must be run to verify it.
- **Do not write the `unoserver` or `ocrmypdf` adapters.** See design §0.
- Validate magic bytes, never the filename extension.

---

## Task 95: `packages/shared` — the DTOs both sides read

**Files:** create `packages/shared/{package.json,tsconfig.json,src/index.ts,src/jobs.ts}`;
test `packages/shared/test/jobs.test.ts`

**Produces:** `JobType`, `JobStatus`, `CreateJobResponse`, `JobStatusResponse`, zod schemas, and
`isJobType`.

- [ ] `JobType` starts as `'html-to-pdf'` only. Types with no converter are absent, not stubbed, so
      the UI cannot offer something that fails at runtime.
- [ ] `JobStatus`: `queued | running | done | failed | expired`. `expired` is distinct from `failed`
      — a file deleted on schedule is not an error.
- [ ] Tests: a valid response parses; an unknown status is rejected; an unknown job type is rejected;
      the id format is validated.
- [ ] Gates, commit.

## Task 96: Storage with a TTL

**Files:** create `apps/api/src/storage/{types.ts,local.ts,sweeper.ts}`;
test `apps/api/test/storage.test.ts`

**Produces:** `StorageAdapter`, `LocalStorage`, `Sweeper`, `newJobId()`.

- [ ] `newJobId()`: 32 random bytes, base64url. Tested for length, alphabet, and uniqueness across
      many draws.
- [ ] `LocalStorage`: `put`, `get`, `delete`, `size`, `age`. The job id is the directory name.
- [ ] `Sweeper`: removes anything past the TTL, driven by an **injected clock** so tests do not sleep.
- [ ] Tests: a stored file round-trips; delete removes it; the sweeper removes an expired job and
      keeps a fresh one; sweeping an empty root is a no-op; a directory that vanishes mid-sweep does
      not throw.
- [ ] Gates, commit.

## Task 97: The queue interface, in-process

**Files:** create `apps/api/src/jobs/{types.ts,memoryQueue.ts}`; test `apps/api/test/queue.test.ts`

- [ ] `JobQueue`: `enqueue`, `status`, `onProgress`, `cancel`. BullMQ is a later adapter.
- [ ] `MemoryQueue` runs handlers on the microtask queue, so tests are deterministic.
- [ ] Tests: a job moves queued → running → done; a failing handler lands in `failed` with a message;
      progress is reported; cancel stops a queued job; an unknown id reports nothing rather than
      throwing.
- [ ] Gates, commit.

## Task 98: Log redaction

**Files:** create `apps/api/src/plugins/logging.ts`; test `apps/api/test/logging.test.ts`

- [ ] A logger configured with an explicit allowlist plus a pino redaction config.
- [ ] Tests: **a filename handed to the logger does not appear in the output bytes** — the failure is
      silent, so the test reads the output; the same for file contents and a whole payload; job id,
      type, size, duration, and outcome DO appear.
- [ ] Gates, commit.

## Task 99: The job API

**Files:** create `apps/api/src/{server.ts,routes/jobs.ts}`; test `apps/api/test/jobs.test.ts`

- [ ] `POST /v1/jobs` (multipart), `GET /v1/jobs/:id`, `GET /v1/jobs/:id/result`,
      `DELETE /v1/jobs/:id`.
- [ ] Magic-byte validation; a size cap; `Content-Disposition` sanitised on the way out.
- [ ] Tested through Fastify's `inject` — no port bound.
- [ ] Tests: the happy path end to end; an unknown id is 404 and indistinguishable from a purged one;
      **the result is deleted after a successful read**, so a second read is 404; a failed job still
      deletes its input; a bad magic byte is rejected before anything is stored; an oversized upload
      is rejected; the response never echoes the uploaded filename.
- [ ] Gates, commit.

## Task 100: Rate limiting

**Files:** modify `apps/api/src/server.ts`, create `apps/api/src/plugins/rateLimit.ts`;
test `apps/api/test/rateLimit.test.ts`

- [ ] Per IP and per job type, with different budgets per type.
- [ ] Applied BEFORE the body is consumed, so a flood costs bandwidth rather than disk.
- [ ] Tests: the limit trips at the configured count; a different IP is unaffected; **exhausting one
      job type does not block another**; the response says when to retry.
- [ ] Gates, commit.

## Task 101: The converter interface and HTML → PDF

**Files:** create `apps/worker/src/{index.ts,converters/types.ts,converters/html.ts}`;
test `apps/worker/test/html.test.ts`

- [ ] `Converter` interface; a registry keyed by job type.
- [ ] `html.ts` via Playwright, **JavaScript disabled and no network access** — converting a document
      must not fetch a tracking pixel, and HTML is attacker-controlled input.
- [ ] A wall-clock timeout that kills the browser.
- [ ] Tests: real HTML in, real `%PDF-` bytes out; a remote resource is not fetched; a script does not
      run; a timeout is enforced; the registry has no entry for office or OCR.
- [ ] Gates, commit.

## Task 102: PDF → JPG, client-side

**Files:** create `packages/pdf-core/src/raster.ts`, `apps/web/src/features/export/ImageExport.vue`;
tests `packages/pdf-core/test/raster.test.ts`, `apps/web/test/features/ImageExport.test.ts`

- [ ] `rasterisePage(doc, index, dpi, format)` → JPEG or PNG bytes.
- [ ] A dialog: DPI choice, page range, one file or a zip via the existing `lib/zip.ts`.
- [ ] **No consent step**, because nothing leaves the device — and the dialog says so.
- [ ] Tests: output is a real JPEG/PNG; DPI changes the pixel dimensions; a range exports those pages;
      several pages produce a zip; the copy states no upload occurs.
- [ ] Gates, commit.

## Task 103: The consent flow

**Files:** create `apps/web/src/features/convert/ConsentDialog.vue`;
test `apps/web/test/features/ConsentDialog.test.ts`

- [ ] Names the file and its size, what will happen to it, and when it is deleted.
- [ ] No pre-ticked box and no "don't show again" — a consent skippable by muscle memory is not one.
- [ ] Tests: the dialog names the file, the operation, and the deletion policy; the action is
      disabled until consent is given; cancelling uploads nothing; **it states this is the only
      feature that uploads anything**.
- [ ] Gates, commit.

## Task 104: The job UI

**Files:** create `apps/web/src/features/convert/{JobPanel.vue,useJob.ts}`;
test `apps/web/test/features/JobPanel.test.ts`

- [ ] Progress, an error state, a download, and a purge control.
- [ ] Polling with backoff; stops on a terminal status.
- [ ] Tests: progress renders; a failure shows the reason; downloading fetches once; purge deletes and
      says so; **`expired` reads as "deleted on schedule", not as an error**; polling stops when the
      job is done.
- [ ] Gates, commit.

## Task 105: Containers and the sandbox — written, unverified

**Files:** create `infra/{Dockerfile.api,Dockerfile.worker,compose.yaml,seccomp.json}`,
`docs/findings/17-deploy-verification.md`

- [ ] **Every file opens with a marker**: never executed, no Docker daemon was available, and a
      pointer to the checklist.
- [ ] API and worker as separate images. Worker: no network egress, read-only rootfs except its
      tmpdir, non-root user, dropped capabilities, seccomp, memory and CPU limits.
- [ ] The checklist names what to run, what to observe, and what a pass looks like — including
      confirming egress is actually blocked rather than assumed.
- [ ] No test, because there is nothing here that can be run. Saying so is the deliverable.
- [ ] Gates, commit.

## Task 106: Phase verification

**Files:** create `docs/findings/18-phase-7-verification.md`; modify `PLAN.md` §7

- [ ] All four gates. Record what is covered, what is written but unverified, and what is absent.
- [ ] State plainly that the MVP's "no backend" property still holds: the API is optional and the app
      works entirely without it.
- [ ] Commit, merge to master.

---

## Plan self-review

**Design coverage.** §1 → Tasks 95, 99. §2 → 96. §3 → 98. §4 → 100. §5 → 103. §6 → 101. §7 → 102.
§8 → 105. §9 needs no task. §10 is distributed.

**Ordering.** Shared DTOs first, because everything else imports them. Storage and queue before the
API that composes them. The converter after the API that dispatches to it. The client work (102–104)
last, since it consumes the finished contract — except PDF → JPG, which depends on nothing and could
have gone anywhere.

**The scope reduction is deliberate and recorded** in design §0 and the pre-flight, not implied by
absence.
