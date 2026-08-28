import type { ToolId } from '@/stores/tools'

/**
 * What every tool in the rail is for, in the rail's own order.
 *
 * Split from `toolList.ts` rather than added to it. That list is imported
 * by the rail and the mobile strip, which need an id, a label and an icon
 * and nothing else; hanging two paragraphs of prose off each entry would
 * put the whole guide in the bundle of every screen that draws a toolbar.
 * This module is imported only by the guide dialog.
 *
 * The two cannot drift apart even so: `toolGuide.test.ts` asserts this
 * record has an entry for every id in `TOOLS` and no entries beyond them,
 * so a tool added to the rail without documentation fails the suite rather
 * than shipping undocumented. That is the same discipline `shortcuts.ts`
 * uses for the key bindings, and for the same reason -- a help page nobody
 * is forced to update is a help page that starts lying.
 */
export type ToolDoc = {
  /** What the user can accomplish. Their words, not the format's. */
  does: string
  /** The gesture. What to actually do with the pointer. */
  how: string
  /**
   * A limit worth knowing BEFORE using the tool rather than after.
   *
   * Only a handful of tools carry one, and each is a case where the
   * obvious assumption is wrong in a way that costs the user something
   * real: tools that look like they remove content, most of which only
   * cover it, and one that genuinely removes but only text.
   */
  caution?: string
}

export const TOOL_DOCS: Record<ToolId, ToolDoc> = {
  select: {
    does: 'Pick up anything you have added — move it, resize it, restyle it or delete it. It is also how you select the document’s own text before reaching for a markup tool.',
    how: 'Click an object to select it, then drag to move or drag a corner to resize. Delete removes it. Drag across the page’s text to select words.',
  },
  text: {
    does: 'Add a new line or paragraph of your own. Font, size, weight, colour and alignment are all in the inspector.',
    how: 'Drag out a box, then type. Click away, or press Escape, when you are done.',
    caution: 'This ADDS text. To change wording the document already has, use Edit text.',
  },
  image: {
    does: 'Place a picture — a logo, a scanned letterhead, a photo.',
    how: 'Pick a file. It lands centred on the page you are looking at and hands you back to Select, so positioning it is the very next thing you do.',
  },
  rect: {
    does: 'Draw a rectangle, outlined or filled.',
    how: 'Drag from one corner to the other. Stroke, width and fill are in the inspector.',
  },
  ellipse: {
    does: 'Draw an ellipse or a circle.',
    how: 'Drag to sweep out the box it sits inside.',
  },
  line: {
    does: 'Draw a straight line.',
    how: 'Drag from one end to the other. It keeps the direction you drew it in.',
  },
  arrow: {
    does: 'Point at something — call out a clause, or connect a note to the thing it is about.',
    how: 'Drag from the tail to the head. The arrowhead lands where you release.',
  },
  ink: {
    does: 'Draw freehand — a tick, a circled paragraph, a margin note in your own hand.',
    how: 'Drag to draw. Each stroke is one object, so a stray mark can be undone or deleted on its own.',
  },
  whiteout: {
    does: 'Cover something with an opaque block.',
    how: 'Drag a box over what you want hidden.',
    caution: 'This COVERS and does not remove. The text underneath is still in the file and can still be copied, searched or extracted. To actually take it out, use Redact.',
  },
  link: {
    does: 'Turn an area of the page into a clickable link.',
    how: 'Drag out the area, then enter the address. Only web, mail and telephone addresses are accepted.',
  },
  signature: {
    does: 'Sign the document — drawn with a pointer, typed in a handwriting face, or uploaded from a photo of your signature.',
    how: 'Open the tool, make the signature, then place it on the page.',
    caution: 'A signature is not kept on this device unless you tick the box that says so. That is deliberate: signing one document on a borrowed machine should not leave your signature behind on it.',
  },
  highlight: {
    does: 'Highlight the document’s own words.',
    how: 'Drag across the text. The colour is in the inspector.',
  },
  underline: {
    does: 'Underline the document’s own words.',
    how: 'Drag across the text.',
  },
  strikeout: {
    does: 'Strike through the document’s own words.',
    how: 'Drag across the text.',
  },
  crop: {
    does: 'Trim the page down to the part you want — margins off a scan, a slide out of a handout.',
    how: 'Drag out the area to KEEP, then apply it. There is an option to apply the same crop to every page at once.',
    caution: 'This changes the page’s frame rather than adding anything to it, so it affects the whole page rather than one object on it.',
  },
  field: {
    does: 'Add a fillable form field — a text box, a checkbox, a radio button, a dropdown, a list or a signature field.',
    how: 'Drag out the box, then pick which kind of field it is in the inspector. “Lock form answers” in the top bar turns the filled answers into ordinary page content when you export.',
  },
  redact: {
    does: 'Permanently remove words from the exported file. Unlike Whiteout, what you redact is genuinely gone — not merely hidden.',
    how: 'Drag across the text you want removed.',
    caution: 'Text only. It does not remove content from images or line art, so it will not take a face out of a photograph or a name out of a scanned page.',
  },
  patch: {
    does: 'Rewrite a line the document already says, keeping its font, its weight and the background behind it.',
    how: 'Click the line, then retype it.',
    caution: 'This replaces existing wording. To add a new line that was never there, use Text.',
  },
  editImage: {
    does: 'Move or take out a picture, logo or barcode the document came with, matching the colour of the paper behind it.',
    how: 'Outlined targets show every picture on the page. Click one to pick it up — it then behaves like anything else you have added, so you can drag it, drag a corner to resize it, duplicate it, or press Delete to take it out. An amber outline means the area behind it is not a flat colour.',
    caution: 'This covers the picture, it does not delete it from the file — someone opening the PDF with the right tools could still recover it. To add your own picture, use Image.',
  },
  lift: {
    does: 'Take a copy of any part of the page — a logo drawn as artwork, a table, a block of text, anything Edit image cannot see — and move it or hide it.',
    how: 'Drag a box around what you want. It lifts as one piece: drag it where you like, drag a corner to resize it, or press Delete to leave the space blank.',
    caution: 'The copy is a picture of that area, so it cannot be re-edited as text afterwards, it carries the paper behind it — moving it onto a coloured panel will show a pale rectangle — and enlarging it a long way past its original size will soften it. Like the other cover tools, the original is hidden rather than deleted.',
  },
}
