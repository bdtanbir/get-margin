# Phase 7 verification — conversion backend

Tasks 95–106. **1,542 unit tests, 89 e2e** across desktop and phone, clean `tsc`, `vue-tsc`, and
build. Phase 6 ended at 1,325; this phase added 217, of which 134 are new backend and worker code
that did not exist before.

## The headline: the phase was scoped by what could be verified, and that scope held

`docs/findings/16-phase-7-preflight.md` found that most of Phase 7 cannot be *run* here — no Docker
daemon, no Redis, no LibreOffice, no Tesseract, no Ghostscript. `PHASE-7-DESIGN.md` §0 turned that
into a scope decision rather than a reason to write code blind, on the grounds that `PLAN.md` §4
names the converters as the real security surface and unverified sandbox configuration for them is
worse than none.

That decision survived contact with the work, and it was tested twice:

- **The seccomp profile forced the same call again, and sharper.** Docker's
  `security_opt: seccomp:<file>` *replaces* the built-in profile rather than merging with it, and
  the built-in is deny-by-default over roughly 300 syscalls. A hand-written allow-by-default deny
  list applied directly would have swapped a strict profile for a permissive one — hardening that
  measurably *reduces* security while reading as a control in a review. It ships as a documented
  merge input with the compose line commented out, which is the honest configuration and the less
  impressive-looking one.
- **`office` and `ocr` are absent from the type system**, not stubbed. The registry has no entry,
  `JobType` has no member, and there are tests asserting both. A stub that throws at runtime is a
  feature the UI offers, the user picks, and that fails *after* the upload.

## The MVP's "no backend" property still holds

**The app still works entirely without the API, and that is the default build.**
`CONVERT_API_BASE` is empty unless `VITE_CONVERT_API` is set. With nothing configured, conversion
is not offered, no upload is possible, and the privacy page's absolute claim — "nothing is uploaded,
and there is no server to upload it to" — is literally true.

That claim needed work. It was written for a build with no backend and would have become false the
moment one existed. It is now conditional on the flag, and the build that *does* have a service
names the exception and its deletion policy instead. Both branches have tests. Phase 6 already had
to fix this page for understating what gets stored (`0882f3d`); this was the same failure pointed
the other way.

PDF → JPG, the other conversion this phase shipped, needs no backend at all and says so in the
dialog.

## Covered on every commit

| Area | Check | Where |
|---|---|---|
| Job ids | 43 base64url chars, no repeat in 10,000 draws, nothing a path could use to escape | `api/test/storage.test.ts` |
| Storage | Round-trip, per-slot delete, idempotent delete, age from an injected clock, path traversal refused | `api/test/storage.test.ts` |
| Sweeper | Expired removed, fresh kept, empty root a no-op, vanished job mid-sweep survives, `onExpire` names what it removed | `api/test/storage.test.ts` |
| Queue | queued → running → done, failure carries a message, progress, cancel, unknown id, deletion on the failure path | `api/test/queue.test.ts` |
| Log redaction | A filename handed to the logger **does not appear in the output bytes**; same for contents and payload; id, type, size, duration, outcome do | `api/test/logging.test.ts` |
| Job API | Happy path, 404s indistinguishable, result deleted by the read, failed job's input deleted, oversized rejected, filename never echoed | `api/test/jobs.test.ts` |
| Magic bytes | PDF/zip/PNG/ELF wearing an `.html` name rejected, binary by NUL, prose without a tag, **and nothing written to disk** | `api/test/jobs.test.ts` |
| Rate limiting | Trips at the count, per address, **one type's exhaustion does not block another**, reads on their own budget, retry-after, refuses before reading the body | `api/test/rateLimit.test.ts` |
| HTML → PDF | Real bytes, `%PDF-`, text read back with MuPDF, multi-page, malformed markup still renders | `worker/test/html.test.ts` |
| No network | A **real HTTP server on a real port** records zero requests for a stylesheet, an image, an iframe, and a script's `fetch` | `worker/test/html.test.ts` |
| No scripts | A script that would rewrite the page's text; the PDF still says `SAFE` and never `EXECUTED` | `worker/test/html.test.ts` |
| Timeout | Wall clock fires mid-flight, browser closed, message in seconds not Chromium internals | `worker/test/html.test.ts` |
| Registry | Exactly one converter; no entry for office or OCR under four spellings | `worker/test/html.test.ts` |
| PDF → JPG | Output decoded by a JPEG frame-header parser and by pngjs; DPI changes dimensions; rotation swap; quality changes bytes not size | `pdf-core/test/raster.test.ts` |
| Image export UI | One page a plain image, several a zip, range respected, PNG path, dimensions shown before committing | `web/test/features/ImageExport.test.ts` |
| Consent | Names file and size, the operation, and the deletion policy in both halves; **states it is the only feature that uploads**; disabled until ticked; no skip control; fresh mount asks again | `web/test/features/ConsentDialog.test.ts` |
| Job UI | Progress, failure reason, download fires once, purge, **`expired` reads as deleted on schedule and not in red**, polling stops on terminal, backoff widens | `web/test/features/JobPanel.test.ts` |
| Privacy page | The absolute no-upload claim only in the build with no service; the exception named with its policy in the build that has one | `web/test/features/PrivacyPage.test.ts` |

## Two things the tests found that review did not

**A purge could lose to a conversion.** The worker suite surfaced it as an intermittent `ENOTEMPTY`.
A conversion finishing just after a purge would write its result back into the directory the purge
had removed, recreating it — a file the user was told was deleted, surviving until the sweeper an
hour later. Silent, and on the exact path the privacy claim rests on. `forget` now happens before
the delete, and a completion for a forgotten job writes nothing.

The wide path (purge during a running job) is covered by cancellation. The narrow one — a purge
landing between the handler resolving and its result being written — has no cancellation to catch
it, and has its own test driving `forget` without `cancel`. I confirmed that test fails when the
guard is removed.

**I verified the security tests can fail.** A test asserting a browser did not fetch something
passes just as well when the fetch never had a chance to happen. So each was checked against a
broken build: enabling `javaScriptEnabled` fails the script test, and commenting out the request
block fails both network tests. Without that check they would be assertions about nothing.

## Written, never executed

`infra/Dockerfile.api`, `infra/Dockerfile.worker`, `infra/compose.yaml`, `infra/seccomp.json`.
Every file opens with a header saying it has never been built or run, quoting the `docker info`
failure, and pointing at `docs/findings/17-deploy-verification.md`.

The checklist is ten items with commands, expected output, and what a pass looks like. **Two are
expected to fail as written**, and say so:

1. The Chromium apt dependency list was typed from documentation rather than resolved by apt.
2. `apps/worker/src/main.ts` does not exist. The worker ships a converter registry and a handler
   factory; the queue-consuming entrypoint belongs to whoever wires BullMQ, because the only queue
   here is in-process and there is no Redis to consume from.

Egress has its own item and its own argument, because it is the property people assume rather than
test, and the cloud metadata endpoint is called out separately: reaching it turns "rendered a
document" into "has your IAM role".

## Absent, deliberately

- **`unoserver` and `ocrmypdf` adapters.** `PHASE-7-DESIGN.md` §0. Phase 6's `subsetFonts` is the
  argument: it looked correct, an independent extractor agreed with it, and it moved every glyph on
  the page. Code written against an API nobody here can call, tested only against mocks of itself,
  is that failure with a longer fuse.
- **BullMQ.** `JobQueue` is an interface with an in-process implementation. An adapter tested
  against a mock of Redis proves nothing about Redis.
- **S3 storage.** `StorageAdapter` is an interface; `delete(id, slot?)` exists precisely so the S3
  adapter is an addition rather than a rewrite of every call site.
- **Client-side OCR.** A separate piece of work, per the design's §9.

## Known limits, stated

- **The rate limiter is per process.** With N API containers the effective limit is N times the
  configured one. A shared counter needs Redis. The class comment says this rather than leaving it
  to be discovered under load.
- **The in-process queue means the API runs converters in its own process** when handlers are
  registered there. The deployment topology separates them; the code supports both, and only the
  first is exercised here.
- **`expired` is derived, not stored.** After the TTL the sweeper forgets the record too, so an old
  id becomes a 404 rather than an `expired`. That is the honest answer — nothing about the job is
  retained — but it means `expired` is reported for a window rather than forever.

## Gates

```
pnpm test                      1,542 passed, 1 skipped, 120 files
pnpm -r typecheck              tsc, tsc, vue-tsc — clean
pnpm -r build                  clean
pnpm --filter @margin/web e2e  89 passed, 4 skipped
```

The full suite was run repeatedly while chasing the `ENOTEMPTY` flake described above; it is green
across consecutive runs since the fix.
