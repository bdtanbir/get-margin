import type { Component } from 'vue'
import {
  MousePointer2, Type, Image, Square, Circle, Minus, ArrowRight,
  Pen, Eraser, Link2, Signature, Highlighter, Underline, Strikethrough, Crop, TextCursorInput,
  SquareSlash, TextSelect,
} from 'lucide-vue-next'
import type { ToolId } from '@/stores/tools'

/**
 * The one tool list, shared by the desktop rail and the mobile strip so the
 * two shells cannot drift apart -- a tool reachable on desktop and missing
 * on mobile is a document you cannot finish editing on your phone.
 *
 * `label` is both the tooltip and the accessible name. "Whiteout" is
 * deliberate and load-bearing: the tool COVERS content and does not remove
 * it (spec 2.1). Calling it "redact" would be a user-harm risk -- people
 * white out SSNs and believe they are gone. Real redaction is Phase 6.
 */
export const TOOLS: Array<{ id: ToolId; label: string; icon: Component }> = [
  { id: 'select', label: 'Select', icon: MousePointer2 },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'image', label: 'Image', icon: Image },
  { id: 'rect', label: 'Rectangle', icon: Square },
  { id: 'ellipse', label: 'Ellipse', icon: Circle },
  { id: 'line', label: 'Line', icon: Minus },
  { id: 'arrow', label: 'Arrow', icon: ArrowRight },
  { id: 'ink', label: 'Draw', icon: Pen },
  { id: 'whiteout', label: 'Whiteout', icon: Eraser },
  { id: 'link', label: 'Link', icon: Link2 },
  { id: 'signature', label: 'Signature', icon: Signature },
  { id: 'highlight', label: 'Highlight', icon: Highlighter },
  { id: 'underline', label: 'Underline', icon: Underline },
  { id: 'strikeout', label: 'Strikeout', icon: Strikethrough },
  { id: 'crop', label: 'Crop', icon: Crop },
  // ONE entry for all six field types; the type is chosen in the inspector.
  // Six rail entries would make forms the visually dominant feature of a
  // product where they are one phase of eight.
  { id: 'field', label: 'Form field', icon: TextCursorInput },
  // Deliberately NOT next to Whiteout. The two look similar and do opposite
  // things -- one covers, one removes -- and putting them side by side in
  // the rail would invite exactly the confusion the whiteout copy exists to
  // prevent.
  { id: 'redact', label: 'Redact', icon: SquareSlash },
  // "Edit text" rather than "text": the Text tool ADDS text, this one
  // replaces what the document already says, and the two are easy to
  // confuse from an icon alone.
  { id: 'patch', label: 'Edit text', icon: TextSelect },
]
