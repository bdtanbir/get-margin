/**
 * The history coalesce key for a form field's value.
 *
 * Shared rather than spelled at each call site because agreement is the
 * whole point: two components writing the same field under different keys
 * would split one burst of typing into two undo entries, and the user would
 * press Cmd+Z twice to undo what looked like one action.
 */
export function fieldCoalesceKey(key: string): string {
  return `field:${key}`
}
