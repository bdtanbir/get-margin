<script setup lang="ts">
import { computed } from 'vue'
import type { SourceField, FieldValue } from '@margin/pdf-core'

const props = defineProps<{ field: SourceField; value: FieldValue | undefined; zoom: number }>()
const emit = defineEmits<{ input: [FieldValue] }>()

/**
 * What to show: the user's value if they have set one, otherwise whatever
 * the document shipped with.
 *
 * `undefined` and `''` are different answers. A user who clears a
 * pre-filled field has an empty string stored, and falling back to the
 * document's value there would put the text they just deleted straight
 * back on screen.
 */
const text = computed(() => {
  if (typeof props.value === 'string') return props.value
  if (Array.isArray(props.value)) return props.value[0] ?? ''
  return props.field.value
})

/**
 * Whether a button reads as selected.
 *
 * For a radio button this compares against the button's OWN export value,
 * never against the field's value: a radio kid's value is the GROUP's, so
 * every button in the group carries the selected option and rendering from
 * it shows all of them as chosen (findings 12 3). `state` is the button's
 * own /AS, which is the only honest answer.
 */
const checked = computed(() => {
  const own = props.field.exportValue
  if (typeof props.value === 'boolean') return props.value
  if (typeof props.value === 'string') {
    return props.field.type === 'radio' ? props.value === own : props.value !== 'Off' && props.value !== ''
  }
  return props.field.state !== null && props.field.state !== 'Off'
})

const fontSize = computed(() => `${Math.max(8, Math.min(props.field.rect.h * 0.6, 16)) * props.zoom}px`)

/**
 * Opaque, deliberately. The page beneath is already rendered WITH the
 * field's own appearance -- including any value the file shipped with -- so
 * a transparent control shows both at once, a pixel or two apart. That
 * reads as a rendering fault rather than as a form.
 */
const base = 'absolute box-border border border-accent/40 bg-surface text-text ' +
  'focus:outline-none focus:ring-2 focus:ring-accent/60 disabled:opacity-60'
</script>

<template>
  <!--
    Real platform controls, not painted boxes. Keyboard navigation, mobile
    keyboards, autofill, IME, and screen readers all work because these are
    the browser's own inputs; none of it would work against a canvas.
  -->
  <textarea
    v-if="field.type === 'text' && field.multiline"
    :data-field="field.key"
    :value="text"
    :disabled="field.readOnly"
    :required="field.required"
    :maxlength="field.maxLength ?? undefined"
    :aria-label="field.name || 'Form field'"
    :style="{ fontSize }"
    :class="[base, 'resize-none px-1 py-0.5 leading-tight']"
    @input="emit('input', ($event.target as HTMLTextAreaElement).value)"
  />

  <select
    v-else-if="field.type === 'dropdown' || field.type === 'listbox'"
    :data-field="field.key"
    :value="text"
    :disabled="field.readOnly"
    :required="field.required"
    :aria-label="field.name || 'Form field'"
    :style="{ fontSize }"
    :class="[base, 'px-1']"
    @change="emit('input', ($event.target as HTMLSelectElement).value)"
  >
    <!--
      An empty option, because a choice field that has never been answered
      has no value and the user must be able to return it to that state.
    -->
    <option value="" />
    <option v-for="o in field.options" :key="o" :value="o">{{ o }}</option>
  </select>

  <!--
    A radio button emits its own export value rather than `true`: the value
    stored is the GROUP's, naming which button is on. Emitting a boolean
    would make every button in the group claim the selection.
  -->
  <input
    v-else-if="field.type === 'radio'"
    type="radio"
    :data-field="field.key"
    :data-export-value="field.exportValue"
    :name="field.key"
    :checked="checked"
    :disabled="field.readOnly"
    :aria-label="field.name || 'Option'"
    :class="[base, 'appearance-none rounded-full checked:bg-accent']"
    @change="emit('input', field.exportValue ?? '')"
  />

  <input
    v-else-if="field.type === 'checkbox'"
    type="checkbox"
    :data-field="field.key"
    :checked="checked"
    :disabled="field.readOnly"
    :required="field.required"
    :aria-label="field.name || 'Checkbox'"
    :class="[base, 'appearance-none rounded-sm checked:bg-accent']"
    @change="emit('input', ($event.target as HTMLInputElement).checked)"
  />

  <!--
    A signature FIELD is a place for a signature, and this app does not
    sign. Shown as a labelled, non-interactive box rather than an input,
    because offering something to type into would imply it means something.
  -->
  <div
    v-else-if="field.type === 'signature'"
    :data-field="field.key"
    :class="[base, 'flex items-center justify-center border-dashed text-text-subtle']"
    :style="{ fontSize }"
  >Signature</div>

  <input
    v-else
    type="text"
    :data-field="field.key"
    :value="text"
    :disabled="field.readOnly"
    :required="field.required"
    :maxlength="field.maxLength ?? undefined"
    :aria-label="field.name || 'Form field'"
    :style="{ fontSize }"
    :class="[base, 'px-1']"
    @input="emit('input', ($event.target as HTMLInputElement).value)"
  />
</template>
