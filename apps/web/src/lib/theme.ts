import { ref, computed, watchEffect, type Ref, type ComputedRef } from 'vue'

export const THEME_STORAGE_KEY = 'margin.theme'

export type ThemeChoice = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system']

export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (choice === 'system') return systemPrefersDark ? 'dark' : 'light'
  return choice
}

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    return CHOICES.includes(v as ThemeChoice) ? (v as ThemeChoice) : 'system'
  } catch {
    return 'system'
  }
}

// Module-level singletons: theme is global state, and two components reading it
// must see the same value.
const choice = ref<ThemeChoice>(readStored())
const systemPrefersDark = ref(false)
let initialized = false

function initSystemWatch(): void {
  if (initialized) return
  initialized = true
  const mq = matchMedia('(prefers-color-scheme: dark)')
  systemPrefersDark.value = mq.matches
  mq.addEventListener('change', (e) => { systemPrefersDark.value = e.matches })
}

export function useTheme(): {
  choice: Ref<ThemeChoice>
  resolved: ComputedRef<ResolvedTheme>
  setChoice: (c: ThemeChoice) => void
  cycle: () => void
} {
  initSystemWatch()
  const resolved = computed(() => resolveTheme(choice.value, systemPrefersDark.value))

  watchEffect(() => {
    document.documentElement.dataset.theme = resolved.value
  })

  function setChoice(c: ThemeChoice): void {
    choice.value = c
    try { localStorage.setItem(THEME_STORAGE_KEY, c) } catch { /* private mode */ }
  }

  function cycle(): void {
    const i = CHOICES.indexOf(choice.value)
    setChoice(CHOICES[(i + 1) % CHOICES.length] ?? 'system')
  }

  return { choice, resolved, setChoice, cycle }
}
