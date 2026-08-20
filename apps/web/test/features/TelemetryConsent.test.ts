import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import TelemetryConsent from '@/features/settings/TelemetryConsent.vue'
// Statically imported, and that matters for the component cases below: the
// component bound to THIS module instance when it was imported. A
// `vi.resetModules()` + dynamic import hands the test a different instance
// with its own `choice` ref, so the component would be writing to one and
// the assertion reading the other.
import * as tele from '@/lib/telemetry/analytics'
import { Reporter } from '@/lib/telemetry/reporter'
import type { TelemetryEvent } from '@/lib/telemetry/types'

const ENDPOINT = 'https://telemetry.example'

/** Fresh module state per test: the choice is module-level and persisted. */
async function analytics() {
  vi.resetModules()
  localStorage.clear()
  return import('@/lib/telemetry/analytics')
}

beforeEach(() => {
  localStorage.clear()
  // Re-sync the statically imported instance: a preceding test may have
  // reset modules and left this one holding a stale choice.
  tele.setTelemetryChoice('unset')
})

afterEach(() => {
  localStorage.clear()
})

describe('the choice', () => {
  it('starts unset — which is not the same as declined', async () => {
    const a = await analytics()
    expect(a.telemetryChoice()).toBe('unset')
    expect(a.telemetryConsented()).toBe(false)
  })

  it('is remembered across a reload', async () => {
    const a = await analytics()
    a.setTelemetryChoice('granted')

    // A fresh module read, as a page load would do.
    vi.resetModules()
    const again = await import('@/lib/telemetry/analytics')
    expect(again.telemetryChoice()).toBe('granted')
    expect(again.telemetryConsented()).toBe(true)
  })

  /** Declining is remembered too, or the question becomes nagging. */
  it('remembers a decline', async () => {
    const a = await analytics()
    a.setTelemetryChoice('declined')

    vi.resetModules()
    const again = await import('@/lib/telemetry/analytics')
    expect(again.telemetryChoice()).toBe('declined')
    expect(again.telemetryConsented()).toBe(false)
  })

  it('survives storage being unavailable', async () => {
    const a = await analytics()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private browsing')
    })
    // The choice still holds for this session; it simply is not persisted.
    expect(() => a.setTelemetryChoice('granted')).not.toThrow()
    expect(a.telemetryConsented()).toBe(true)
    setItem.mockRestore()
  })
})

describe('when the question is asked at all', () => {
  /**
   * Asking with no endpoint configured would be theatre, and worse than
   * theatre: it would tell people the app collects something when it
   * cannot.
   */
  it('is not asked when nothing could be sent anyway', async () => {
    const a = await analytics()
    expect(a.shouldAskForTelemetry('')).toBe(false)
  })

  it('is asked once when an endpoint exists and nothing has been chosen', async () => {
    const a = await analytics()
    expect(a.shouldAskForTelemetry(ENDPOINT)).toBe(true)
    a.setTelemetryChoice('declined')
    expect(a.shouldAskForTelemetry(ENDPOINT)).toBe(false)
  })
})

describe('tracking', () => {
  function collector() {
    const sent: TelemetryEvent[][] = []
    return { sent, transport: async (e: TelemetryEvent[]) => void sent.push(e) }
  }

  it('sends nothing before a choice has been made', async () => {
    const a = await analytics()
    const c = collector()
    const reporter = new Reporter({
      endpoint: ENDPOINT,
      consent: a.telemetryConsented,
      transport: c.transport,
    })
    reporter.countUsage('export:pdf')
    await reporter.flush()
    expect(c.sent).toEqual([])
  })

  it('sends counts once consent is given, and stops when it is withdrawn', async () => {
    const a = await analytics()
    const c = collector()
    const reporter = new Reporter({
      endpoint: ENDPOINT,
      consent: a.telemetryConsented,
      transport: c.transport,
    })

    a.setTelemetryChoice('granted')
    reporter.countUsage('export:pdf')
    await reporter.flush()
    expect(c.sent[0]).toEqual([{ schema: 1, kind: 'usage', name: 'export:pdf', count: 1 }])

    a.setTelemetryChoice('declined')
    reporter.countUsage('export:pdf')
    await reporter.flush()
    expect(c.sent).toHaveLength(1)
  })

  /**
   * The tracked names are a closed set in the source, so a call site
   * cannot invent one -- and cannot pass a filename, which would not
   * compile. This asserts the runtime shape matches that intent.
   */
  it('counts only names from the declared set', async () => {
    const a = await analytics()
    for (const name of Object.keys(a.TRACKED)) {
      expect(name).toMatch(/^[a-z][a-z0-9]*(?::[a-z0-9]+)?$/)
    }
  })

  it('builds no transport at all when nothing is configured', async () => {
    const a = await analytics()
    a.setTelemetryChoice('granted')
    a.initTelemetry('')
    const { reporter } = await import('@/lib/telemetry/reporter')
    // Consent granted and still disabled: the endpoint is the other half.
    expect(reporter().enabled).toBe(false)
  })
})

describe('TelemetryConsent', () => {
  /**
   * The dialog lists what is collected by rendering the same constant the
   * code counts against. A prose description could drift from the truth;
   * this cannot.
   */
  it('lists exactly what would be counted, from the source of truth', () => {
    const w = mount(TelemetryConsent)
    const collected = w.get('[data-telemetry-collected]').text()
    for (const label of Object.values(tele.TRACKED)) {
      expect(collected, label).toContain(label)
    }
  })

  it('says plainly what is never collected', () => {
    const never = mount(TelemetryConsent).get('[data-telemetry-never]').text()
    expect(never).toMatch(/documents/i)
    expect(never).toMatch(/file names/i)
    expect(never).toMatch(/identify you/i)
  })

  it('records a yes only when yes is chosen', async () => {
    const w = mount(TelemetryConsent)
    await w.get('[data-telemetry-accept]').trigger('click')
    expect(tele.telemetryChoice()).toBe('granted')
    expect(w.emitted('close')).toBeTruthy()
  })

  it('records a no, and remembers it', async () => {
    const w = mount(TelemetryConsent)
    await w.get('[data-telemetry-decline]').trigger('click')
    expect(tele.telemetryChoice()).toBe('declined')
    expect(tele.shouldAskForTelemetry(ENDPOINT)).toBe(false)
  })

  /** Dismissing without answering must never be read as agreement. */
  it('treats a dismissal as no, not as unanswered', async () => {
    const w = mount(TelemetryConsent)
    await w.get('[data-telemetry-consent]').trigger('click')
    expect(tele.telemetryChoice()).toBe('declined')
  })

  /**
   * A dialog where "no" is harder to find than "yes" is a dark pattern
   * whatever the copy says, so neither button gets primary styling and
   * decline comes first.
   */
  it('does not weight the buttons toward saying yes', () => {
    const w = mount(TelemetryConsent)
    const accept = w.get('[data-telemetry-accept]')
    const decline = w.get('[data-telemetry-decline]')

    expect(decline.text()).toBeTruthy()
    expect(accept.classes().join(' ')).toBe(decline.classes().join(' '))
    // Decline is reachable first in the DOM, so it is reachable first by keyboard.
    expect(w.html().indexOf('data-telemetry-decline')).toBeLessThan(
      w.html().indexOf('data-telemetry-accept'),
    )
  })
})
