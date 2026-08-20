import { mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { jobId, type JobId } from '@margin/shared'
import type { Slot, StorageAdapter } from './types.js'

/** Absent-file errors. Every method treats these as "not there", never as a fault. */
function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * The file that records when a job arrived.
 *
 * Its CONTENT is the timestamp, not its metadata. See `age` for why that
 * distinction is the whole point of this file existing.
 */
const CREATED = 'created'

/**
 * Job files on local disk, one directory per job.
 *
 * ```
 * <root>/<jobId>/created   epoch ms, written once, never rewritten
 * <root>/<jobId>/input
 * <root>/<jobId>/result
 * ```
 *
 * The uploaded filename is never part of a path. It is user data (§4), and
 * a name like `2024-tax-return-jane-doe.pdf` is frequently the sensitive
 * thing on its own -- so it is not written to disk, not logged, and not
 * reflected back. The slot names are fixed strings.
 *
 * Every id is re-validated against the shared schema before it touches a
 * path. The router already validates, but this is the layer that turns a
 * string into a filesystem location, so it is the layer that must refuse
 * `../..`.
 */
export class LocalStorage implements StorageAdapter {
  /** Injected so a test can place a job's arrival at an arbitrary moment. */
  private readonly clock: () => number

  constructor(
    private readonly root: string,
    options: { clock?: () => number } = {},
  ) {
    this.clock = options.clock ?? Date.now
  }

  private dir(id: JobId): string {
    // Throws on anything that is not 43 base64url characters, which
    // excludes every separator and every dot -- so the join below cannot
    // leave the root.
    return join(this.root, jobId.parse(id))
  }

  async put(id: JobId, slot: Slot, bytes: Uint8Array): Promise<void> {
    const dir = this.dir(id)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await this.stamp(dir)
    // 0o600: the job id is the credential, but defence in depth costs
    // nothing here -- another user on the host is not an owner.
    await writeFile(join(dir, slot), bytes, { mode: 0o600 })
  }

  /**
   * Records the arrival time, once.
   *
   * `wx` fails if the file already exists, which makes "write it only the
   * first time" a single atomic call rather than a read-then-write with a
   * race in the middle. Every later `put` on the same job hits EEXIST and
   * leaves the original timestamp alone -- which is the entire point.
   */
  private async stamp(dir: string): Promise<void> {
    try {
      await writeFile(join(dir, CREATED), String(this.clock()), { mode: 0o600, flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }

  async get(id: JobId, slot: Slot): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(join(this.dir(id), slot))
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  async delete(id: JobId, slot?: Slot): Promise<void> {
    // `force` makes this idempotent, `recursive` takes both slots and the
    // directory. Deletion runs on four independent paths that race each
    // other; a second deletion must be a no-op, not an error.
    const target = slot ? join(this.dir(id), slot) : this.dir(id)
    await rm(target, { recursive: true, force: true })
  }

  async size(id: JobId, slot: Slot): Promise<number | null> {
    try {
      return (await stat(join(this.dir(id), slot))).size
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  /**
   * How long ago the job ARRIVED -- not how long ago it was last touched.
   *
   * Read from the `created` file's contents. The obvious implementation is
   * the job directory's mtime, and it is wrong: creating a file inside a
   * directory updates that directory's mtime, so writing the result and
   * then deleting the input each restart the clock. Measured on this
   * machine, a job took 190ms of drift from three ordinary writes, and an
   * OCR pass taking four minutes would have had its hour begin four
   * minutes late.
   *
   * That is not a rounding error in the privacy claim -- the consent
   * dialog promises deletion "within an hour", and a user reads that as an
   * hour from when they pressed upload.
   *
   * A file's CONTENTS are the one thing the filesystem will not update
   * behind us, which is why the timestamp lives there rather than in a
   * stat field.
   */
  async age(id: JobId, now: number): Promise<number | null> {
    const dir = this.dir(id)
    try {
      const raw = await readFile(join(dir, CREATED), 'utf8')
      const created = Number(raw)
      // A truncated or garbled stamp must not make a job immortal. Falling
      // through to the directory's mtime is a worse clock, but a job whose
      // age cannot be determined is a job the sweeper would skip forever.
      if (Number.isFinite(created)) return Math.max(0, now - created)
    } catch (err) {
      if (!isMissing(err)) throw err
      // No stamp: a job directory written before this file existed, or one
      // caught mid-creation. mtime is the fallback, not the contract.
    }
    try {
      return Math.max(0, now - (await stat(dir)).mtimeMs)
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  async list(): Promise<JobId[]> {
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch (err) {
      // A root that does not exist yet holds no jobs. Nothing to sweep.
      if (isMissing(err)) return []
      throw err
    }
    // Anything that is not shaped like a job id was not written by us.
    // Skipping it rather than deleting it means a misconfigured root
    // pointed at someone's home directory loses nothing.
    return entries
      .filter((e) => e.isDirectory() && jobId.safeParse(e.name).success)
      .map((e) => e.name as JobId)
  }
}
