# Findings: encryption and save options

Probe: `spikes/10-encryption.ts` (numbered 10 — spikes 01–09 already existed in the repo).
Run with `export PATH=/opt/homebrew/bin:$PATH && pnpm tsx spikes/10-encryption.ts`.
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
   strings: `decompress`, `compress-fonts`, `compress-images`, `ascii`, `pretty`, `linearize`,
   `clean`, `sanitize`, `garbage`, `compact`, `deduplicate`, `encrypt`, `decrypt`,
   `owner-password`, `user-password`, `regenerate-id`, `incremental`, `continue-on-error`
   (approximate list — this is prose-adjacent string extraction, not a parsed grammar). Also
   present as literal encryption-method values: `rc4-40`, `rc4-128`, `aes-128`, `aes-256`.
2. **Directly probed and confirmed by throwing**, which is the stronger evidence: bad
   options/values do not silently no-op, they throw a catchable JS `Error`:
   - `"not-a-real-option=yes"` → `warning: unknown pdf option: not-a-real-option=yes` /
     `warning: dropping unprocessed options` → **THREW**: `Unused pdf arguments found`
   - `"garbage=not-a-real-mode"` → **THREW**: `unknown garbage option in options`
   - `"compress=maybe"` → `warning: invalid pdf option: compress=maybe` → **THREW**:
     `invalid pdf options found`

There is no `permissions=` key found as a literal string in the binary (only the internal error
message `encryption dictionary missing permissions`); permission flags were set successfully via
`hasPermission()` checks after auth (see Q2/Q3) but no dedicated `permissions=` write-option key
was found or tested to work. `Document.PERMISSION` / `DocumentPermission` (`mupdf.d.ts:332,373`)
is a **read-side** enum for `hasPermission()`, not confirmed as a save-option key.

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

Verified by Preview: not run directly (no interactive Preview.app session in this environment),
but the equivalent macOS system service was used instead — see the two independent, non-MuPDF
checks below, which are strictly stronger than "Preview showed a password prompt" because they
inspect the file bytes/CoreGraphics's own handling rather than relying on a human glance.

### Non-MuPDF confirmation (two independent checks, both macOS-native, neither uses MuPDF)

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
$ qlmanage -t -s 400 -o /tmp/ql-enc-test spikes/out-enc.pdf
$ qlmanage -t -s 400 -o /tmp/ql-dec-test spikes/out-dec.pdf
```

Both commands exit 0 and "succeed" in the sense of producing a PNG — but the *content* differs
decisively: the encrypted file's thumbnail (`out-enc.pdf.png`, 5.7KB) is a generic grey padlock
icon — CoreGraphics refuses to render page content without a password and falls back to the
system's locked-document placeholder. The decrypted file's thumbnail (`out-dec.pdf.png`, 20.5KB)
shows the actual rendered page text ("Page 1 of 300", "Line 0: the quick brown fox jumps...").
This is the visual equivalent of a Preview password prompt, produced by Apple's own PDF stack,
independent of MuPDF.

A third, weaker signal was also checked: `sips -g all` succeeds (exit 0) on both files and
reports geometry for both (PDF page size lives outside the encrypted stream contents), but only
the decrypted file's output includes the `/Info` dictionary metadata fields (`creation`,
`software`, `artist`) — the encrypted file's copy of those strings is unreadable to `sips`
without the password, so they're silently omitted. This agrees with the other two checks but is
not decisive on its own (both invocations "succeed").

## Q3 — Decryption round-trip

authenticatePassword works: **YES**
```
needsPassword: true
authenticatePassword("wrong"): 0
authenticatePassword("secret"): 2
hasPermission("print") after auth: true
hasPermission("edit") after auth: true
```
(`authenticatePassword` returns a numeric auth-level code — `0` = failed, non-zero = succeeded
at some permission level; `2` here means the *user* password was accepted, per mupdf's
convention where owner-password auth returns a higher value. Not independently probed further —
only pass/fail was needed for this spike.)

Save-as-decrypted works: **YES**. `d.saveToBuffer('decrypt=yes,compress')` succeeded (with a
`the decrypt write option is deprecated, use encrypt=none instead` warning — still functional,
not yet removed in 1.28.0) and produced `spikes/out-dec.pdf`, which reopens with
`needsPassword() === false`. Confirmed independently by both non-MuPDF checks above (no
`/Encrypt` in `strings`, real content in `qlmanage`'s thumbnail).

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

**Caveat carried forward for implementation (Task 8+):** the `encrypt=` key is mandatory and
non-obvious — omitting it while still passing `user-password=`/`owner-password=` silently
produces an unprotected file with no error (measured directly, see Q2 table). Any
password-protection feature must always construct the options string with an explicit
`encrypt=aes-256` (or another explicit `encrypt=` method), never rely on password keys alone, and
should consider asserting `needsPassword() === true` on the just-saved output before treating a
"protect this PDF" action as successful — the same assertion this spike used.

PLAN.md §2.3/§8 should be updated to move `qpdf-wasm` from "conditional" to **not included**
(it is not needed at all, not merely "included and lazy-loaded").
