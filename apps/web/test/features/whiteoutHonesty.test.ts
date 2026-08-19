import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import Inspector from '@/features/tools/Inspector.vue'
import ToolRail from '@/features/tools/ToolRail.vue'
import { useEditsStore } from '@/stores/edits'
import type { EditObject } from '@margin/pdf-core'

const whiteout: EditObject = {
  id: 'w1', pageId: 'p1', kind: 'whiteout',
  rect: { x: 10, y: 20, w: 100, h: 50 },
  rotation: 0, z: 1, locked: false, opacity: 1, fill: [1, 1, 1],
}

const shape: EditObject = {
  id: 'r1', pageId: 'p1', kind: 'rect',
  rect: { x: 10, y: 20, w: 100, h: 50 },
  rotation: 0, z: 1, locked: false, opacity: 1,
  stroke: [0, 0, 0], strokeWidth: 1, fill: null,
}

/**
 * Spec 2.1. Whiteout covers content and does not remove it; the underlying
 * text stays extractable (pdf-core/test/write/whiteout.test.ts asserts
 * exactly that). Users white out SSNs believing the data is gone, so the UI
 * has to say otherwise in plain words. These tests are the guard on that
 * copy -- if they ever start failing, the product has quietly started
 * implying redaction it does not perform.
 */
describe('whiteout honesty', () => {
  /**
   * Rendered markup with HTML comments stripped. Comments are checked out of
   * this assertion deliberately: the source comments in Inspector.vue and
   * toolList.ts warn future editors never to call this tool "redact", and
   * quoting the forbidden word in order to forbid it must not read as the
   * product using it. Attributes stay in scope -- an aria-label saying
   * "Redact" would be exactly the failure this guards.
   */
  const visibleMarkup = (w: { html: () => string }): string =>
    w.html().replace(/<!--[\s\S]*?-->/g, '').toLowerCase()

  let edits: ReturnType<typeof useEditsStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    edits = useEditsStore()
    edits.reset('h', ['p1'], { p1: { sourceIndex: 0 } })
    edits.applyOp({ type: 'addObject', object: whiteout }, 'add')
    edits.applyOp({ type: 'addObject', object: shape }, 'add')
  })

  it('tells the user, on the whiteout object, that it does not delete', () => {
    edits.select(['w1'])
    expect(mount(Inspector).text()).toContain('does not delete')
  })

  it('says the covered text can still be copied out', () => {
    edits.select(['w1'])
    expect(mount(Inspector).text()).toContain('still be copied out')
  })

  it('never says "redact" anywhere in the inspector', () => {
    edits.select(['w1'])
    expect(visibleMarkup(mount(Inspector))).not.toContain('redact')
  })

  it('never says "redact" anywhere in the tool rail', () => {
    expect(visibleMarkup(mount(ToolRail))).not.toContain('redact')
  })

  it('does not show the notice for other kinds', () => {
    edits.select(['r1'])
    expect(mount(Inspector).find('[data-whiteout-notice]').exists()).toBe(false)
  })
})
