import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useToolsStore } from '@/stores/tools'
import { useEditsStore } from '@/stores/edits'

describe('useToolsStore', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('starts on the select tool', () => {
    expect(useToolsStore().active).toBe('select')
  })

  it('switches tools', () => {
    const t = useToolsStore()
    t.setTool('rect')
    expect(t.active).toBe('rect')
  })

  it('clears the selection when leaving the select tool', () => {
    const t = useToolsStore()
    const e = useEditsStore()
    e.reset('h', ['p1'], { p1: { sourceIndex: 0 } })
    e.select(['o1'])
    t.setTool('rect')
    expect(e.selection).toEqual([])
  })

  it('drops any in-flight draft when the tool changes', () => {
    const t = useToolsStore()
    t.setTool('rect')
    t.setDraft({ pageId: 'p1', rect: { x: 0, y: 0, w: 10, h: 10 } })
    t.setTool('ellipse')
    expect(t.draft).toBeUndefined()
  })

  it('never records tool state in edit history', () => {
    const t = useToolsStore()
    const e = useEditsStore()
    e.reset('h', ['p1'], { p1: { sourceIndex: 0 } })
    t.setTool('rect')
    t.setDraft({ pageId: 'p1', rect: { x: 0, y: 0, w: 10, h: 10 } })
    expect(e.canUndo).toBe(false)
  })
})
