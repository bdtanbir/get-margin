import { describe, test, expect, vi } from 'vitest'
import { consumeLaunchedFile, type LaunchConsumer, type LaunchQueue } from '@/lib/pwa/launchQueue'

/** Captures the consumer the app registers, so a test can drive a launch. */
function fakeQueue(): { queue: LaunchQueue; launch: LaunchConsumer } {
  let consumer: LaunchConsumer = async () => {}
  return {
    queue: { setConsumer: (c) => { consumer = c } },
    launch: (params) => consumer(params),
  }
}

function handleFor(file: File): FileSystemFileHandle {
  return { getFile: async () => file } as unknown as FileSystemFileHandle
}

describe('consumeLaunchedFile', () => {
  test('does nothing on a browser with no launch queue', () => {
    const open = vi.fn()

    expect(() => consumeLaunchedFile(open, undefined)).not.toThrow()
    expect(open).not.toHaveBeenCalled()
  })

  test('opens the file the operating system handed over', async () => {
    const open = vi.fn()
    const file = new File([new Uint8Array([1])], 'report.pdf', { type: 'application/pdf' })
    const { queue, launch } = fakeQueue()
    consumeLaunchedFile(open, queue)

    await launch({ files: [handleFor(file)] })

    expect(open).toHaveBeenCalledWith(file)
  })

  test('opens nothing when the app was launched from its own icon', async () => {
    const open = vi.fn()
    const { queue, launch } = fakeQueue()
    consumeLaunchedFile(open, queue)

    await launch({ files: [] })

    expect(open).not.toHaveBeenCalled()
  })

  test('opens only the first of several files, since the editor holds one document', async () => {
    const open = vi.fn()
    const first = new File([new Uint8Array([1])], 'first.pdf')
    const second = new File([new Uint8Array([2])], 'second.pdf')
    const { queue, launch } = fakeQueue()
    consumeLaunchedFile(open, queue)

    await launch({ files: [handleFor(first), handleFor(second)] })

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(first)
  })

  test('reports a handle it cannot read instead of throwing into the launch', async () => {
    const open = vi.fn()
    const onError = vi.fn()
    const denied = {
      getFile: async () => { throw new Error('NotAllowedError') },
    } as unknown as FileSystemFileHandle
    const { queue, launch } = fakeQueue()
    consumeLaunchedFile(open, queue, onError)

    await expect(launch({ files: [denied] })).resolves.toBeUndefined()

    expect(open).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
  })
})
