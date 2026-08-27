/**
 * Who made this, and where to say thanks.
 *
 * One module rather than copy in each component: the credit appears in two
 * places (the empty state and the help panel) and a name that drifted
 * between them would be a bug nobody notices until it is on a screenshot.
 *
 * The link is a plain URL rendered as an `<a>`. It is deliberately NOT a
 * platform's embed script -- Buy Me a Coffee, Ko-fi and friends all ship a
 * widget that loads third-party JavaScript, which would put a tracker on
 * the same page as "Nothing is uploaded" and make that sentence false.
 */
export const AUTHOR_NAME = 'Tanbir Ahmod'
export const AUTHOR_URL = 'https://tanbirahmod.com/'

/**
 * Where "Buy me a coffee" points, or empty when there is nowhere to point.
 *
 * Empty by default and empty on purpose. The usual tipping platforms pay
 * out only through Stripe or PayPal, neither of which reaches this
 * author's country, so the destination is an open question. Shipping a
 * guessed URL would put a dead link in the one place a user is being asked
 * for money -- worse than no button at all.
 *
 * When a destination exists, set it here. Nothing else needs to change:
 * `supportAvailable()` gates every piece of UI that mentions it.
 */
export const SUPPORT_URL = ''

/** True when there is a real destination to send a would-be supporter to. */
export function supportAvailable(): boolean {
  return SUPPORT_URL.trim().length > 0
}
