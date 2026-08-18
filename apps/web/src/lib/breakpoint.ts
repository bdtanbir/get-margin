import { computed, type ComputedRef, type Ref } from 'vue'
import { useWindowSize } from '@vueuse/core'

/** Spec §6: ≥1024px gets the desktop shell (rail + panels). */
export const DESKTOP_MIN_PX = 1024

export function useShell(): { isDesktop: ComputedRef<boolean>; width: Ref<number> } {
  const { width } = useWindowSize()
  return { isDesktop: computed(() => width.value >= DESKTOP_MIN_PX), width }
}
