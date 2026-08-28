import type { Component } from 'vue'
import {
  Type, Image, Square, Circle, Minus, ArrowRight, Pen, Eraser, Link2,
  Signature, Highlighter, Underline, Strikethrough, TextCursorInput,
  SquareSlash, TextSelect, Stamp, ImageOff,
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
}

/**
 * The words an object carries, if it carries any.
 *
 * A list of eleven rows all reading "Text" is a list the user has to click
 * through one row at a time to find anything, so an object that says
 * something identifies itself with what it says.
 */
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
  if (!words) return KIND_NAMES[o.kind]
  return words.length > LABEL_MAX ? `${words.slice(0, LABEL_MAX)}…` : words
}

export function layerIcon(kind: ObjectKind): Component {
  return KIND_ICONS[kind]
}
