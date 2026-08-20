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
 * Job files on local disk, one directory per job.
 *
 * ```
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
  constructor(private readonly root: string) {}

  private dir(id: JobId): string {
    // Throws on anything that is not 43 base64url characters, which
    // excludes every separator and every dot -- so the join below cannot
    // leave the root.
    return join(this.root, jobId.parse(id))
  }

  async put(id: JobId, slot: Slot, bytes: Uint8Array): Promise<void> {
    const dir = this.dir(id)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // 0o600: the job id is the credential, but defence in depth costs
    // nothing here -- another user on the host is not an owner.
    await writeFile(join(dir, slot), bytes, { mode: 0o600 })
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

  async delete(id: JobId): Promise<void> {
    // `force` makes this idempotent, `recursive` takes both slots and the
    // directory. Deletion runs on four independent paths that race each
    // other; a second deletion must be a no-op, not an error.
    await rm(this.dir(id), { recursive: true, force: true })
  }

  async size(id: JobId, slot: Slot): Promise<number | null> {
    try {
      return (await stat(join(this.dir(id), slot))).size
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  async age(id: JobId, now: number): Promise<number | null> {
    try {
      // The directory's mtime, not a slot's: the TTL is measured from when
      // the job arrived, so writing a result must not extend the life of
      // the input. mkdir sets it once and neither writeFile touches it.
      const created = (await stat(this.dir(id))).mtimeMs
      return Math.max(0, now - created)
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
