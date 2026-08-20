import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { Result } from 'axe-core'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/pdf-core/test/fixtures/multi-page.pdf', import.meta.url),
)

/**
 * WCAG 2.0 and 2.1, levels A and AA.
 *
 * AAA is deliberately absent: it asks for 7:1 body contrast among other
 * things, and holding the product to a level almost nothing meets would
 * make this suite noise to be silenced rather than a gate to be kept.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

/**
 * Zero violations. Not "no worse than last time".
 *
 * A recorded baseline is how an audit becomes decoration: each new
 * violation is one more than yesterday, which always looks acceptable in
 * isolation, and the number only ever goes up. The three violations this
 * suite was written against are fixed, so zero is a number the code
 * actually holds today rather than an aspiration.
 *
 * Runs on every engine in the matrix. Contrast is arithmetic and identical
 * everywhere, but roles, focus order and accessible-name computation are
 * not -- Firefox and WebKit each build the accessibility tree themselves.
 */
function report(violations: Result[]): string {
  if (violations.length === 0) return ''
  return violations
    .map((v) => {
      const nodes = v.nodes
        .map((n) => `      ${n.target.join(' ')}\n        ${n.html.slice(0, 120)}`)
        .join('\n')
      return `  [${v.impact}] ${v.id} — ${v.help}\n${nodes}\n      ${v.helpUrl}`
    })
    .join('\n\n')
}

async function audit(page: import('@playwright/test').Page): Promise<Result[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  return results.violations
}

test.describe('accessibility', () => {
  test('the empty state has no violations', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('[data-empty-state]')).toBeVisible()

    const violations = await audit(page)
    expect(violations.length, `\n${report(violations)}`).toBe(0)
  })

  test('an open document has no violations', async ({ page }) => {
    await page.goto('/')
    await page.setInputFiles('input[type=file]', FIXTURE)
    // The audit has to run against the real thing, so wait for a rendered
    // page rather than for the shell.
    await expect(page.getByRole('img', { name: 'Page 1', exact: true })).toBeVisible({
      timeout: 30_000,
    })

    const violations = await audit(page)
    expect(violations.length, `\n${report(violations)}`).toBe(0)
  })

  /**
   * The pages grid earned its own case.
   *
   * It is the surface where the violations were: a listbox whose options
   * were not focusable, containing buttons that were. On a phone it is a
   * modal rather than a sidebar, which is a different tree again.
   */
  test('the pages grid has no violations', async ({ page }, testInfo) => {
    await page.goto('/')
    await page.setInputFiles('input[type=file]', FIXTURE)
    await expect(page.getByRole('img', { name: 'Page 1', exact: true })).toBeVisible({
      timeout: 30_000,
    })

    if (testInfo.project.name === 'phone') {
      await page.getByRole('button', { name: 'Pages' }).click()
      await expect(page.getByRole('dialog', { name: 'Pages' })).toBeVisible()
    }
    await expect(page.locator('[data-page-tile]').first()).toBeVisible()

    const violations = await audit(page)
    expect(violations.length, `\n${report(violations)}`).toBe(0)
  })

  /**
   * A keyboard user must be able to reach a page and select it without a
   * pointer. This is the behaviour the nested-interactive fix replaced, so
   * it is asserted in a real browser rather than only in jsdom -- focus
   * behaviour is exactly what a component test approximates worst.
   */
  test('pages can be selected with the keyboard alone', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'no hardware keyboard on the phone project')

    await page.goto('/')
    await page.setInputFiles('input[type=file]', FIXTURE)
    await expect(page.getByRole('img', { name: 'Page 1', exact: true })).toBeVisible({
      timeout: 30_000,
    })

    const first = page.getByRole('option', { name: 'Page 1', exact: true })
    await first.focus()
    await expect(first).toBeFocused()

    await page.keyboard.press(' ')
    await expect(first).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('option', { name: 'Page 2', exact: true })).toBeFocused()
    // Moving the focus must not discard a selection already made.
    await expect(first).toHaveAttribute('aria-selected', 'true')
  })
})
