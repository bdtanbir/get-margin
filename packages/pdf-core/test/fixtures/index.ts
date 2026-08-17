import { join } from 'node:path'

export const FIXTURE_NAMES = [
  'simple-text', 'rotated', 'offset-cropbox', 'multi-page', 'large-300p', 'mixed-fonts',
] as const

export type FixtureName = (typeof FIXTURE_NAMES)[number]

const DIR = new URL('.', import.meta.url).pathname

export function fixturePath(name: FixtureName): string {
  return join(DIR, `${name}.pdf`)
}

export { generateFixtures } from './generate.js'
