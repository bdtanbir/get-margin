import type { Component } from 'vue'
import {
  Type, Image, Square, Circle, Minus, ArrowRight, Pen, Eraser, Link2,
  Signature, Highlighter, Underline, Strikethrough, TextCursorInput,
  SquareSlash, TextSelect, Stamp, ImageOff, SquareDashedMousePointer,
} from 'lucide-vue-next'
import type { EditObject, ObjectKind } from '@margin/pdf-core'

/**
 * Longest label a row shows before it is cut short. The sidebar is 20rem
 * wide and a row also carries an icon and a delete button, so a label much
 * past this either wraps to a second line or pushes the button off the end.
 */
export const LABEL_MAX = 32

/** What each kind is called when the object has no words of its own. */
const KIND_NAMES: Record<ObjectKind, string> = {
  text: 'Text',
  image: 'Image',
  signature: 'Signature',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  ink: 'Drawing',
  whiteout: 'Whiteout',
  link: 'Link',
  field: 'Form field',
  stamp: 'Stamp',
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'Strikeout',
  redaction: 'Redaction',
  textPatch: 'Edited text',
  imagePatch: 'Edited image',
  regionPatch: 'Lifted area',
}

/** The rail's icon for the tool that made the object, so the two agree. */
const KIND_ICONS: Record<ObjectKind, Component> = {
  text: Type,
  image: Image,
  signature: Signature,
  rect: Square,
  ellipse: Circle,
  line: Minus,
  arrow: ArrowRight,
  ink: Pen,
  whiteout: Eraser,
  link: Link2,
  field: TextCursorInput,
  stamp: Stamp,
  highlight: Highlighter,
  underline: Underline,
  strikeout: Strikethrough,
  redaction: SquareSlash,
  textPatch: TextSelect,
  imagePatch: ImageOff,
  regionPatch: SquareDashedMousePointer,
}

/**
 * The words an object carries, if it carries any.
 *
 * A list of eleven rows all reading "Text" is a list the user has to click
 * through one row at a time to find anything, so an object that says
 * something identifies itself with what it says.
 */
/**
 * What a patch is CARRYING, which is what distinguishes one row from
 * another in a list of them.
 *
 * "Edited image" told the user nothing about which of the two states a row
 * was in -- hiding the document's own picture, or holding a copy of it
 * that has been moved. Those look completely different on the page, and a
 * list that calls them the same thing is a list you have to click through.
 */
function patchState(o: EditObject): string | undefined {
  if (o.kind !== 'imagePatch' && o.kind !== 'regionPatch') return undefined
  const carrying = (o.data?.length ?? 0) > 0
  if (o.kind === 'imagePatch') return carrying ? 'Image' : 'Hidden image'
  return carrying ? 'Lifted area' : 'Hidden area'
}

function ownWords(o: EditObject): string | undefined {
  switch (o.kind) {
    case 'text':
    case 'stamp':
    case 'textPatch':
      return o.text
    case 'link':
      return o.uri
    case 'field':
      return o.name
    default:
      return undefined
  }
}

/**
 * One line identifying an object in the layers list.
 *
 * Newlines are collapsed rather than kept: a row is one line tall, and a
 * label containing a line break would either be clipped mid-word or push
 * every row below it out of alignment.
 */
export function layerLabel(o: EditObject): string {
  const words = ownWords(o)?.replace(/\s+/g, ' ').trim()
  if (!words) return patchState(o) ?? KIND_NAMES[o.kind]
  return words.length > LABEL_MAX ? `${words.slice(0, LABEL_MAX)}…` : words
}

export function layerIcon(kind: ObjectKind): Component {
  return KIND_ICONS[kind]
}
