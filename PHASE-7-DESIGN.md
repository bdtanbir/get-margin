# Phase 7 — Conversion backend

**Spec:** `PLAN.md` §3, §4, §5, §7. **Pre-flight:** `docs/findings/16-phase-7-preflight.md`, which
determined the shape of this phase more than any design decision did.

## 0. What this phase delivers, and what it deliberately does not

The pre-flight found that most of Phase 7 cannot be *run* here: no Docker daemon, no Redis, no
LibreOffice, no Tesseract, no Ghostscript. That is not a reason to write it anyway. `PLAN.md` §4 is
explicit that the converters **are** the security surface — large C++ parsers with a documented RCE
history, fed attacker-controlled input — and unverified sandbox configuration for those is worse than
none, because it reads as a control.

So the phase is scoped by verifiability, not by feature count.

**Built and tested**
- The job API contract, with zod schemas shared between client and server so they cannot drift
- A queue behind an interface, with an in-process implementation; BullMQ becomes one adapter later
- Storage: unguessable job ids, TTL, delete-on-download, a sweeper
- Rate limiting, per IP and per job type
- Log redaction — filenames, contents, and payloads never reach the log
- The consent flow, which is where the privacy promise is actually kept
- **HTML → PDF**, the one converter whose engine this repo already ships
- **PDF → JPG**, client-side, which needs no backend at all

**Written, marked unverified in the file itself**
- Dockerfiles, compose topology, seccomp profile, capability drops, resource limits

**Not written**
- `unoserver` and `ocrmypdf` adapters. A converter interface plus one working implementation is a
  better foundation for whoever can run them than two adapters written blind. Phase 6's `subsetFonts`
  is the argument: it looked correct, extraction agreed, and it moved every glyph on the page.

## 1. The shape of a job

Stateless async jobs, per §3 — a synchronous HTTP call would time out on work that takes minutes.

```
POST   /v1/jobs          multipart  → { jobId, statusUrl }
GET    /v1/jobs/:id                 → { status, progress, error?, resultReady }
GET    /v1/jobs/:id/result          → the file; deleted immediately after a successful read
DELETE /v1/jobs/:id                 → client-initiated purge
```

`packages/shared` holds the zod schemas. The API validates every request against them and the client
imports the same types, so a field renamed on one side is a type error on the other rather than a
runtime surprise.

**Job ids are 32 random bytes**, base64url. Not sequential, not derived from anything about the file.
An id is the only credential for reading a result, so it has to be unguessable — and it doubles as
the storage directory name, so enumeration of the storage root reveals nothing either.

**Status is a small closed set**: `queued`, `running`, `done`, `failed`, `expired`. `expired` is
distinct from `failed` on purpose: a user who comes back after an hour should be told their file was
deleted on schedule, not that something went wrong.

## 2. Storage, and deletion as the default

The privacy claim is only as good as the deletion, so deletion is unconditional and happens on four
independent paths:

1. **On successful download.** The result is read once and removed.
2. **On TTL**, one hour, whether or not anything read it.
3. **On explicit purge**, `DELETE /v1/jobs/:id`, offered in the UI.
4. **On sweep**, for orphans left by a crash between steps.

Deletion is never contingent on the job succeeding. A conversion that fails still leaves an uploaded
file on disk, and that file is the thing that matters.

`StorageAdapter` is an interface with a local-disk implementation. S3 is a later adapter, not a
rewrite. The sweeper is a plain interval in-process rather than a cron container, because a cron that
has to be deployed separately is a cron that eventually is not.

## 3. Logging: redaction is the design, not a setting

§4 requires that filenames, contents, and payloads never be logged, and notes that the default is to
log whatever you hand it. So the logger is configured with an explicit allowlist shape: job id, job
type, byte size, duration, outcome. Nothing else is passed to it in the first place, and a redaction
config catches what slips through.

A filename is user data. It also frequently *is* the sensitive thing — `2024-tax-return-jane-doe.pdf`
— which is the same argument the privacy page already makes about IndexedDB.

## 4. Rate limiting

Per IP and per job type. Conversion is expensive and unauthenticated; without limits it is a free CPU
faucet. The limits differ by type because the costs differ by an order of magnitude — an HTML render
is under a second, an OCR pass is minutes.

Rate limiting lives in front of the upload, not behind it, so a flood costs bandwidth rather than
disk.

## 5. Consent: the load-bearing UI

Everything else in this product is client-side and says so. A conversion is the first time a file
leaves the device, and §4 requires an **explicit per-action consent step that names what is being
uploaded and when it is deleted**.

The dialog states, in plain language and without a "learn more" link:

- exactly which file is being sent, by name and size
- what will be done to it
- that it is deleted after download, and in any case within an hour
- that this is the only feature in the app that uploads anything

No pre-ticked box, no "don't show again". A consent that can be skipped by muscle memory is not
consent, and this is the one place in the product where that matters.

## 6. Converters

```ts
type Converter = {
  readonly type: JobType
  convert(input: Uint8Array, opts: ConvertOptions): Promise<Uint8Array>
}
```

**HTML → PDF** via Playwright, which the repo already depends on. It runs with JavaScript disabled
and no network access by default: converting a document should not fetch a tracking pixel, and an
HTML file is attacker-controlled input like any other.

`office` and `ocr` are absent, not stubbed. A stub that throws at runtime is a feature that appears
in the UI and fails; the job type registry simply does not contain them, so the UI never offers them.

## 7. PDF → JPG, client-side

`PLAN.md` §3 lists this under "client-side only (no network, ever)", and the pre-flight measured it at
48 ms to 455 ms across 72–300 DPI. It needs no API, no queue, and no consent step, because nothing
leaves the device.

It ships as an export option alongside Download: choose a DPI, get a JPEG per page, several pages as
a zip via the existing `lib/zip.ts`.

## 8. Containers and sandboxing — written, not verified

Every file carries a header saying it has never been executed and naming what must be run before it
is trusted. The intent, per §4 and §5:

- API and worker are **separate containers**. The API is small and public; the worker parses
  untrusted files. Coupling them puts a public HTTP surface in the blast radius of the parsers.
- The worker has **no network egress**, a **read-only root filesystem** except its job tmpdir, a
  **non-root user**, **dropped capabilities**, a **seccomp profile**, hard **memory and CPU limits**,
  and a **wall-clock timeout that kills the process group** — LibreOffice hangs on malformed input
  reliably rather than rarely.

`docs/findings/17-deploy-verification.md` is the checklist: what to run, what to observe, and what a
pass looks like. Until someone runs it, this configuration is a proposal.

## 9. Out of scope, stated

- **Office conversion and OCR.** See §0.
- **S3 storage.** The adapter interface exists; the implementation does not.
- **Horizontal scaling, autoscaling, and deployment pipelines.**
- **Accounts, quotas, and billing.** The spec puts these in Phase 8 if at all.
- **Client-side OCR fallback.** §3 mentions it as an option; it is a separate piece of work.

## 10. Testing

- The API is tested through Fastify's `inject`, so no port is bound and the tests are fast and
  deterministic.
- Storage TTL and the sweeper are tested with an injected clock rather than by sleeping.
- Deletion is asserted on all four paths, including after a failed job.
- Redaction is tested by handing the logger a filename and asserting it does not appear in the
  output — the failure mode is silent, so the test has to look at the bytes.
- Rate limiting is tested per type, including that one type's exhaustion does not block another.
- HTML → PDF is tested end to end: real Playwright, real bytes, `%PDF-` in the output.
- The consent flow is tested for what it says, not just that it exists — a consent dialog that omits
  the deletion policy is the failure worth catching.
