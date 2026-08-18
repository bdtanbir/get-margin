# Findings: encryption and save options

> **Note:** `spikes/…` paths referenced below were throwaway probe scripts, deleted with Phase 0
> (commit `e5bdcc3`) and never committed. The durable regression proofs are
> `packages/transform/test/transform.test.ts` (MuPDF matrix cross-check),
> `packages/pdf-core/test/render.test.ts` (rotation/layout agreement, premultiplied compositing)
> and `docs/findings/evidence/`.

Probes (both committed, both runnable):
- `spikes/10-encryption.ts` (numbered 10 — spikes 01–09 already existed in the repo). Run with
  `export PATH=/opt/homebrew/bin:$PATH && pnpm tsx spikes/10-encryption.ts`. Produces
  `spikes/out-enc.pdf` / `spikes/out-dec.pdf` (both committed as evidence artifacts).
- `spikes/10-verify.sh` — the non-MuPDF corroboration (Q2), runnable independently against the
  two committed PDFs above: `bash spikes/10-verify.sh`.

Fixture: `packages/pdf-core/test/fixtures/large-300p.pdf` (636KB source, 300 pages).
mupdf **1.28.0** (not the brief's assumed `^1.26.0`).

## Q1 — saveToBuffer options

`saveToBuffer(options?: string | Record<string, any>): Buffer` (`mupdf.d.ts:518`). There is
**no shipped enumeration/union type** for the options string — it is typed as a bare `string`.
The `Record<string, any>` overload is real: `mupdf.js`'s JS wrapper (`dist/mupdf.js:2052-2069`)
stringifies an object into `k=v` pairs joined by `,` (booleans become `yes`/`no`) before handing
it to the wasm entry point `_wasm_pdf_write_document_buffer`. Confirmed working: `{compress:
true}` saved without error.

The only enumeration available is **runtime validation baked into the wasm binary**, extracted
two ways:

1. `strings packages/pdf-core/node_modules/mupdf/dist/mupdf-wasm.wasm` surfaces the literal key
   strings: `decompress`, `compress-fonts`, `compress-images`, `ASCII`, `pretty`, `linearize`,
   `clean`, `sanitize`, `garbage`, `compact`, `deduplicate`, `encrypt`, `decrypt`,
   `owner-password`, `user-password`, `regenerate-id`, `incremental`
   (approximate list — this is prose-adjacent string extraction, not a parsed grammar; an earlier
   draft of this list also included `continue-on-error`, which does not actually appear in the
   binary — checked with `strings ... | grep -xE "continue-on-error"`, no match — and has been
   removed rather than left as an unverified guess). Also present as literal encryption-method
   values: `rc4-40`, `rc4-128`, `aes-128`, `aes-256`.
2. **Directly probed and confirmed by throwing**, which is the stronger evidence: bad
   options/values do not silently no-op, they throw a catchable JS `Error`:
   - `"not-a-real-option=yes"` → `warning: unknown pdf option: not-a-real-option=yes` /
     `warning: dropping unprocessed options` → **THREW**: `Unused pdf arguments found`
   - `"garbage=not-a-real-mode"` → **THREW**: `unknown garbage option in options`
   - `"compress=maybe"` → `warning: invalid pdf option: compress=maybe` → **THREW**:
     `invalid pdf options found`

There is no `permissions=` key found as a literal string in the binary (only the internal error
message `encryption dictionary missing permissions`). It was nonetheless directly probed and
**does work and is enforced** — see Q3b — despite not appearing as a literal string (it's likely
built with `sprintf("permissions=%d", ...)`-style formatting internally, so the bare key never
appears as a standalone string constant). `Document.PERMISSION` / `DocumentPermission`
(`mupdf.d.ts:332,373`) is the **read-side** enum consumed by `hasPermission()`; note the shipped
`.d.ts` has a typo in one of its static constants — `PERMISSION_EDIT = "eedit"` (double e, line
367) — confirmed present in the installed package, not a transcription error here. The runtime
`Document.PERMISSION` map itself uses ASCII character codes as values (e.g. `print: 112` = `'p'`,
`copy: 99` = `'c'`), which is mupdf's internal single-letter permission-code convention (matching
mutool's CLI flags) and is **unrelated to** the numeric PDF-spec permission bitmask accepted by
the `permissions=` save option (bit 3 = 4 = print, bit 5 = 16 = copy, etc. — see Q3b). Two
different numbering schemes for "permission", easy to conflate.

**Important pitfall, confirmed directly (this is the crux of Q2 below):** a save option string
that is *not recognized as an encryption directive* does **not** throw and does **not**
encrypt — it is silently accepted as plain metadata/no-op. `"user-password=secret,owner-password
=owner"` (no `encrypt=` key) saved cleanly and produced a file with `needsPassword() === false`.
Validation catches malformed syntax, not missing intent.

Source of truth used: `packages/pdf-core/node_modules/mupdf/dist/mupdf.d.ts` (types) +
`strings .../mupdf-wasm.wasm` (runtime-accepted keys) + direct probing (actual accept/reject
behaviour). No local copy of upstream mupdf C API docs (`mupdf.readthedocs.io`, referenced in
`package.json`) was fetched — not needed once the probe gave a working option string.

## Q2 — Writing encrypted PDFs

**SUPPORTED: YES.**

Working option string: `encrypt=aes-256,user-password=secret,owner-password=owner`

Full candidate sweep (all on `large-300p.pdf`, 636KB source):

| option string | result |
|---|---|
| `encrypt=aes-256,user-password=secret,owner-password=owner` | saved 623KB, **needsPassword=true** — WORKS |
| `encrypt=aes256,user-password=secret,owner-password=owner` (no hyphen) | **THREW**: `unknown encryption in options` |
| `encryption=aes-256,user-password=secret` (wrong key name) | **THREW**: `Unused pdf arguments found` |
| `user-password=secret,owner-password=owner` (no `encrypt=` key) | saved 615KB, **needsPassword=false — SILENT FAILURE** |
| `decrypt=no,user-password=secret` | `warning: the decrypt write option is deprecated, use encrypt=none instead`; saved 615KB, **needsPassword=false — SILENT FAILURE** |
| `encrypt=rc4-128,user-password=secret,owner-password=owner` | saved 615KB, needsPassword=true — WORKS |
| `encrypt=aes-128,user-password=secret,owner-password=owner,permissions=4` | saved 622KB, needsPassword=true — WORKS |

The two "SILENT FAILURE" rows are exactly the failure mode the task brief warned about: a save
that **does not throw** and produces a **completely unprotected file with no error**. This is
real and was reproduced, not hypothetical. The lesson for any later implementation: the
`encrypt=` key is mandatory; passing only passwords without it is a no-op, not an error.

Verified by `needsPassword()` on reopen: **YES** — `spikes/out-enc.pdf` (saved with the working
AES-256 string) reopens with `needsPassword() === true`; a document saved with only passwords
(no `encrypt=`) reopens with `needsPassword() === false`.

Verified by Preview: not run directly (no interactive Preview.app session in this environment).
Used instead: `qlmanage`, which drives the same CoreGraphics/Quick Look rendering stack
Preview.app uses — disclosed explicitly, not silently substituted. See the two independent,
non-MuPDF checks below (now committed as `spikes/10-verify.sh`, a runnable script, not just
prose), which are strictly stronger than "Preview showed a password prompt" because they inspect
the file bytes/CoreGraphics's own handling rather than relying on a human glance.

Permission-flag enforcement (user password + owner password + `encrypt=` all confirmed above)
was verified **separately and specifically** — see Q3b below — because a non-throwing save with
a `permissions=` value present is not, by itself, evidence the value does anything.

### Non-MuPDF confirmation (two independent checks, both macOS-native, neither uses MuPDF)

Both checks are now **committed as a runnable companion script**, `spikes/10-verify.sh` — run
`bash spikes/10-verify.sh` against the committed `spikes/out-enc.pdf` / `spikes/out-dec.pdf` to
re-derive this evidence in one command, rather than re-typing the commands below by hand.

**1. `strings` — presence of the `/Encrypt` dictionary in the raw file bytes:**

```
$ strings spikes/out-enc.pdf | grep -i Encrypt
<</Size 605/Info 3 0 R/Root 2 0 R/ID[...]/Encrypt<</Filter/Standard/R 6/V 5/Length 256
 /EncryptMetadata true/StmF/StdCF/StrF/StdCF/CF<</StdCF<</AuthEvent/DocOpen/CFM/AESV3/Length 32>>>>
 /O<...>/U<...>/OE<...>/UE<...>/Perms<...>>>>>

$ strings spikes/out-dec.pdf | grep -i Encrypt
(no output, exit code 1 — no match)
```

`/V 5 /R 6 /CFM/AESV3` in the encrypt dict confirms AES-256 (revision 6, the AES-256 revision)
was actually used, not just requested.

**2. `qlmanage -t` (Apple's CoreGraphics-backed Quick Look thumbnailer — a completely separate
PDF renderer from MuPDF, the same engine Preview and Finder use):**

```
$ bash spikes/10-verify.sh
...
encrypted-file thumbnail: .../enc/out-enc.pdf.png (5717 bytes)
decrypted-file thumbnail: .../dec/out-dec.pdf.png (20472 bytes)
```

Both invocations exit 0 and "succeed" in the sense of producing a PNG — but the *content* differs
decisively, confirmed by visually opening both PNGs (`open` command printed by the script): the
encrypted file's thumbnail (5.7KB) is a generic grey padlock icon — CoreGraphics refuses to
render page content without a password and falls back to the system's locked-document
placeholder. The decrypted file's thumbnail (20.5KB) shows the actual rendered page text ("Page 1
of 300", "Line 0: the quick brown fox jumps..."). This is the visual equivalent of a Preview
password prompt, produced by Apple's own PDF stack, independent of MuPDF. (The task brief's
template literally says "verified in Preview" — Preview.app itself was not opened interactively
in this environment; `qlmanage` drives the same underlying CoreGraphics/Quick Look rendering
stack Preview uses, so it's used here as the disclosed substitute, not silently claimed as
"Preview".)

A third, weaker signal was also checked (not scripted into `10-verify.sh` — it's a one-off,
non-repeated observation, not re-derived): `sips -g all` succeeds (exit 0) on both files and
reports geometry for both (PDF page size lives outside the encrypted stream contents), but only
the decrypted file's output includes the `/Info` dictionary metadata fields (`creation`,
`software`, `artist`) — the encrypted file's copy of those strings is unreadable to `sips`
without the password, so they're silently omitted. This agrees with the other two checks but is
not decisive on its own (both invocations "succeed"). To re-check it manually:
`sips -g all spikes/out-enc.pdf` vs `sips -g all spikes/out-dec.pdf`.

## Q3 — Decryption round-trip

authenticatePassword works: **YES**
```
needsPassword: true
authenticatePassword("wrong"): 0
authenticatePassword("secret"): 2
hasPermission("print") after auth (default/full-permission doc): true
hasPermission("edit") after auth (default/full-permission doc): true
```
(`authenticatePassword` returns a numeric auth-level code — `0` = failed, non-zero = succeeded
at some permission level; `2` here means the *user* password was accepted, per mupdf's
convention where owner-password auth returns a higher value. Not independently probed further —
only pass/fail was needed for this spike.)

**The `hasPermission()` calls above prove nothing about enforcement on their own** — `out-enc.pdf`
was saved without any `permissions=` key, so it's full-access by default; of course every
`hasPermission()` check comes back `true`. See Q3b, which tests an actually-restricted document.

Save-as-decrypted works: **YES**. `d.saveToBuffer('decrypt=yes,compress')` succeeded (with a
`the decrypt write option is deprecated, use encrypt=none instead` warning — still functional,
not yet removed in 1.28.0) and produced `spikes/out-dec.pdf`, which reopens with
`needsPassword() === false`. Confirmed independently by both non-MuPDF checks above (no
`/Encrypt` in `strings`, real content in `qlmanage`'s thumbnail).

## Q3b — Permission-flag enforcement (not asked for by name in the brief's 4 questions, but load-bearing for Q1/Q2's permission claims)

**Tested directly, not inferred.** `mupdf.d.ts`'s `Document.PERMISSION` static map (dumped at
runtime) is `{ print: 112, copy: 99, edit: 101, annotate: 110, form: 102, accessibility: 121,
assemble: 97, 'print-hq': 104 }` — ASCII codes for `p`/`c`/`e`/`n`/`f`/`y`/`a`/`h`, mupdf's
internal single-letter permission-code convention (matches mutool's CLI flags). This is a
**different numbering scheme** from the PDF-spec permission bitmask the `permissions=` save
option actually takes (bit 3 = decimal 4 = allow print, bit 5 = decimal 16 = allow copy, etc.,
per ISO 32000). Do not use the `Document.PERMISSION` values as `permissions=` inputs.

Four documents were saved (each `encrypt=aes-256,user-password=secret,owner-password=owner`, one
fixture, `large-300p.pdf`), varying only `permissions=`, then **reopened and authenticated with
the USER password** (not owner — owner authentication always gets full access in PDF encryption
by design, so testing with the owner password would not test enforcement at all) before checking
every `hasPermission()` flag:

```
no permissions= key (default) (permissions=null):
  print=true copy=true edit=true annotate=true form=true accessibility=true assemble=true print-hq=true
print-only (PDF spec bit 3) (permissions=4):
  print=true copy=false edit=false annotate=false form=false accessibility=false assemble=false print-hq=false
explicit full access (matches default /P -4 seen in Q2) (permissions=-4):
  print=true copy=true edit=true annotate=true form=true accessibility=true assemble=true print-hq=true
print+print-hq+copy+edit+annotate, no form/accessibility/assemble (permissions=2108):
  print=true copy=true edit=true annotate=true form=false accessibility=false assemble=false print-hq=true
```

(`2108 = 2048 + 32 + 16 + 8 + 4` = print-hq + annotate + copy + edit + print bits set, form/
accessibility/assemble bits clear — and the output matches exactly: those five flags are `true`,
the other three are `false`.)

**PERMISSION ENFORCEMENT WORKS.** `permissions=4` genuinely restricts the saved document to
print-only — after authenticating with the correct *user* password, `hasPermission()` reports
`copy`/`edit`/`annotate`/`form`/`accessibility`/`assemble`/`print-hq` as `false` and only `print`
as `true`. This is not a MuPDF-only artifact of a non-throwing save; the arbitrary bit combination
in the fourth row produced exactly the expected flag pattern, which would be an implausible
coincidence if the value were being silently ignored. **Caveat, stated plainly and not tested
here:** this confirms MuPDF *writes* the restriction into the `/P` value and *reports* it back
correctly via `hasPermission()` — i.e., it's a real, inspectable PDF-level restriction, the kind
any spec-compliant PDF reader is expected to honor. It does **not** demonstrate that MuPDF (or
any other reader) refuses to actually *let a caller* copy/print/edit content once the bytes are
decrypted and in memory — PDF permission bits are a cooperative-reader convention, not a
cryptographic access-control mechanism, and enforcing "no copy" against a determined actor with
the plaintext is out of scope for what any PDF library can guarantee. That distinction did not
need testing to state — it's true of the PDF permission-bits mechanism by design, independent of
mupdf.

## Q4 — Compression savings (large-300p, 636KB source)

| options | output | saving |
|---|---|---|
| `""` (default save) | 615KB | 21KB (3.3%) vs source |
| `compress` | 615KB | identical to default |
| `garbage=compact` | 615KB | identical to default |
| `garbage=deduplicate` | 615KB | identical to default |
| `compress,garbage=deduplicate` | 615KB | identical to default |

**All four save-option variants produced byte-length-identical output (615KB) on this fixture.**
This is a real, if unglamorous, measured result — not an omission. The fixture is a
generator-produced 300-page text-only PDF (`packages/pdf-core/test/fixtures/generate.ts`) with
simple, already-uncompressed-friendly, non-duplicated content streams and no embedded images or
duplicate fonts, so there is nothing for `garbage=compact/deduplicate` to collapse and no
additional stream compression `compress` can find beyond what a bare save already applies (a
bare `saveToBuffer('')` already flate-compresses streams by default). The 21KB drop from the raw
636KB source to any-saved 615KB happens purely from mupdf's default re-serialization (rewritten
xref, no incidental cruft from the original writer), not from any of the option flags tested.
**This result should not be generalized to files with actual redundancy** (duplicate fonts/images,
un-flate-compressed streams, incremental-update cruft) — it was only measured on one
synthetic, already-lean fixture. A future spike on a real-world PDF with embedded images/fonts
would be needed to see `garbage=deduplicate` or `compress` do measurable work.

Encryption's cost, for reference: the AES-256 encrypted save (`encrypt=aes-256,...`) was 623KB
vs 615KB for the equivalent unencrypted save — about 8KB (1.3%) larger, from the added
`/Encrypt` dictionary and per-object encryption overhead.

## DECISION: qpdf-wasm

**NOT NEEDED** — MuPDF 1.28.0's `PDFDocument.saveToBuffer('encrypt=aes-256,user-password=...,
owner-password=...')` writes genuinely encrypted, AES-256, password-protected PDFs. This was
verified three ways: (1) `needsPassword()` returns `true` on reopen with MuPDF itself, (2) an
independent, non-MuPDF engine (`strings`, raw byte inspection) shows a real `/Encrypt` dictionary
with `/CFM/AESV3` (AES-256, revision 6), and (3) a second independent, non-MuPDF engine
(`qlmanage`, Apple's CoreGraphics PDF renderer — the same one Preview and Finder use) refuses to
render the file's content and falls back to a generic locked-document icon, while rendering the
decrypted twin normally. Round-trip decryption also works: `authenticatePassword()` unlocks the
document and a subsequent `saveToBuffer('decrypt=yes,compress')` produces a file that reopens
with `needsPassword() === false` and passes both non-MuPDF checks as unencrypted.

`qpdf-wasm` was **not probed** — per the task brief, Step 3 (`pnpm add -Dw @jspawn/qpdf-wasm`) is
conditional on MuPDF failing to encrypt, which did not happen. No binary size to report.

Permission flags (`permissions=`) work too and are genuinely enforced-in-the-written-bytes, not
merely accepted: see Q3b — a document saved with `permissions=4` (print-only), reopened and
authenticated with the user password, reports `hasPermission('copy'/'edit'/'annotate'/etc.)`
as `false` and only `print` as `true`; an arbitrary bit combination produced the exact expected
flag pattern. So a "restrict printing/copying/editing" feature is buildable on this API, not just
password protection.

**Caveat carried forward for implementation (Task 8+):** the `encrypt=` key is mandatory and
non-obvious — omitting it while still passing `user-password=`/`owner-password=` silently
produces an unprotected file with no error (measured directly, see Q2 table). Any
password-protection feature must always construct the options string with an explicit
`encrypt=aes-256` (or another explicit `encrypt=` method), never rely on password keys alone, and
should consider asserting `needsPassword() === true` on the just-saved output before treating a
"protect this PDF" action as successful — the same assertion this spike used. Any
permission-restriction feature should similarly authenticate with the user password and
spot-check `hasPermission()` on its own output rather than trusting that a non-throwing save
means the restriction took effect.

PLAN.md §2.3/§8 should be updated to move `qpdf-wasm` from "conditional" to **not included**
(it is not needed at all, not merely "included and lazy-loaded").
