import { zip } from 'fflate'

export type ZipEntry = { name: string; data: Uint8Array }

/**
 * Bundle several PDFs into one download.
 *
 * ONE download, not several: Chrome and Safari throttle or block successive
 * programmatic downloads, so a ten-way split silently delivers two files
 * and the user does not find out until they go looking for the rest.
 *
 * Stored, not deflated (`level: 0`). A PDF's streams are already
 * compressed, so deflating them again costs CPU and a stall on the main
 * thread for a percent or two of size.
 */
export function zipFiles(entries: ZipEntry[]): Promise<Uint8Array> {
  const input: Record<string, [Uint8Array, { level: 0 }]> = {}
  for (const entry of entries) input[entry.name] = [entry.data, { level: 0 }]
  return new Promise((resolve, reject) => {
    zip(input, (err, out) => (err ? reject(err) : resolve(out)))
  })
}
