import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDocumentStore } from '@/stores/document'
import * as exportFile from '@/lib/exportFile'

const authenticate = vi.fn()
const save = vi.fn()
vi.mock('@/workers/pdfClient', () => ({
  getPdfClient: () => ({ authenticate, save }),
  closeSharedDocument: vi.fn(),
}))

const info = {
  sourceId: 'src-0', pageCount: 1, needsPassword: false,
  geometries: [{ width: 100, height: 100, rotation: 0, cropBox: null }],
}

describe('document.unlockAndDownload', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.spyOn(exportFile, 'downloadBytes').mockImplementation(() => {})
    useDocumentStore().$patch({ status: 'needs-password', fileName: 'secret.pdf' })
  })

  it('downloads nothing when the password is wrong', async () => {
    authenticate.mockRejectedValue(new Error('Incorrect password'))
    const doc = useDocumentStore()
    await doc.unlockAndDownload('nope')
    expect(save).not.toHaveBeenCalled()
    expect(exportFile.downloadBytes).not.toHaveBeenCalled()
    expect(doc.status).toBe('needs-password')
    expect(doc.error).toMatch(/incorrect password/i)
  })

  it('saves with the protection removed and downloads it under the same name', async () => {
    authenticate.mockResolvedValue(info)
    save.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const doc = useDocumentStore()
    await doc.unlockAndDownload('hunter2')
    // removeProtection is the sixth argument of save().
    expect(save.mock.calls[0]![5]).toBe(true)
    expect(exportFile.downloadBytes).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 'secret.pdf')
    expect(doc.status).toBe('ready')
  })

  it('reports a failed save instead of downloading', async () => {
    authenticate.mockResolvedValue(info)
    save.mockRejectedValue(new Error('The password could not be removed from this document.'))
    const doc = useDocumentStore()
    await doc.unlockAndDownload('hunter2')
    expect(exportFile.downloadBytes).not.toHaveBeenCalled()
    expect(doc.error).toMatch(/could not be removed/i)
  })
})
