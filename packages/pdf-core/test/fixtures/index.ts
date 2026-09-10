import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE_NAMES = [
  'simple-text', 'rotated', 'offset-cropbox', 'multi-page', 'large-300p', 'mixed-fonts',
  // Carries scripted actions, for the sanitiser. Generated, never committed.
  'hostile',
  // A real AcroForm: text, multiline text, checkbox, radio group, dropdown.
  'form',
  // A page with a real embedded image, for the tools that edit one.
  'with-image',
  // A turned page whose text was authored sideways so that it reads UPRIGHT
  // once /Rotate is applied -- the shape of a real scanner/report PDF, and
  // the one `rotated` does not cover: there the text displays sideways.
  'rotated-upright',
] as const

export type FixtureName = (typeof FIXTURE_NAMES)[number]

const DIR = fileURLToPath(new URL('.', import.meta.url))

export function fixturePath(name: FixtureName): string {
  return join(DIR, `${name}.pdf`)
}

export { generateFixtures } from './generate.js'
