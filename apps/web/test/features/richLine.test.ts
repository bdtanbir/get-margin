import { describe, it, expect } from 'vitest'
import {
  mergeRuns, readRuns, renderRuns, restyleRange, runsIn, toPatchFields, type EditRun,
} from '@/features/patch/richLine'

const run = (text: string, over: Partial<EditRun> = {}): EditRun => ({
  text, weight: 400, italic: false, scale: 1, rise: 0, color: [0, 0, 0], ...over,
})

describe('richLine', () => {
  it('renders one span per run and reads the same runs back', () => {
    const el = document.createElement('div')
    const runs = [run('This letter is for '), run('Arafat', { weight: 700 }), run(' only')]
    const styles = renderRuns(el, runs)
    expect(el.querySelectorAll('[data-run]')).toHaveLength(3)
    expect((el.querySelector('[data-run="1"]') as HTMLElement).style.fontWeight).toBe('700')
    expect(readRuns(el, styles, run(''))).toEqual(runs)
  })

  it('gives typed text the style of the run it was typed into', () => {
    const el = document.createElement('div')
    const styles = renderRuns(el, [run('Hi '), run('Arafat', { weight: 700 })])
    el.querySelector('[data-run="1"]')!.textContent = 'Arafat Hussain'
    expect(readRuns(el, styles, run(''))).toEqual([run('Hi '), run('Arafat Hussain', { weight: 700 })])
  })

  it('gives stray text the style before it, and drops line breaks', () => {
    const el = document.createElement('div')
    const styles = renderRuns(el, [run('Bold', { weight: 700 })])
    el.append(document.createTextNode('\nmore'))
    expect(readRuns(el, styles, run(''))).toEqual([run('Bold more', { weight: 700 })])
  })

  it('restyles exactly the selected characters', () => {
    const out = restyleRange([run('Hello world')], 6, 11, () => ({ weight: 700 }))
    expect(out).toEqual([run('Hello '), run('world', { weight: 700 })])
  })

  it('finds the runs a range touches', () => {
    const runs = [run('ab'), run('cd', { weight: 700 }), run('ef')]
    expect(runsIn(runs, 1, 3).map((r) => r.text)).toEqual(['ab', 'cd'])
  })

  it('merges neighbours in the same style', () => {
    expect(mergeRuns([run('a'), run(''), run('b')])).toEqual([run('ab')])
  })

  it('stores the first run as the patch style and the rest as overrides', () => {
    const fields = toPatchFields(
      [run('Between 14'), run('th', { scale: 0.67, rise: 0.33 }), run(' and '), run('Malaysia', { weight: 700 })],
      { weight: 400, italic: false, color: [0, 0, 0] },
    )
    expect(fields.text).toBe('Between 14th and Malaysia')
    expect(fields.weight).toBe(400)
    expect(fields.spans).toEqual([
      { text: 'Between 14' }, { text: 'th', scale: 0.67, rise: 0.33 },
      { text: ' and ' }, { text: 'Malaysia', weight: 700 },
    ])
  })

  it('stores no spans for a line in one style', () => {
    expect(toPatchFields([run('Plain')], { weight: 400, italic: false, color: [0, 0, 0] }).spans)
      .toBeUndefined()
  })
})
