import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JOB_ID_LENGTH, JOB_TTL_MS, type JobId } from '@margin/shared'
import { newJobId } from '../src/storage/types.js'
import { LocalStorage } from '../src/storage/local.js'
import { Sweeper } from '../src/storage/sweeper.js'

let root: string
let storage: LocalStorage

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'margin-storage-'))
  storage = new LocalStorage(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const bytes = (s: string) => new TextEncoder().encode(s)

describe('newJobId', () => {
  it('is 43 base64url characters -- 32 bytes, unpadded', () => {
    const id = newJobId()
    expect(id).toHaveLength(JOB_ID_LENGTH)
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  /**
   * The id is the only credential for reading a result. A collision would
   * hand one user another user's file, so this asserts the draw is wide,
   * not merely that the function returns a string.
   */
  it('does not repeat across many draws', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 10_000; i++) seen.add(newJobId())
    expect(seen.size).toBe(10_000)
  })

  it('contains nothing a path could use to escape', () => {
    for (let i = 0; i < 500; i++) {
      const id = newJobId()
      expect(id).not.toContain('/')
      expect(id).not.toContain('.')
      expect(id).not.toContain('\\')
    }
  })
})

describe('LocalStorage', () => {
  it('round-trips a file', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('hello'))
    expect(await storage.get(id, 'input')).toEqual(bytes('hello'))
  })

  it('keeps input and result apart', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('source'))
    await storage.put(id, 'result', bytes('converted'))
    expect(await storage.get(id, 'input')).toEqual(bytes('source'))
    expect(await storage.get(id, 'result')).toEqual(bytes('converted'))
  })

  it('uses the job id as the directory name, and writes only its own files', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    expect(await readdir(root)).toEqual([id])
    // `created` carries the arrival timestamp and nothing else -- no name,
    // no size, nothing about the file. See `age`.
    expect((await readdir(join(root, id))).sort()).toEqual(['created', 'input'])
    expect(await readFile(join(root, id, 'created'), 'utf8')).toMatch(/^\d+$/)
  })

  it('reports nothing for a job that does not exist', async () => {
    const id = newJobId()
    expect(await storage.get(id, 'input')).toBeNull()
    expect(await storage.size(id, 'input')).toBeNull()
    expect(await storage.age(id, Date.now())).toBeNull()
  })

  it('reports nothing for a slot that was never written', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    expect(await storage.get(id, 'result')).toBeNull()
    expect(await storage.size(id, 'result')).toBeNull()
  })

  it('deletes both slots and the directory', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('source'))
    await storage.put(id, 'result', bytes('converted'))
    await storage.delete(id)
    expect(await storage.get(id, 'input')).toBeNull()
    expect(await storage.get(id, 'result')).toBeNull()
    expect(await readdir(root)).toEqual([])
  })

  /**
   * Four deletion paths race each other -- download, TTL, purge, sweep.
   * A second delete that throws would turn a normal race into a 500.
   */
  it('deleting twice is not an error', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    await storage.delete(id)
    await expect(storage.delete(id)).resolves.toBeUndefined()
  })

  it('reports size in bytes', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('12345'))
    expect(await storage.size(id, 'input')).toBe(5)
  })

  it('measures age from a clock the caller supplies', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    // Offset past the clamp at zero: mtime carries sub-millisecond
    // precision that Date.now() truncates away, so a file written moments
    // ago can read a fraction in the future and clamp to 0. Measuring the
    // delta from a base already past that reads the arithmetic itself.
    const base = Date.now() + 60_000
    const young = await storage.age(id, base)
    const older = await storage.age(id, base + 5_000)
    expect(young).toBeGreaterThan(59_000)
    expect((older ?? 0) - (young ?? 0)).toBe(5_000)
  })

  /**
   * Age is measured from ARRIVAL, and nothing that happens afterwards may
   * move it.
   *
   * The previous version of this test compared two `age` calls a
   * microsecond apart against a 50ms tolerance, so it passed whether or
   * not the clock reset -- it could not have failed. It was hiding a real
   * bug: `age` used the job directory's mtime, and creating a file inside
   * a directory updates that directory's mtime, so writing the result
   * restarted the hour.
   *
   * Driving an injected clock across half an hour is what makes the
   * difference observable: a reset would report 30 minutes here instead of
   * 60.
   */
  it('measures age from arrival, not from the last write', async () => {
    const HALF_HOUR = 30 * 60_000
    let now = 1_000_000
    const clocked = new LocalStorage(root, { clock: () => now })

    const id = newJobId()
    await clocked.put(id, 'input', bytes('x'))

    now += HALF_HOUR
    await clocked.put(id, 'result', bytes('y'))
    expect(await clocked.age(id, now)).toBe(HALF_HOUR)

    // And deleting the input -- which also touches the directory -- must
    // not buy the result another hour.
    await clocked.delete(id, 'input')
    now += HALF_HOUR
    expect(await clocked.age(id, now)).toBe(2 * HALF_HOUR)
  })

  /**
   * A job written before the timestamp file existed still has to expire.
   * Falling back to mtime is a worse clock; a job with no age at all would
   * be one the sweeper skips forever.
   */
  it('falls back to the directory when there is no timestamp to read', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    await rm(join(root, id, 'created'))
    const age = await storage.age(id, Date.now() + 10_000)
    expect(age).toBeGreaterThan(9_000)
  })

  it('ignores a garbled timestamp rather than making the job immortal', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    await writeFile(join(root, id, 'created'), 'not-a-number')
    const age = await storage.age(id, Date.now() + 10_000)
    expect(age).not.toBeNull()
    expect(age).toBeGreaterThan(9_000)
  })

  it('refuses an id that is not a job id, before it becomes a path', async () => {
    const escape = '../../etc/passwd' as JobId
    await expect(storage.put(escape, 'input', bytes('x'))).rejects.toThrow()
    await expect(storage.get(escape, 'input')).rejects.toThrow()
    await expect(storage.delete(escape)).rejects.toThrow()
  })

  it('lists the jobs it holds', async () => {
    const a = newJobId()
    const b = newJobId()
    await storage.put(a, 'input', bytes('a'))
    await storage.put(b, 'input', bytes('b'))
    expect((await storage.list()).sort()).toEqual([a, b].sort())
  })

  it('lists nothing for a root that does not exist yet', async () => {
    expect(await new LocalStorage(join(root, 'not-created')).list()).toEqual([])
  })

  /**
   * A misconfigured root pointed at a real directory should lose nothing.
   * The sweeper deletes whatever list() returns, so list() is the guard.
   */
  it('ignores entries that are not shaped like a job', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    await mkdir(join(root, 'Documents'))
    await writeFile(join(root, 'notes.txt'), 'x')
    expect(await storage.list()).toEqual([id])
  })
})

describe('Sweeper', () => {
  const at = (t: number) => () => t

  it('removes a job past the TTL', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    const sweeper = new Sweeper(storage, { clock: at(Date.now() + JOB_TTL_MS + 1) })
    expect(await sweeper.sweep()).toBe(1)
    expect(await storage.get(id, 'input')).toBeNull()
  })

  it('keeps a job inside the TTL', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    const sweeper = new Sweeper(storage, { clock: at(Date.now() + 1_000) })
    expect(await sweeper.sweep()).toBe(0)
    expect(await storage.get(id, 'input')).toEqual(bytes('x'))
  })

  /** Deletion is unconditional: a job that failed still had a file uploaded. */
  it('removes an expired job whether or not it produced a result', async () => {
    const failed = newJobId()
    const done = newJobId()
    await storage.put(failed, 'input', bytes('x'))
    await storage.put(done, 'input', bytes('x'))
    await storage.put(done, 'result', bytes('y'))
    const sweeper = new Sweeper(storage, { clock: at(Date.now() + JOB_TTL_MS + 1) })
    expect(await sweeper.sweep()).toBe(2)
    expect(await storage.list()).toEqual([])
  })

  it('sweeping an empty root is a no-op', async () => {
    const sweeper = new Sweeper(storage, { clock: at(Date.now()) })
    expect(await sweeper.sweep()).toBe(0)
  })

  /**
   * A download or a purge can remove a job between list() and age(). The
   * sweeper must carry on -- otherwise one race stops every later job in
   * the pass from being swept.
   */
  it('does not throw when a job vanishes mid-sweep', async () => {
    const gone = newJobId()
    const expired = newJobId()
    await storage.put(gone, 'input', bytes('x'))
    await storage.put(expired, 'input', bytes('x'))

    const racing = {
      ...storage,
      list: () => storage.list(),
      age: async (id: JobId, now: number) => {
        if (id === gone) await storage.delete(gone)
        return storage.age(id, now)
      },
      delete: (id: JobId) => storage.delete(id),
    }
    const sweeper = new Sweeper(racing as unknown as LocalStorage, {
      clock: at(Date.now() + JOB_TTL_MS + 1),
    })
    expect(await sweeper.sweep()).toBe(1)
    expect(await storage.list()).toEqual([])
  })

  it('reports a count and nothing identifying', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    let reported: number | null = null
    const sweeper = new Sweeper(storage, {
      clock: at(Date.now() + JOB_TTL_MS + 1),
      onSwept: (n) => (reported = n),
    })
    await sweeper.sweep()
    expect(reported).toBe(1)
  })

  it('stops cleanly when it was never started', () => {
    expect(() => new Sweeper(storage).stop()).not.toThrow()
  })
})

describe('per-slot deletion', () => {
  /**
   * The moment a conversion succeeds, the uploaded file has no further
   * use. It goes then -- not at the TTL, not when someone downloads the
   * result. The result has to survive that deletion, which is the whole
   * point of the slot argument.
   */
  it('removes the input and leaves the result', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('the upload'))
    await storage.put(id, 'result', bytes('the conversion'))

    await storage.delete(id, 'input')

    expect(await storage.get(id, 'input')).toBeNull()
    expect(await storage.get(id, 'result')).not.toBeNull()
  })

  it('is idempotent, like every other deletion path', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    await storage.delete(id, 'input')
    await expect(storage.delete(id, 'input')).resolves.toBeUndefined()
    await expect(storage.delete(newJobId(), 'result')).resolves.toBeUndefined()
  })

  it('still removes everything when no slot is named', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('a'))
    await storage.put(id, 'result', bytes('b'))
    await storage.delete(id)
    expect(await readdir(root)).toEqual([])
  })
})

describe('Sweeper onExpire', () => {
  /**
   * The bytes going is only half of it. Whoever holds the job's in-memory
   * record has to be told, or a record naming a job we promised to forget
   * outlives the file for the life of the process.
   */
  it('names each job it removed', async () => {
    const a = newJobId()
    const b = newJobId()
    await storage.put(a, 'input', bytes('x'))
    await storage.put(b, 'input', bytes('y'))

    const expired: string[] = []
    const sweeper = new Sweeper(storage, {
      clock: () => Date.now() + JOB_TTL_MS + 1,
      onExpire: (id) => void expired.push(id),
    })
    await sweeper.sweep()

    expect(expired.sort()).toEqual([a, b].sort())
  })

  /** A job that was kept must not be reported as forgotten. */
  it('says nothing about a job still inside its TTL', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    const expired: string[] = []
    const sweeper = new Sweeper(storage, {
      clock: () => Date.now() + 1_000,
      onExpire: (jobId) => void expired.push(jobId),
    })
    expect(await sweeper.sweep()).toBe(0)
    expect(expired).toEqual([])
  })

  it('is optional -- a sweep with no hook still deletes', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    const sweeper = new Sweeper(storage, { clock: () => Date.now() + JOB_TTL_MS + 1 })
    expect(await sweeper.sweep()).toBe(1)
    expect(await storage.get(id, 'input')).toBeNull()
  })
})
