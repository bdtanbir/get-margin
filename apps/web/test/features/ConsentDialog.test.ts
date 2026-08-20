import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ConsentDialog from '@/features/convert/ConsentDialog.vue'
import { JOB_TTL_MS } from '@margin/shared'

const props = {
  fileName: '2024-tax-return-jane-doe.html',
  fileSize: 2 * 1024 * 1024,
  operation: 'converted to a PDF',
}

const open = (over: Partial<typeof props> = {}) => mount(ConsentDialog, { props: { ...props, ...over } })

/**
 * These tests assert what the dialog SAYS, not that it exists.
 *
 * A consent dialog that omits the deletion policy is still a dialog, still
 * renders, and still gates the action -- and is exactly the failure worth
 * catching, because nothing else in the system notices. `PHASE-7-DESIGN.md`
 * §10 says so directly.
 */
describe('ConsentDialog', () => {
  it('names the file being uploaded, and its size', () => {
    const w = open()
    expect(w.get('[data-consent-file]').text()).toBe('2024-tax-return-jane-doe.html')
    expect(w.get('[data-consent-size]').text()).toContain('2.0 MB')
  })

  /** With several documents open, "upload the file?" is not an answerable question. */
  it('names a different file when a different file is being sent', () => {
    const w = open({ fileName: 'invoice.html', fileSize: 40 * 1024 })
    expect(w.get('[data-consent-file]').text()).toBe('invoice.html')
    expect(w.get('[data-consent-size]').text()).toContain('40 KB')
  })

  it('says what will be done to it', () => {
    expect(open().get('[data-consent-operation]').text()).toBe('converted to a PDF')
  })

  it('states the deletion policy: on download, and on a deadline regardless', () => {
    const text = open().get('[data-consent-deletion]').text()
    expect(text).toMatch(/deleted as soon as you download/i)
    expect(text).toMatch(/within an hour/i)
    // The unconditional part. A conversion that fails still had the file.
    expect(text).toMatch(/whether the conversion works or not/i)
  })

  /**
   * The window comes from the server's own TTL, so a change to retention
   * cannot leave this sentence behind saying something that is no longer
   * true.
   */
  it('takes the deletion window from the shared TTL rather than a hardcoded string', () => {
    expect(JOB_TTL_MS).toBe(60 * 60 * 1000)
    expect(open().get('[data-consent-deletion]').text()).toContain('an hour')
  })

  /**
   * The sentence that makes the rest of the product's promise legible: if
   * everything else is local, the exception has to be named as one.
   */
  it('states that this is the only feature that uploads anything', () => {
    const text = open().get('[data-consent-only]').text()
    expect(text).toMatch(/only feature/i)
    expect(text).toMatch(/uploads anything/i)
    expect(text).toMatch(/stays on your device/i)
  })

  it('starts with the box unticked and the action disabled', () => {
    const w = open()
    expect((w.get('[data-consent-agree]').element as HTMLInputElement).checked).toBe(false)
    expect((w.get('[data-consent-confirm]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('enables the action only once consent is actually given', async () => {
    const w = open()
    await w.get('[data-consent-agree]').setValue(true)
    expect((w.get('[data-consent-confirm]').element as HTMLButtonElement).disabled).toBe(false)
    await w.get('[data-consent-confirm]').trigger('click')
    expect(w.emitted('confirm')).toBeTruthy()
  })

  it('un-consenting disables it again', async () => {
    const w = open()
    await w.get('[data-consent-agree]').setValue(true)
    await w.get('[data-consent-agree]').setValue(false)
    expect((w.get('[data-consent-confirm]').element as HTMLButtonElement).disabled).toBe(true)
  })

  /** Cancelling must upload nothing, which here means: emit cancel and never confirm. */
  it('cancels without confirming', async () => {
    const w = open()
    await w.get('[data-consent-cancel]').trigger('click')
    expect(w.emitted('cancel')).toBeTruthy()
    expect(w.emitted('confirm')).toBeUndefined()
  })

  it('cancels on a click outside the panel too, without confirming', async () => {
    const w = open()
    await w.get('[data-consent-dialog]').trigger('click')
    expect(w.emitted('cancel')).toBeTruthy()
    expect(w.emitted('confirm')).toBeUndefined()
  })

  /**
   * A consent that can be skipped by muscle memory is not consent. There is
   * no "don't show again", so this asserts the absence rather than trusting
   * that nobody adds one.
   */
  it('offers no way to skip the question next time', () => {
    // The rendered TEXT, not the markup: a source comment explaining why
    // there is no such control would otherwise fail this.
    const text = open().text()
    expect(text).not.toMatch(/don.?t show|do not show|remember (this|my) choice|skip this/i)
    // And nothing is pre-ticked, which is the same failure in another shape.
    expect(open().findAll('input[type="checkbox"]').length).toBe(1)
    expect(
      open()
        .findAll('input[type="checkbox"]')
        .every((c) => !(c.element as HTMLInputElement).checked),
    ).toBe(true)
  })

  /** A fresh mount is a fresh question: consent is per action, so no state survives. */
  it('does not remember consent given a moment ago', async () => {
    const first = open()
    await first.get('[data-consent-agree]').setValue(true)
    first.unmount()

    const second = open()
    expect((second.get('[data-consent-agree]').element as HTMLInputElement).checked).toBe(false)
    expect((second.get('[data-consent-confirm]').element as HTMLButtonElement).disabled).toBe(true)
  })
})
