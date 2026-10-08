import type { ToolId } from '@/stores/tools'

/**
 * One line per tool, shown under its hover preview.
 *
 * Deliberately NOT read from `help/toolGuide.ts`: that module is kept out of
 * the rail's bundle on purpose (two paragraphs per tool for a screen that
 * needs a name). A hover card needs a sentence, so the sentences live here
 * and `toolPreviews.test.ts` fails if one is missing for a tool in the rail.
 */
export const PREVIEW_HINTS: Record<ToolId, string> = {
  select: 'Move, resize or delete what you added.',
  text: 'Drag a box, then type new text.',
  image: 'Place a logo, scan or photo.',
  rect: 'Drag corner to corner.',
  ellipse: 'Drag to draw an ellipse or circle.',
  line: 'Drag from one end to the other.',
  arrow: 'Drag from tail to head.',
  ink: 'Draw freehand on the page.',
  whiteout: 'Cover something. It stays in the file.',
  link: 'Turn an area into a clickable link.',
  signature: 'Draw, type or upload your signature.',
  highlight: 'Drag across the document’s words.',
  underline: 'Drag across the words to underline.',
  strikeout: 'Drag across the words to strike through.',
  crop: 'Drag the area to keep.',
  field: 'Add a fillable form field.',
  redact: 'Permanently remove words from the file.',
  patch: 'Click a line and retype it.',
  editImage: 'Move or remove a picture the file came with.',
  lift: 'Copy any area of the page and move it.',
}
