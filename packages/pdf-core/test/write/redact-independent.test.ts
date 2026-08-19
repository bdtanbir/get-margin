import { describe, it, expect, beforeAll } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateFixtures } from '../fixtures/index.js'
import { redactionFor, write } from './redactHelpers.js'

beforeAll(async () => { await generateFixtures() }, 60_000)

/**
 * THE RELEASE GATE, run on every commit rather than once.
 *
 * `PLAN.md` 2.4 makes this a condition of presenting redaction to users as
 * a safety guarantee, and the reasoning is worth restating: every other
 * check in this repository is MuPDF reading output MuPDF wrote. That is the
 * most product-relevant evidence available -- MuPDF *is* the engine users
 * will read these files with -- but it is still one engine agreeing with
 * itself, and for the one feature where being wrong means someone's
 * redacted address reaching a stranger, that is not enough.
 *
 * So: two extractors that share no code with MuPDF. `pypdf` is pure Python;
 * `pdfminer.six` is a separate pure-Python implementation again. If either
 * one can read the text back, the feature is broken however confidently
 * MuPDF reports otherwise.
 *
 * SKIPS LOUDLY. A safety gate that silently no-ops when its tooling is
 * missing is worse than no gate at all, because it reports success. If the
 * venv is absent this suite fails with instructions rather than passing --
 * except in CI-less local runs where SKIP_INDEPENDENT_REDACTION is set
 * deliberately, which still prints why.
 */
const VENV = fileURLToPath(new URL('../../../../.venv-verify/bin/python', import.meta.url))
/** Any python with both libraries importable. */
function findPython(): string | null {
  const candidates = [
    process.env.REDACTION_VERIFY_PYTHON,
    VENV,
    'python3',
  ].filter((c): c is string => !!c)

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-c', 'import pypdf, pdfminer'], { stdio: 'pipe' })
      return candidate
    } catch {
      // Not this one.
    }
  }
  return null
}

const python = findPython()

const SCRIPT = `
import sys, json
from pypdf import PdfReader
from pdfminer.high_level import extract_text

path, target, page = sys.argv[1], sys.argv[2], int(sys.argv[3])
py = PdfReader(path).pages[page].extract_text() or ''
pm = extract_text(path, page_numbers=[page]) or ''
print(json.dumps({
    'pypdf': target in py,
    'pdfminer': target in pm,
    'pypdf_text': py[:200],
}))
`

type Verdict = { pypdf: boolean; pdfminer: boolean; pypdf_text: string }

function extractorsSee(pdf: Uint8Array, target: string, page = 0): Verdict {
  const dir = mkdtempSync(join(tmpdir(), 'margin-redact-'))
  const file = join(dir, 'out.pdf')
  const script = join(dir, 'verify.py')
  writeFileSync(file, pdf)
  writeFileSync(script, SCRIPT)
  const stdout = execFileSync(python!, [script, file, target, String(page)], { encoding: 'utf8' })
  return JSON.parse(stdout) as Verdict
}

describe('redaction, verified by extractors that are not MuPDF', () => {
  if (!python) {
    // Not `it.skip`. A missing gate is a failing gate: the whole point is
    // that nobody can ship redaction on the strength of a suite that
    // quietly stopped checking it.
    const explain =
      'No Python with pypdf and pdfminer.six was found, so redaction could NOT be ' +
      'independently verified. PLAN.md 2.4 makes this a release gate on the feature. ' +
      'Fix with:  python3 -m venv .venv-verify && .venv-verify/bin/pip install pypdf pdfminer.six ' +
      '(or set REDACTION_VERIFY_PYTHON to an interpreter that has them).'

    if (process.env.SKIP_INDEPENDENT_REDACTION) {
      it.skip(`SKIPPED DELIBERATELY — ${explain}`, () => {})
    } else {
      it('has its verification tooling available', () => {
        expect.fail(explain)
      })
    }
    return
  }

  it('a whole word is gone, to both extractors', () => {
    const out = write([redactionFor('simple-text', 0, 'p0', 'Hello')])
    const seen = extractorsSee(out, 'Hello')
    expect(seen.pypdf, `pypdf still reads it: ${seen.pypdf_text}`).toBe(false)
    expect(seen.pdfminer).toBe(false)
  })

  it('a word in the middle of a line is gone, and its neighbours are not', () => {
    const out = write([redactionFor('simple-text', 0, 'p0', 'body')])
    expect(extractorsSee(out, 'body').pypdf).toBe(false)
    expect(extractorsSee(out, 'body').pdfminer).toBe(false)
    // The other half: over-eager removal is its own failure.
    expect(extractorsSee(out, 'Second').pypdf).toBe(true)
  })

  it('part of a word is gone', () => {
    const out = write([redactionFor('simple-text', 0, 'p0', 'extra')])
    const seen = extractorsSee(out, 'extra')
    expect(seen.pypdf).toBe(false)
    expect(seen.pdfminer).toBe(false)
  })

  it('is gone on every page rotation', () => {
    const out = write(
      [0, 1, 2, 3].map((i) => ({ ...redactionFor('rotated', i, `p${i}`, 'rotate'), id: `r${i}` })),
      'rotated', 4,
    )
    for (const page of [0, 1, 2, 3]) {
      const seen = extractorsSee(out, 'rotate', page)
      expect(seen.pypdf, `page ${page} pypdf`).toBe(false)
      expect(seen.pdfminer, `page ${page} pdfminer`).toBe(false)
    }
  })

  // Removal must not depend on the mark: someone who turns off black boxes
  // is choosing an appearance, not opting out of redaction.
  it('is gone even with no black box drawn', () => {
    const out = write([redactionFor('simple-text', 0, 'p0', 'Hello', false)])
    const seen = extractorsSee(out, 'Hello')
    expect(seen.pypdf).toBe(false)
    expect(seen.pdfminer).toBe(false)
  })

  /**
   * The control. If this fails, the extractors are not reading these files
   * at all and every result above is vacuous -- a green suite that proves
   * nothing is the failure mode this test exists to rule out.
   */
  it('reads text that was NOT redacted, so the checks above mean something', () => {
    const out = write([redactionFor('simple-text', 0, 'p0', 'Hello')])
    const seen = extractorsSee(out, 'margin')
    expect(seen.pypdf, 'the extractor sees nothing at all').toBe(true)
    expect(seen.pdfminer).toBe(true)
  })
})
