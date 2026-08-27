import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import MadeBy from '@/ui/MadeBy.vue'
import { AUTHOR_NAME, AUTHOR_URL, SUPPORT_URL, supportAvailable } from '@/lib/author'

/**
 * Re-imports the component against a stubbed author module, so the
 * "there is somewhere to send a supporter" branch can be exercised without
 * the shipped constant having to be non-empty.
 */
async function withSupportUrl(url: string) {
  vi.resetModules()
  vi.doMock('@/lib/author', () => ({
    AUTHOR_NAME,
    AUTHOR_URL,
    SUPPORT_URL: url,
    supportAvailable: () => url.trim().length > 0,
  }))
  const Comp = (await import('@/ui/MadeBy.vue')).default
  return mount(Comp)
}

afterEach(() => {
  vi.doUnmock('@/lib/author')
  vi.resetModules()
})

describe('MadeBy', () => {
  it('credits the author by name', () => {
    expect(mount(MadeBy).text()).toContain(`Made by ${AUTHOR_NAME}`)
  })

  it('links the name at the author site', () => {
    const a = mount(MadeBy).get('[data-author-link]')
    expect(a.attributes('href')).toBe(AUTHOR_URL)
  })

  /**
   * The tab holds an open document and unexported edits. A credit link
   * that navigated in place would discard someone's work to show them a
   * homepage, so this is a correctness assertion rather than a style one.
   */
  it('opens the author site in a new tab, without handing it window.opener', () => {
    const a = mount(MadeBy).get('[data-author-link]')
    expect(a.attributes('target')).toBe('_blank')
    expect(a.attributes('rel')).toContain('noopener')
    expect(a.attributes('rel')).toContain('noreferrer')
  })

  // A button asking for money that goes nowhere is worse than no button.
  it('shows no coffee link while there is no destination configured', () => {
    expect(mount(MadeBy).find('[data-support-link]').exists()).toBe(false)
  })

  it('ships with no destination configured', () => {
    expect(SUPPORT_URL).toBe('')
    expect(supportAvailable()).toBe(false)
  })

  it('shows the coffee link once a destination is set', async () => {
    const w = await withSupportUrl('https://opencollective.com/get-margin')
    const a = w.get('[data-support-link]')
    expect(a.attributes('href')).toBe('https://opencollective.com/get-margin')
    expect(a.attributes('target')).toBe('_blank')
    expect(a.attributes('rel')).toContain('noopener')
    expect(w.text()).toContain('Buy me a coffee')
  })

  it('treats a whitespace-only destination as no destination', async () => {
    const w = await withSupportUrl('   ')
    expect(w.find('[data-support-link]').exists()).toBe(false)
  })

  it('centres by default and can be aligned to the start', () => {
    expect(mount(MadeBy).get('[data-made-by]').classes()).toContain('justify-center')
    expect(
      mount(MadeBy, { props: { align: 'start' } }).get('[data-made-by]').classes(),
    ).toContain('justify-start')
  })
})
