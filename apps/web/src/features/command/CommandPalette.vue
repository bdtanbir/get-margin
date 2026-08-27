<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useMagicKeys, whenever } from '@vueuse/core'
import { combosFor } from '@/features/help/shortcuts'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { usePaletteStore } from '@/stores/palette'
import { useCommands, filterCommands, type Command } from './commands'

const palette = usePaletteStore()
const open = computed(() => palette.open)
const query = ref('')
const highlighted = ref(0)
const surface = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)

const commands = useCommands()
const matches = computed(() =>
  filterCommands(commands.value.filter((c) => c.available()), query.value),
)

/** Grouped for display, preserving the ranked order within each group. */
const groups = computed(() => {
  const out = new Map<string, Command[]>()
  for (const command of matches.value) {
    const list = out.get(command.group)
    if (list) list.push(command)
    else out.set(command.group, [command])
  }
  return [...out.entries()]
})

const keys = useMagicKeys({
  passive: false,
  onEventFired(e) {
    // Claim Cmd/Ctrl+K before the browser's own search bar takes it.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') e.preventDefault()
  },
})

whenever(keys['Meta+k']!, () => toggle())
// From the shortcut list, so the help page and this binding cannot
// describe different keys.
for (const combo of combosFor('palette')) whenever(keys[combo]!, () => toggle())

function toggle(): void {
  palette.toggle()
}

function close(): void {
  palette.close()
}

/**
 * Reset and focus on the way OPEN, wherever the open came from.
 *
 * This used to sit inside `toggle()`, which was fine while the keyboard was
 * the only way in. Now the top bar opens it too, and a palette opened by
 * pointer would otherwise come up carrying the previous query with nothing
 * focused.
 */
watch(open, (isOpen) => {
  if (!isOpen) return
  query.value = ''
  highlighted.value = 0
  void nextTick(() => input.value?.focus())
})

// A filtered list can be shorter than the highlight; without this, Enter
// after typing runs nothing at all.
watch(matches, (list) => {
  if (highlighted.value >= list.length) highlighted.value = 0
})

function move(delta: number): void {
  const n = matches.value.length
  if (n === 0) return
  highlighted.value = (highlighted.value + delta + n) % n
}

function runHighlighted(): void {
  const command = matches.value[highlighted.value]
  if (!command) return
  // Close FIRST: several commands open a surface of their own, and closing
  // afterwards would steal the focus that surface just took.
  close()
  command.run()
}

useFocusTrap(surface, { onEscape: close })
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
    role="dialog"
    aria-modal="true"
    aria-label="Commands"
    data-command-palette
    @click.self="close"
  >
    <div
      ref="surface"
      tabindex="-1"
      class="flex w-full max-w-lg flex-col overflow-hidden rounded-panel border border-border
             bg-surface shadow-high"
    >
      <input
        ref="input"
        v-model="query"
        data-command-input
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="command-list"
        aria-label="Search commands"
        placeholder="Search commands…"
        class="min-h-12 border-b border-border bg-transparent px-4 text-[14px] outline-none"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="runHighlighted"
      />

      <ul id="command-list" role="listbox" class="max-h-80 overflow-y-auto py-1">
        <template v-for="[group, items] in groups" :key="group">
          <li class="px-4 pb-1 pt-2 text-[11px] uppercase tracking-wide text-text-subtle">
            {{ group }}
          </li>
          <li
            v-for="command in items"
            :key="command.id"
            role="option"
            :data-command="command.id"
            :aria-selected="matches[highlighted]?.id === command.id"
            class="cursor-pointer px-4 py-2 text-[13px]"
            :class="matches[highlighted]?.id === command.id ? 'bg-accent text-accent-fg' : 'text-text'"
            @click="() => { close(); command.run() }"
            @mousemove="highlighted = matches.indexOf(command)"
          >{{ command.label }}</li>
        </template>
        <li v-if="matches.length === 0" class="px-4 py-6 text-center text-[13px] text-text-subtle">
          Nothing matches “{{ query }}”.
        </li>
      </ul>
    </div>
  </div>
</template>
