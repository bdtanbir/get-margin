import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ProtectDialog from '@/features/protect/ProtectDialog.vue'
import { useEditsStore } from '@/stores/edits'
import * as exportFile from '@/lib/exportFile'
import type { Protection } from '@margin/pdf-core'

const save = vi.fn()
vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ save, listFields: vi.fn(async () => []) }),
  closeSharedDocument: vi.fn(),
}))
vi.mock('@/lib/fonts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fonts')>()
  return { ...actual, fontsForExport: vi.fn(async () => new Map()) }
})

/** The protection argument the dialog handed to the worker. */
const sentProtection = (): Protection => save.mock.calls[0]![4] as Protection

function seed() {
  const edits = useEditsStore()
  edits.reset({ 'src-0': { hash: 'h', name: 'a.pdf' } }, ['p1'],
    { p1: { sourceId: 'src-0', sourceIndex: 0, rotation: 0, cropBox: null } })
  return edits
}

async function fill(w: ReturnType<typeof mount>, password: string, confirm = password) {
  await w.get('[data-protect-password]').setValue(password)
  await w.get('[data-protect-confirm]').setValue(confirm)
}

describe('ProtectDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    save.mockResolvedValue(new Uint8Array([1, 2, 3]))
    vi.spyOn(exportFile, 'downloadBytes').mockImplementation(() => {})
    seed()
  })

  it('cannot be applied without a password', () => {
    expect(mount(ProtectDialog).get('[data-protect-apply]').attributes('disabled')).toBeDefined()
  })

  it('refuses a mismatched confirmation, and says so', async () => {
    const w = mount(ProtectDialog)
    await fill(w, 'hunter2', 'hunter3')
    expect(w.find('[data-protect-mismatch]').exists()).toBe(true)
    expect(w.get('[data-protect-apply]').attributes('disabled')).toBeDefined()
  })

  it('applies once the two match', async () => {
    const w = mount(ProtectDialog)
    await fill(w, 'hunter2')
    expect(w.get('[data-protect-apply]').attributes('disabled')).toBeUndefined()
    await w.get('[data-protect-apply]').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledTimes(1)
    expect(sentProtection().userPassword).toBe('hunter2')
  })

  /**
   * A protect dialog whose defaults quietly forbid printing and screen
   * readers would produce documents people cannot use, from an action they
   * read as "add a password".
   */
  it('grants everything by default', async () => {
    const w = mount(ProtectDialog)
    await fill(w, 'p')
    await w.get('[data-protect-apply]').trigger('click')
    await flushPromises()
    expect(sentProtection().permissions).toEqual(
      expect.arrayContaining(['print', 'copy', 'edit', 'annotate', 'accessibility']),
    )
  })

  it('sends only what is still ticked', async () => {
    const w = mount(ProtectDialog)
    await fill(w, 'p')
    await w.get('[data-permission="copy"]').trigger('change')
    await w.get('[data-permission="edit"]').trigger('change')
    await w.get('[data-protect-apply]').trigger('click')
    await flushPromises()
    const sent = sentProtection().permissions
    expect(sent).not.toContain('copy')
    expect(sent).not.toContain('edit')
    expect(sent).toContain('print')
  })

  it('can deny everything', async () => {
    const w = mount(ProtectDialog)
    await fill(w, 'p')
    for (const box of w.findAll('[data-permission]')) await box.trigger('change')
    await w.get('[data-protect-apply]').trigger('click')
    await flushPromises()
    expect(sentProtection().permissions).toEqual([])
  })

  /**
   * PDF permissions are a REQUEST to the viewer, not a property of the
   * file, and several readers ignore them. Someone who believes "no copy"
   * is a technical guarantee is being misled by omission.
   */
  it('says which half is enforced and which half is only asked for', () => {
    const text = mount(ProtectDialog).get('[data-protect-caveat]').text()
    expect(text).toMatch(/real encryption/i)
    expect(text).toMatch(/request to the PDF reader/i)
    expect(text).toMatch(/ignores them can do any of it/i)
  })

  // Real encryption has no back door, which is worth saying before someone
  // relies on there being one.
  it('warns that a lost password cannot be recovered', () => {
    expect(mount(ProtectDialog).text()).toMatch(/cannot be recovered/i)
  })

  it('downloads the protected bytes', async () => {
    const w = mount(ProtectDialog)
    await fill(w, 'p')
    await w.get('[data-protect-apply]').trigger('click')
    await flushPromises()
    expect(exportFile.downloadBytes).toHaveBeenCalledTimes(1)
    expect(w.emitted('close')).toBeTruthy()
  })

  /**
   * protectedSave throws rather than returning an unprotected file, so a
   * failure means NO file was downloaded. Surfacing it -- and never falling
   * back to a plain save -- is the whole point of that design.
   */
  it('reports a failed protection instead of downloading anything', async () => {
    save.mockRejectedValue(new Error('It was NOT saved with a password'))
    const w = mount(ProtectDialog)
    await fill(w, 'p')
    await w.get('[data-protect-apply]').trigger('click')
    await flushPromises()
    expect(w.get('[data-protect-error]').text()).toMatch(/NOT saved with a password/)
    expect(exportFile.downloadBytes).not.toHaveBeenCalled()
    expect(w.emitted('close')).toBeFalsy()
  })

  /**
   * One password field, not two. protectedSave falls back to the user
   * password for the owner password, which is what a document with one
   * password should mean: whoever can open it can change its permissions.
   * Two fields would ask consumer users to understand a distinction that
   * mostly exists for publishers.
   */
  it('asks for one password, not an owner password as well', async () => {
    const w = mount(ProtectDialog)
    expect(w.findAll('input[type="password"]')).toHaveLength(2) // password + confirm
    await fill(w, 'open')
    await w.get('[data-protect-apply]').trigger('click')
    await flushPromises()
    expect(sentProtection().ownerPassword).toBe('')
    expect(sentProtection().userPassword).toBe('open')
  })
})
