import { describe, it, expect } from 'vitest'
import {
  jobType, jobStatus, jobId, isJobType, isTerminal,
  createJobResponse, jobStatusResponse, errorResponse,
  JOB_TYPES, JOB_STATUSES, JOB_ID_LENGTH, JOB_TTL_MS, MAX_UPLOAD_BYTES,
} from '../src/jobs.js'

const ID = 'A'.repeat(JOB_ID_LENGTH)

describe('job types', () => {
  /**
   * A type with no converter is ABSENT rather than stubbed. A stub that
   * throws at runtime is a feature that appears in the UI, gets chosen,
   * and fails after the upload.
   */
  it('offers only what a converter exists for', () => {
    expect(JOB_TYPES).toEqual(['html-to-pdf'])
  })

  it('rejects a type the backend cannot perform', () => {
    // Named in PLAN.md 3, deliberately not implemented -- see the design.
    expect(isJobType('pdf-to-docx')).toBe(false)
    expect(isJobType('ocr')).toBe(false)
    expect(jobType.safeParse('office-to-pdf').success).toBe(false)
  })

  it('accepts the one it can', () => {
    expect(isJobType('html-to-pdf')).toBe(true)
  })

  it('rejects nonsense', () => {
    expect(isJobType('')).toBe(false)
    expect(isJobType(null)).toBe(false)
    expect(isJobType(42)).toBe(false)
  })
})

describe('job status', () => {
  it('has exactly the five states', () => {
    expect(JOB_STATUSES).toEqual(['queued', 'running', 'done', 'failed', 'expired'])
  })

  /**
   * A file deleted on schedule is the product working as promised, not an
   * error. Collapsing the two would make the privacy guarantee look like a
   * bug.
   */
  it('keeps expired distinct from failed', () => {
    expect(jobStatus.parse('expired')).toBe('expired')
    expect(jobStatus.parse('failed')).toBe('failed')
    expect(isTerminal('expired')).toBe(true)
    expect(isTerminal('failed')).toBe(true)
  })

  it('knows which states are worth polling', () => {
    expect(isTerminal('queued')).toBe(false)
    expect(isTerminal('running')).toBe(false)
    expect(isTerminal('done')).toBe(true)
  })

  it('rejects an unknown status', () => {
    expect(jobStatus.safeParse('pending').success).toBe(false)
  })
})

/**
 * The id is the ONLY credential for reading a result, so a lax pattern
 * here would accept a guessable one.
 */
describe('job ids', () => {
  it('accepts a 43-character base64url string', () => {
    expect(jobId.safeParse(ID).success).toBe(true)
    expect(jobId.safeParse('aA0_-'.repeat(8) + 'abc').success).toBe(true)
  })

  it('rejects one that is too short to be unguessable', () => {
    expect(jobId.safeParse('abc').success).toBe(false)
    expect(jobId.safeParse('A'.repeat(20)).success).toBe(false)
  })

  it('rejects a path traversal dressed as an id', () => {
    // The id becomes a directory name, so this is the attack that matters.
    expect(jobId.safeParse('../../etc/passwd').success).toBe(false)
    expect(jobId.safeParse('A'.repeat(41) + '/.').success).toBe(false)
  })

  it('rejects characters outside base64url', () => {
    expect(jobId.safeParse('A'.repeat(42) + '+').success).toBe(false)
    expect(jobId.safeParse('A'.repeat(42) + '=').success).toBe(false)
  })
})

describe('response shapes', () => {
  it('parses a create response', () => {
    expect(createJobResponse.parse({ jobId: ID, statusUrl: `/v1/jobs/${ID}` }).jobId).toBe(ID)
  })

  it('parses a status response with and without the optional parts', () => {
    expect(jobStatusResponse.parse({
      jobId: ID, type: 'html-to-pdf', status: 'queued', resultReady: false,
    }).progress).toBeUndefined()

    expect(jobStatusResponse.parse({
      jobId: ID, type: 'html-to-pdf', status: 'running', progress: 0.5, resultReady: false,
    }).progress).toBe(0.5)
  })

  it('refuses progress outside 0..1', () => {
    const base = { jobId: ID, type: 'html-to-pdf', status: 'running', resultReady: false }
    expect(jobStatusResponse.safeParse({ ...base, progress: 1.5 }).success).toBe(false)
    expect(jobStatusResponse.safeParse({ ...base, progress: -1 }).success).toBe(false)
  })

  it('refuses a status response missing resultReady', () => {
    expect(jobStatusResponse.safeParse({ jobId: ID, type: 'html-to-pdf', status: 'done' }).success)
      .toBe(false)
  })

  it('parses an error response with a retry hint', () => {
    expect(errorResponse.parse({ error: 'Too many requests', retryAfter: 30 }).retryAfter).toBe(30)
  })
})

describe('limits', () => {
  it('deletes files within an hour', () => {
    expect(JOB_TTL_MS).toBe(60 * 60 * 1000)
  })

  it('caps an upload well below the client own file limit', () => {
    expect(MAX_UPLOAD_BYTES).toBeLessThan(150 * 1024 * 1024)
  })
})
