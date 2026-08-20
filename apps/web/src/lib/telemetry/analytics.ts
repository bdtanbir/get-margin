import { ref, computed, type Ref } from 'vue'
import {
  TELEMETRY_ENDPOINT,
  configureReporter,
  httpTransport,
  reporter,
  telemetryConfigured,
} from './reporter'

/**
 * Whether the person using this app has been asked, and what they said.
 *
 * `unset` is a real state, not a default of "no". It is what makes the
 * difference between "has not been asked" and "said no", and only the
 * first of those should produce a prompt.
 */
export type TelemetryChoice = 'unset' | 'granted' | 'declined'

const STORAGE_KEY = 'margin.telemetry'

/**
 * The choice IS remembered, and that is a deliberate difference from the
 * upload consent in `features/convert/ConsentDialog.vue`.
 *
 * Those are not the same kind of decision. An upload sends one specific
 * file, so consent is per action and per file -- a remembered "yes" there
 * would be a standing permission to send documents nobody looked at again.
 * This is a standing preference about anonymous counters, where asking on
 * every launch would train people to dismiss it without reading, which is
 * how consent stops meaning anything.
 */
const choice: Ref<TelemetryChoice> = ref(read())

function read(): TelemetryChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'granted' || stored === 'declined' ? stored : 'unset'
  } catch {
    // Private browsing, or storage disabled. Not having a stored answer is
    // the same as not having been asked -- and since the default is to
    // send nothing, failing to read costs privacy nothing.
    return 'unset'
  }
}

export function telemetryChoice(): TelemetryChoice {
  return choice.value
}

export function setTelemetryChoice(next: TelemetryChoice): void {
  choice.value = next
  try {
    if (next === 'unset') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // A choice that cannot be persisted still holds for this session. It
    // will be asked again next launch, which is the safe direction to fail.
  }
}

export const telemetryConsented = (): boolean => choice.value === 'granted'

/**
 * Whether to put the question on screen.
 *
 * Only when there is something to consent TO. With no endpoint configured
 * nothing can be sent whatever the answer, so asking would be theatre --
 * and worse, it would imply the app collects something when it does not.
 */
export function shouldAskForTelemetry(endpoint: string = TELEMETRY_ENDPOINT): boolean {
  return telemetryConfigured(endpoint) && choice.value === 'unset'
}

/** Reactive, for a settings panel that reflects the current state. */
export const telemetryState = computed(() => ({
  configured: telemetryConfigured(),
  choice: choice.value,
  sending: telemetryConfigured() && choice.value === 'granted',
}))

/**
 * The feature names this app is allowed to count.
 *
 * A closed set, in the file, rather than a string invented at each call
 * site. The point of naming them here is that the whole list of what is
 * collected can be read in one place -- by a contributor, and by the
 * consent dialog, which shows exactly this list rather than a description
 * of it.
 */
export const TRACKED = {
  'document:open': 'Opening a document',
  'export:pdf': 'Exporting a PDF',
  'export:image': 'Exporting pages as images',
  'pages:split': 'Splitting a document',
  'pages:merge': 'Merging documents',
  redact: 'Redacting text',
  sign: 'Adding a signature',
  protect: 'Adding a password',
  compress: 'Making a file smaller',
  convert: 'Converting a file',
} as const

export type TrackedFeature = keyof typeof TRACKED

/**
 * Count one use of a feature. Never what it was used on.
 *
 * Typed to the closed set above, so a call site cannot invent a name --
 * and certainly cannot pass a filename, which would not compile.
 */
export function track(feature: TrackedFeature): void {
  reporter().countUsage(feature)
}

/**
 * Point the reporter at its endpoint, if there is one.
 *
 * Called once at startup. With nothing configured this constructs no
 * transport at all, so the default build has no code path that reaches the
 * network -- the absence is structural rather than a flag being checked.
 */
export function initTelemetry(endpoint: string = TELEMETRY_ENDPOINT): void {
  if (!telemetryConfigured(endpoint)) {
    configureReporter({ endpoint: '', consent: () => false })
    return
  }
  configureReporter({
    endpoint,
    consent: telemetryConsented,
    transport: httpTransport(endpoint),
  })
}
