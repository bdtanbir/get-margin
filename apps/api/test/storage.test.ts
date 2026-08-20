import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
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

  it('uses the job id as the directory name and writes nothing else', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    expect(await readdir(root)).toEqual([id])
    expect(await readdir(join(root, id))).toEqual(['input'])
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
   * Writing the result must not extend the input's life, or a job that
   * produces output whenever it is polled would never expire.
   */
  it('does not reset age when a second slot is written', async () => {
    const id = newJobId()
    await storage.put(id, 'input', bytes('x'))
    const before = await storage.age(id, Date.now() + 10_000)
    await storage.put(id, 'result', bytes('y'))
    const after = await storage.age(id, Date.now() + 10_000)
    expect(after).toBeGreaterThanOrEqual((before ?? 0) - 50)
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
