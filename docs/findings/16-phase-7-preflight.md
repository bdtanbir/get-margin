# Phase 7 pre-flight — what this environment can actually run

Phase 7 is the first phase with infrastructure and attack surface. Before designing it, the question
that matters is which parts can be **built and verified** here versus only **written**.

## What is available

| Tool | Status | Consequence |
|---|---|---|
| Node 20, pnpm | present | The API and worker processes can be built and tested |
| Playwright + Chromium | present | **HTML → PDF is fully verifiable** |
| MuPDF (wasm) | present | **PDF → JPG is fully verifiable**, and is client-side by design |
| Docker CLI | present, **no daemon** | Images can be written; nothing can be built or run |
| Redis | absent | BullMQ cannot be exercised against a real broker |
| LibreOffice / `unoserver` | absent | Office conversion cannot be run or measured |
| `ocrmypdf` / Tesseract / Ghostscript | absent | OCR cannot be run or measured |

```
docker info  -> Cannot connect to the Docker daemon at unix:///var/run/docker.sock
```

## The two converters that DO work here

**HTML → PDF**, via Playwright's `page.pdf()`:

```
html->pdf: 17,590 bytes in 562ms, output begins %PDF-
```

Real, fast, and testable on every commit. It is also the one converter whose engine this repository
already depends on, so it adds no deployment weight the project was not already carrying for e2e.

**PDF → JPG**, client-side through MuPDF — `page.toPixmap(...)` → `asJPEG(quality)`:

| DPI | Pixels | JPEG | PNG | Time |
|---|---|---|---|---|
| 72 | 612×792 | 10 KB | 8 KB | 48 ms |
| 150 | 1275×1650 | 34 KB | 20 KB | 118 ms |
| 300 | 2550×3300 | 119 KB | 53 KB | 455 ms |

`PLAN.md` §3 already lists PDF → JPG under "client-side only (no network, ever)". It needs no
backend at all, and at these timings it needs no job queue either.

## What this means for the phase

The spec's own security requirement is the sharpest constraint (`PLAN.md` §4):

> **Sandbox the converters — this is the real security surface.** LibreOffice, Tesseract, and
> Ghostscript are large C++ codebases parsing untrusted, attacker-controlled input, and they have a
> long history of RCE CVEs.

…and §7 adds: *"Do the sandboxing in this phase, not after."*

That requirement cannot be met here. A seccomp profile, a read-only rootfs, dropped capabilities, and
a process-group kill can all be **written**, and none of them can be **run**. Shipping unverified
sandbox configuration for parsers with a documented RCE history is worse than shipping none, because
it reads as protection. The same applies to `unoserver` and `ocrmypdf` converter code: written
against an API nobody here can call, tested only against mocks of itself.

So the phase splits cleanly, and the split is not a matter of taste:

**Verifiable here, end to end**
- The job API contract — `POST /v1/jobs`, `GET /v1/jobs/:id`, result, `DELETE` — with zod schemas in
  `packages/shared` so client and server cannot drift
- The queue behind an interface, with an in-process implementation; BullMQ is one adapter
- Storage adapter, unguessable 32-byte job ids, TTL expiry, delete-on-download, and the sweeper
- Rate limiting per IP and per job type
- Pino redaction — never logging filenames, contents, or payloads
- The consent flow, which is the privacy promise's load-bearing UI
- **HTML → PDF** as the working reference converter
- **PDF → JPG**, client-side, no backend involved
- The job UI: progress, cancellation, purge

**Writable but not verifiable here**
- Dockerfiles and compose topology (API and worker as separate containers)
- The sandbox: seccomp, read-only rootfs, capability drops, memory/CPU limits, timeouts
- `unoserver` (Office ↔ PDF) and `ocrmypdf` (OCR) converters
- BullMQ against a real Redis

## Recommendation

Build the first list properly and completely. For the second, write the configuration and the
converter *interface*, mark every unverified file explicitly at the top of the file rather than in a
document nobody opens, and produce a verification checklist naming exactly what must be run before
any of it is deployed.

Do **not** implement `unoserver` and `ocrmypdf` converters as unverifiable code in this pass. The
converter interface plus one working implementation (HTML) is what lets them be added later against a
real environment, by someone who can run them — which is a better foundation than two adapters
written blind.

This is a scope reduction against `PLAN.md` §7, and it is the honest one.
