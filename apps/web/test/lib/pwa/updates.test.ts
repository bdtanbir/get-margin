import { describe, test, expect, vi } from 'vitest'
import { createPwaUpdates, type RegisterSW } from '@/lib/pwa/updates'

/** A stand-in for vite-plugin-pwa's `registerSW`, with the hooks exposed. */
function fakeRegister(): { register: RegisterSW; fireNeedRefresh: () => void; updateSW: ReturnType<typeof vi.fn> } {
  let onNeedRefresh = (): void => {}
  const updateSW = vi.fn(async () => {})
  const register: RegisterSW = (hooks) => {
    onNeedRefresh = hooks.onNeedRefresh
    return updateSW
  }
  return { register, fireNeedRefresh: () => onNeedRefresh(), updateSW }
}

describe('createPwaUpdates', () => {
  test('does not ask for a refresh before the service worker reports one', () => {
    const { register } = fakeRegister()

    const updates = createPwaUpdates(register)

    expect(updates.needsRefresh.value).toBe(false)
  })

  test('asks for a refresh once a new service worker is waiting', () => {
    const { register, fireNeedRefresh } = fakeRegister()
    const updates = createPwaUpdates(register)

    fireNeedRefresh()

    expect(updates.needsRefresh.value).toBe(true)
  })

  test('apply activates the waiting worker and reloads', () => {
    const { register, fireNeedRefresh, updateSW } = fakeRegister()
    const updates = createPwaUpdates(register)
    fireNeedRefresh()

    updates.apply()

    expect(updateSW).toHaveBeenCalledWith(true)
  })

  test('dismiss hides the offer without reloading', () => {
    const { register, fireNeedRefresh, updateSW } = fakeRegister()
    const updates = createPwaUpdates(register)
    fireNeedRefresh()

    updates.dismiss()

    expect(updates.needsRefresh.value).toBe(false)
    expect(updateSW).not.toHaveBeenCalled()
  })

  test('survives a browser that refuses to register a service worker', () => {
    const register: RegisterSW = () => {
      throw new Error('SecurityError: service workers are disabled')
    }

    const updates = createPwaUpdates(register)

    expect(updates.needsRefresh.value).toBe(false)
    expect(() => updates.apply()).not.toThrow()
  })
})
