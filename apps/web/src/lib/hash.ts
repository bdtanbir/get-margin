/**
 * SHA-256 of the source file, used to key crash-recovery data (spec §1.2).
 *
 * Must be computed BEFORE the buffer is transferred to the worker — transfer
 * neuters the ArrayBuffer on this side.
 */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
