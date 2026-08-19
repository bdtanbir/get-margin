import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE_NAMES = [
  'simple-text', 'rotated', 'offset-cropbox', 'multi-page', 'large-300p', 'mixed-fonts',
  // Carries scripted actions, for the sanitiser. Generated, never committed.
  'hostile',
  // A real AcroForm: text, multiline text, checkbox, radio group, dropdown.
  'form',
] as const

export type FixtureName = (typeof FIXTURE_NAMES)[number]

const DIR = fileURLToPath(new URL('.', import.meta.url))

export function fixturePath(name: FixtureName): string {
  return join(DIR, `${name}.pdf`)
}

export { generateFixtures } from './generate.js'
