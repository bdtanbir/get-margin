import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import {
  protectedSave, removeProtection, unlock, permissionMask, grantedPermissions,
  ProtectionFailed, PERMISSION_BITS, type PermissionName,
} from '../../src/write/protect.js'
import { replay } from '../../src/write/index.js'
import { emptyEditDocument } from '../../src/write/types.js'
import { generateFixtures, fixturePath } from '../fixtures/index.js'

beforeAll(async () => { await generateFixtures() }, 60_000)

const src = () => new Uint8Array(readFileSync(fixturePath('simple-text')))
const open = (b: Uint8Array) =>
  mupdf.PDFDocument.openDocument(b, 'application/pdf') as mupdf.PDFDocument

function save(over: Partial<Parameters<typeof protectedSave>[1]> = {}): Uint8Array {
  const doc = open(src())
  try {
    return protectedSave(doc, {
      userPassword: 'hunter2', ownerPassword: '', permissions: ['print'], ...over,
    }, 'compress')
  } finally { doc.destroy() }
}

const needsPassword = (bytes: Uint8Array): boolean => {
  const d = open(bytes)
  try { return d.needsPassword() } finally { d.destroy() }
}

describe('protectedSave', () => {
  it('produces a document that demands its password', () => {
    expect(needsPassword(save())).toBe(true)
  })

  it('opens with the right password and refuses the wrong one', () => {
    const bytes = save()
    const good = unlock(bytes, 'hunter2')
    expect(good).not.toBeNull()
    good?.destroy()
    expect(unlock(bytes, 'wrong')).toBeNull()
  })

  it('refuses to protect with no password at all', () => {
    expect(() => save({ userPassword: '', ownerPassword: '' })).toThrow(ProtectionFailed)
  })

  /**
   * A permissions-only document is deliberately openable without a
   * password -- an owner password restricts what can be done, it does not
   * gate opening. Demanding needsPassword() here would reject a legitimate
   * result.
   */
  it('allows an owner password with no open password', () => {
    const bytes = save({ userPassword: '', ownerPassword: 'owner', permissions: ['print'] })
    expect(needsPassword(bytes)).toBe(false)
  })
})

/**
 * THE TWO SILENT FAILURES, asserted against directly.
 *
 * Both save cleanly and throw nothing, and one of them writes a real
 * /Encrypt dictionary and grows the file exactly as a protected one does.
 * These tests build each broken call BY HAND and confirm it produces an
 * unprotected file -- so the guard in protectedSave is measured against the
 * thing it guards, not against an assumption about it.
 */
describe('the two ways to produce a file that looks protected and is not', () => {
  it('passwords with no encrypt= are silently ignored', () => {
    const doc = open(src())
    const bytes = doc.saveToBuffer(
      'compress,user-password=hunter2,owner-password=hunter2',
    ).asUint8Array()
    doc.destroy()
    // No throw, a plausible file -- and completely open.
    expect(needsPassword(bytes)).toBe(false)
  })

  it('encrypt= with no password produces an encrypted file that opens freely', () => {
    const doc = open(src())
    const bytes = doc.saveToBuffer('compress,encrypt=aes-256').asUint8Array()
    doc.destroy()
    expect(needsPassword(bytes)).toBe(false)
    // It even LOOKS protected: the encryption machinery is really there.
    expect(Buffer.from(bytes).includes('Encrypt')).toBe(true)
  })

  // The guard: protectedSave never returns either of the above.
  it('protectedSave produces neither', () => {
    expect(needsPassword(save())).toBe(true)
  })
})

describe('permissions', () => {
  const granted = (permissions: PermissionName[]): PermissionName[] => {
    const bytes = save({ userPassword: 'u', ownerPassword: 'o', permissions })
    const doc = open(bytes)
    doc.authenticatePassword('u')
    try { return grantedPermissions(doc) } finally { doc.destroy() }
  }

  it('builds the mask from named permissions', () => {
    expect(permissionMask([])).toBe(0)
    expect(permissionMask(['print'])).toBe(4)
    expect(permissionMask(['print', 'copy'])).toBe(20)
  })

  it('grants exactly what was asked for', () => {
    expect(granted(['print'])).toEqual(['print'])
    expect(granted(['copy'])).toEqual(['copy'])
    expect(granted(['print', 'copy']).sort()).toEqual(['copy', 'print'])
  })

  it('denies everything when nothing is granted', () => {
    expect(granted([])).toEqual([])
  })

  it('grants everything when everything is asked for', () => {
    const all = Object.keys(PERMISSION_BITS) as PermissionName[]
    expect(granted(all).sort()).toEqual([...all].sort())
  })

  // Each bit individually, so a transcription error in one cannot hide
  // behind another being right.
  it.each(Object.keys(PERMISSION_BITS) as PermissionName[])(
    'grants %s on its own', (name) => {
      expect(granted([name])).toEqual([name])
    },
  )
})

describe('removing protection', () => {
  it('needs the user password, and produces an open document', () => {
    const bytes = save()
    const plain = removeProtection(bytes, 'hunter2', 'compress')
    expect(needsPassword(plain)).toBe(false)
  })

  /**
   * This is not encryption-breaking and must never become it. Removing
   * protection from a document you can already open is legitimate; getting
   * in without the password is not something this project does.
   */
  it('refuses a wrong password rather than trying anything else', () => {
    expect(() => removeProtection(save(), 'wrong', 'compress')).toThrow(/does not open/)
  })

  /**
   * The third silent trap. MuPDF's default is `encrypt=keep`, so
   * authenticating and saving normally leaves the file encrypted -- and its
   * text extracts as EMPTY, so it reads as a corrupted document rather than
   * a locked one. Someone told "password removed" would get a file that
   * still demands the password they asked to be rid of.
   */
  it('a naive authenticate-and-save leaves the file encrypted', () => {
    const bytes = save()
    const doc = open(bytes)
    doc.authenticatePassword('hunter2')
    const naive = doc.saveToBuffer('compress').asUint8Array()
    doc.destroy()
    expect(needsPassword(naive)).toBe(true)
  })

  it('keeps the document’s content', () => {
    const plain = removeProtection(save(), 'hunter2', 'compress')
    const d = open(plain)
    const p = d.loadPage(0)
    try {
      expect(p.toStructuredText().asText()).toContain('Hello')
    } finally { p.destroy(); d.destroy() }
  })
})

/**
 * The other half of "password protect/remove".
 *
 * MuPDF's save default is `encrypt=keep`, so an edited export of a
 * protected document comes back STILL protected. That is a defensible
 * default and it leaves no way to say otherwise -- which is what
 * removeProtection through replay is for.
 */
describe('exporting a protected document', () => {
  const editDoc = (rotation = 0) => ({
    ...emptyEditDocument(),
    sources: { 'src-0': { hash: '', name: 'a.pdf' } },
    pageOrder: ['p0'],
    pages: { p0: { sourceIndex: 0, sourceId: 'src-0', rotation, cropBox: null } },
  })

  const passwords = new Map([['src-0', 'hunter2']])

  it('hands an untouched protected file back unchanged', () => {
    const locked = save()
    const out = replay(new Map([['src-0', locked]]), editDoc(), { passwords })
    expect(Buffer.from(out).equals(Buffer.from(locked))).toBe(true)
    expect(needsPassword(out)).toBe(true)
  })

  // The default that made the remove option necessary.
  it('keeps the protection through an ordinary edit', () => {
    const out = replay(new Map([['src-0', save()]]), editDoc(90), { passwords })
    expect(needsPassword(out)).toBe(true)
  })

  /**
   * THE BUG THIS FOUND, and the reason `passwords` exists at all.
   *
   * An encrypted document OPENS without a password -- its structure is
   * readable -- while every content stream stays undecryptable. Editing
   * one therefore produced a file with pages and no content: no error, no
   * warning, a silently empty document that opens fine and says nothing.
   * It affected every edit to a protected file.
   */
  it('keeps the CONTENT through an ordinary edit', () => {
    const out = replay(new Map([['src-0', save()]]), editDoc(90), { passwords })
    const d = open(out)
    d.authenticatePassword('hunter2')
    const p = d.loadPage(0)
    try {
      expect(p.toStructuredText().asText()).toContain('Hello')
    } finally { p.destroy(); d.destroy() }
  })

  /**
   * And the guard, which is the other half. Failing loudly with something
   * the user can act on beats producing a blank document that looks fine.
   */
  it('refuses rather than exporting a blank document when the password is missing', () => {
    expect(() => replay(new Map([['src-0', save()]]), editDoc(90)))
      .toThrow(/password-protected and the password was not available/)
  })

  it('refuses a wrong password rather than exporting a blank document', () => {
    expect(() => replay(new Map([['src-0', save()]]), editDoc(90), {
      passwords: new Map([['src-0', 'wrong']]),
    })).toThrow(/password was not available/)
  })

  it('drops the protection when asked', () => {
    const out = replay(new Map([['src-0', save()]]), editDoc(), {
      removeProtection: true, passwords,
    })
    expect(needsPassword(out)).toBe(false)
  })

  /**
   * Removing a password changes the file even when nothing else did, so
   * the byte-identical pass-through must not hand back the encrypted
   * original -- which is exactly what it would otherwise do.
   */
  it('defeats the pass-through, which would otherwise return the locked file', () => {
    const locked = save()
    const out = replay(new Map([['src-0', locked]]), editDoc(), {
      removeProtection: true, passwords,
    })
    expect(Buffer.from(out).equals(Buffer.from(locked))).toBe(false)
    expect(needsPassword(out)).toBe(false)
  })

  it('keeps the content readable after removal', () => {
    const out = replay(new Map([['src-0', save()]]), editDoc(), {
      removeProtection: true, passwords,
    })
    const d = open(out)
    const p = d.loadPage(0)
    try {
      expect(p.toStructuredText().asText()).toContain('Hello')
    } finally { p.destroy(); d.destroy() }
  })

  // Setting a new password supersedes; asking for both is contradictory
  // and protection wins, since it is the more specific request.
  it('prefers a new password over removal when given both', () => {
    const out = replay(new Map([['src-0', save()]]), editDoc(), {
      removeProtection: true, passwords,
      protection: { userPassword: 'new', ownerPassword: '', permissions: ['print'] },
    })
    expect(needsPassword(out)).toBe(true)
    expect(unlock(out, 'new')).not.toBeNull()
  })
})
