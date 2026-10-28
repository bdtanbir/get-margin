# Paragraph editing: wrap, Enter and multi-line paste

## The problem

Edit text worked on ONE extracted line at a time. Clicking the last line of
a paragraph opened a one-line field; Enter committed, paste flattened line
breaks into spaces, and anything longer than the line ran off to the right
across the column border (`fit: 'overflow'`). There was nowhere for extra
words to go because the editor did not know which lines formed a paragraph.

Sejda and every word processor do the opposite: click a paragraph, type,
the text wraps at the paragraph's width, Enter starts a new line.

## What changes for the user

- Clicking any line of a paragraph opens the WHOLE paragraph in one field.
- The field is as wide as the paragraph (or its column) and wraps.
- Enter / Shift+Enter insert a line break. Ctrl/Cmd+Enter or clicking away
  commits; Escape cancels.
- Paste keeps the clipboard's line breaks.
- The export and the on-screen preview draw the text wrapped the same way.

## Limits (stated, not hidden)

- Nothing below the paragraph moves. A PDF has no flow; a longer paragraph
  runs down over whatever is under it, as in Sejda.
- Re-wrapped text is left-aligned. Justified paragraphs lose their stretched
  word spacing (follow-up: justify with `TJ` adjustments).
- Paragraph detection is a heuristic over MuPDF's blocks. Where it is wrong
  (tables, columns), the worst case is a smaller paragraph than expected --
  rows that do not line up are never merged.
- The selection frame of a paragraph patch is the ORIGINAL paragraph's box,
  not the grown one.

## Format

`TextPatchObject` gains one optional field; absent means exactly the old
single-line behaviour, so no stored document migrates.

```ts
paragraph?: {
  lines: { lineIndex; originalHash; originalText }[] // the OTHER lines, in order
  width: number    // wrap width in points; 0 = only break at '\n'
  leading: number  // baseline-to-baseline, as a multiple of fontSize
  indent: number   // how far the first line starts right of the rest, points
}
```

- `lineIndex` / `originalHash` stay the paragraph's FIRST line. Every other
  line carries its own hash, and the writer refuses the patch if any of them
  changed -- the same guard as before, per line.
- `rect` is the union of the paragraph's lines (what is replaced).
- `text` may contain `\n`.
- Leading is a ratio so changing the size in the inspector keeps spacing.

ONE PATCH PER PARAGRAPH. `patchOnLine` answers for every member line, so a
click on line 3 re-opens the paragraph patch, and nothing can add a second
patch over a line a paragraph already owns. A paragraph never absorbs a line
that already has its own patch.

## Layout

`layoutRuns` in `pdf-core/write/patchRuns.ts`, shared by the writer and the
preview so the file and the screen break lines in the same places:
hard breaks at `\n`, then greedy word wrap at `width` (first line
`width - indent`), spaces swallowed at soft breaks, a word wider than the
line broken by character. Measured per run in its own face.

A patch is in "block mode" when it has `paragraph` or its text has `\n`.
Block mode ignores `fit` (it always flows down). Without either, the old
single-line path runs unchanged.

## Export

`prepareTextPatches` resolves and hash-checks every line of every patch,
then removes all of them in one `removeLines` call. Lines that could not be
removed are covered individually. The paragraph is drawn line by line from
the first line's pen: line k starts at `pen - indent·u + k·leading·size·down`.

## Paragraph detection (`apps/web/src/features/patch/paragraphs.ts`)

1. Lines become ROWS: lines on the same baseline, left to right, at most
   about a word space apart (a bold label and the rest of its line are often
   two lines; table cells on one baseline must NOT join).
2. Consecutive rows join a paragraph when their blocks agree, they share a
   size (±15%), the baseline step is 0.9–3× the size, not more than 1.3× the
   page's usual step (median, needs 3+ samples; else at most 2.2× the size),
   consistent with the paragraph's first step, and the left edges line up
   (the first row may be indented).
   Blocks "agree" when they are the same block, or both hold a single row:
   Word's PDF export puts every line in its own block, so there a block
   boundary says nothing.
3. A row much shorter than the paragraph's widest row ends it.
4. Width = max(paragraph width, widest line on the page starting at the same
   left edge); leading = the paragraph's own step, else the page's typical
   step at that size, else 1.2.

## Editor

A warning appears under the field when the text needs more rows than the
paragraph had, because those rows will overlap what is below.

The field becomes multi-line in block mode: `white-space: pre-wrap`, fixed
width at the wrap width, `text-indent` for the first line, line-height from
the leading, growing downward. Newlines are literal `\n` in the field's text
nodes; `readRuns` keeps them.
