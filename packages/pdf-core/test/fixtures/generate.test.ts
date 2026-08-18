import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import { generateFixtures, fixturePath, FIXTURE_NAMES } from './index.js'

beforeAll(async () => {
  await generateFixtures()
}, 60_000)

describe('fixtures', () => {
  it('writes every declared fixture', () => {
    for (const name of FIXTURE_NAMES) {
      const p = fixturePath(name)
      expect(existsSync(p), `missing fixture: ${name}`).toBe(true)
      expect(statSync(p).size).toBeGreaterThan(500)
    }
  })

  it('produces byte-identical output on repeat runs', async () => {
    const { readFileSync } = await import('node:fs')
    const before = readFileSync(fixturePath('simple-text'))
    await generateFixtures()
    const after = readFileSync(fixturePath('simple-text'))
    expect(after.equals(before)).toBe(true)
  })
})
