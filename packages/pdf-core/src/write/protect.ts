import * as mupdf from 'mupdf'

/**
 * Which operations a viewer is asked to allow.
 *
 * Bit values measured individually against `hasPermission` in
 * docs/findings/14-phase-6-preflight.md 3, not copied from a table --
 * `permissions=` is not a literal key in the wasm string table, so the spec
 * flags it as empirically derived. Every bit landed exactly where the PDF
 * specification says it should.
 */
export const PERMISSION_BITS = {
  print: 4,
  edit: 8,
  copy: 16,
  annotate: 32,
  form: 256,
  accessibility: 512,
  assemble: 1024,
  printHighQuality: 2048,
} as const

export type PermissionName = keyof typeof PERMISSION_BITS

export type Protection = {
  /** Required to OPEN the document. Empty means no open password. */
  userPassword: string
  /** Required to change permissions. Empty means the user password is used. */
  ownerPassword: string
  /** Permissions to grant. Anything absent is denied. */
  permissions: PermissionName[]
}

export function permissionMask(names: PermissionName[]): number {
  return names.reduce((mask, name) => mask | PERMISSION_BITS[name], 0)
}

/** The permissions an already-open document grants. */
export function grantedPermissions(doc: mupdf.PDFDocument): PermissionName[] {
  const map: Array<[PermissionName, string]> = [
    ['print', 'print'], ['edit', 'edit'], ['copy', 'copy'], ['annotate', 'annotate'],
    ['form', 'form'], ['accessibility', 'accessibility'], ['assemble', 'assemble'],
    ['printHighQuality', 'print-hq'],
  ]
  return map
    .filter(([, name]) => {
      try { return doc.hasPermission(name as Parameters<typeof doc.hasPermission>[0]) } catch { return false }
    })
    .map(([key]) => key)
}

export class ProtectionFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtectionFailed'
  }
}

/**
 * Save with encryption, then PROVE it took.
 *
 * THE WHOLE REASON THIS FUNCTION EXISTS. There are two ways to produce a
 * file that looks protected and is not, and both save cleanly and throw
 * nothing (docs/findings/14-phase-6-preflight.md 2):
 *
 *   1. `user-password=` with no `encrypt=` -- documented in PLAN.md 2.3.
 *      The passwords are silently ignored and the file is plain.
 *   2. `encrypt=` with no password -- NOT previously documented, and worse.
 *      A real /Encrypt dictionary is written, the file size jumps exactly
 *      as a protected one does, and it opens with no prompt at all. It
 *      looks protected by every cheap measure and protects nothing.
 *
 * So a non-throwing `saveToBuffer` is not evidence, and neither is the
 * presence of an /Encrypt dictionary. The only honest check is to reopen
 * the output and ask whether it demands a password. That check runs here,
 * on every protected save, rather than in a test -- a user must never be
 * told their document is protected on the strength of a call that did not
 * throw.
 */
export function protectedSave(
  raw: mupdf.PDFDocument,
  protection: Protection,
  baseOptions: string,
): Uint8Array {
  const { userPassword, ownerPassword, permissions } = protection

  if (userPassword === '' && ownerPassword === '') {
    throw new ProtectionFailed('A protected document needs at least one password.')
  }

  const parts = [baseOptions, 'encrypt=aes-256']
  if (userPassword) parts.push(`user-password=${userPassword}`)
  // Without an explicit owner password the user password serves as both,
  // which is what every consumer tool does: a document with an open
  // password and no separate owner password is not a document whose
  // permissions anyone can change.
  parts.push(`owner-password=${ownerPassword || userPassword}`)
  parts.push(`permissions=${permissionMask(permissions)}`)

  const bytes = raw.saveToBuffer(parts.filter(Boolean).join(',')).asUint8Array()

  // The proof. Only meaningful when there IS an open password: a
  // permissions-only document is deliberately openable without one, and
  // demanding needsPassword() there would reject a legitimate result.
  if (userPassword) {
    let opened: mupdf.PDFDocument | undefined
    let demanded = false
    try {
      opened = mupdf.PDFDocument.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument
      demanded = opened.needsPassword()
    } catch {
      // A document that cannot be opened at all without a password is
      // protected, which is the outcome asked for.
      demanded = true
    } finally {
      opened?.destroy()
    }

    if (!demanded) {
      throw new ProtectionFailed(
        'The document could not be password-protected. It was NOT saved with a password — ' +
        'do not treat this file as protected.',
      )
    }
  }

  return bytes
}

/**
 * Open a protected document with its user password.
 *
 * Returns null when the password is wrong, rather than throwing: a typed
 * password being wrong is an ordinary event, not an exceptional one.
 */
export function unlock(bytes: Uint8Array, password: string): mupdf.PDFDocument | null {
  const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument
  if (!doc.needsPassword()) return doc
  if (doc.authenticatePassword(password)) return doc
  doc.destroy()
  return null
}

/**
 * Save an unlocked document with no encryption.
 *
 * This requires the USER password and cannot do anything else. Removing
 * protection from a document you can already open is a legitimate
 * operation; breaking encryption is not one this project performs, and the
 * distinction is worth keeping in the code rather than only in the UI.
 *
 * `encrypt=none` is NOT optional, and this is a third silent trap on top of
 * the two above. MuPDF's default is `encrypt=keep`, so authenticating and
 * saving normally produces a file that is STILL encrypted -- and whose text
 * extracts as empty, so it reads as a corrupted document rather than a
 * locked one. A user told "password removed" would get a file that still
 * demands the password they asked to be rid of. Measured, and pinned by a
 * test that performs the naive save and asserts it fails.
 */
export function removeProtection(
  bytes: Uint8Array,
  userPassword: string,
  baseOptions: string,
): Uint8Array {
  const doc = unlock(bytes, userPassword)
  if (!doc) throw new ProtectionFailed('That password does not open this document.')
  try {
    const plain = doc.saveToBuffer(`${baseOptions},encrypt=none`).asUint8Array()

    // Symmetrical with protectedSave's check, and for the same reason: the
    // user is being told their document is no longer protected, so verify
    // it rather than trusting a call that did not throw.
    const check = mupdf.PDFDocument.openDocument(plain, 'application/pdf') as mupdf.PDFDocument
    const stillLocked = check.needsPassword()
    check.destroy()
    if (stillLocked) {
      throw new ProtectionFailed('The password could not be removed from this document.')
    }
    return plain
  } finally {
    doc.destroy()
  }
}
