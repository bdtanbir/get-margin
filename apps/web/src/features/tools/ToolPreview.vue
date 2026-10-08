<script setup lang="ts">
import type { ToolId } from '@/stores/tools'

/**
 * A looping drawing of one tool being used, on a miniature page.
 *
 * Code, not video: nothing to download, sharp at any size, follows the
 * theme, and cannot fail to load. The trade is that it is an illustration
 * of the gesture rather than a recording of the real UI.
 *
 * Every animated element's BASE style is its finished state; the keyframes
 * only describe how it gets there. That is what makes reduced motion cheap
 * to honour -- turning the animation off leaves the finished picture, with
 * no second set of styles to keep in step.
 */
defineProps<{ tool: ToolId }>()
</script>

<template>
  <svg
    class="pv"
    viewBox="0 0 160 100"
    aria-hidden="true"
    focusable="false"
    :data-preview="tool"
  >
    <rect class="pv-sheet" x="6" y="6" width="148" height="88" rx="4" />
    <rect class="pv-line" x="18" y="18" width="70" height="5" rx="2.5" />
    <rect class="pv-line" x="18" y="30" width="112" height="5" rx="2.5" />
    <rect class="pv-line" x="18" y="42" width="96" height="5" rx="2.5" />
    <rect class="pv-line" x="18" y="54" width="104" height="5" rx="2.5" />

    <!-- Select: an object picked up and moved. -->
    <g v-if="tool === 'select'" class="pv-move">
      <rect class="pv-fill" x="22" y="66" width="38" height="18" rx="2" />
      <rect class="pv-outline" x="20" y="64" width="42" height="22" />
      <rect class="pv-handle" x="18" y="62" width="4" height="4" />
      <rect class="pv-handle" x="58" y="62" width="4" height="4" />
      <rect class="pv-handle" x="18" y="84" width="4" height="4" />
      <rect class="pv-handle" x="58" y="84" width="4" height="4" />
    </g>

    <!-- Text: a box appears, then the words arrive. -->
    <g v-else-if="tool === 'text'">
      <rect class="pv-outline pv-dash pv-grow" x="20" y="66" width="72" height="22" />
      <rect class="pv-ink-fill pv-wipe" x="26" y="71" width="58" height="4" rx="2" />
      <rect class="pv-ink-fill pv-wipe pv-late" x="26" y="79" width="40" height="4" rx="2" />
    </g>

    <g v-else-if="tool === 'image'" class="pv-pop">
      <rect class="pv-fill" x="22" y="64" width="46" height="26" rx="2" />
      <polygon class="pv-picture" points="26,86 38,72 46,80 54,70 64,86" />
      <circle class="pv-picture" cx="30" cy="71" r="3" />
    </g>

    <rect v-else-if="tool === 'rect'" class="pv-outline pv-grow" x="22" y="64" width="56" height="24" />

    <ellipse v-else-if="tool === 'ellipse'" class="pv-outline pv-grow" cx="50" cy="76" rx="28" ry="13" />

    <path v-else-if="tool === 'line'" class="pv-stroke pv-draw" pathLength="1" d="M22 86 L96 68" />

    <g v-else-if="tool === 'arrow'">
      <path class="pv-stroke pv-draw" pathLength="1" d="M22 84 L92 68" />
      <polygon class="pv-ink-fill pv-pop pv-late" points="98,66 88,62 90,73" />
    </g>

    <path
      v-else-if="tool === 'ink'"
      class="pv-stroke pv-draw"
      pathLength="1"
      d="M20 78 C28 62 36 90 46 74 S62 62 70 78 S88 88 100 70"
    />

    <!-- Whiteout: a block covers the second line. -->
    <rect v-else-if="tool === 'whiteout'" class="pv-cover pv-wipe" x="16" y="27" width="118" height="11" rx="1" />

    <g v-else-if="tool === 'link'">
      <rect class="pv-outline pv-dash pv-grow" x="18" y="40" width="60" height="11" />
      <rect class="pv-ink-fill pv-pop pv-late" x="82" y="43" width="36" height="5" rx="2.5" />
    </g>

    <g v-else-if="tool === 'signature'">
      <line class="pv-base" x1="22" y1="86" x2="104" y2="86" />
      <path
        class="pv-stroke pv-draw"
        pathLength="1"
        d="M26 80 C30 60 38 60 38 76 C38 86 46 70 52 70 C58 70 54 82 62 78 C70 74 76 66 84 76 C90 82 96 72 100 72"
      />
    </g>

    <rect v-else-if="tool === 'highlight'" class="pv-mark pv-wipe" x="16" y="28" width="118" height="9" rx="1" />

    <rect v-else-if="tool === 'underline'" class="pv-ink-fill pv-wipe" x="18" y="37" width="112" height="1.8" />

    <rect v-else-if="tool === 'strikeout'" class="pv-ink-fill pv-wipe" x="18" y="31.6" width="112" height="1.8" />

    <!-- Crop: everything outside the frame dims. -->
    <g v-else-if="tool === 'crop'">
      <path
        class="pv-dim pv-pop"
        fill-rule="evenodd"
        d="M6 6H154V94H6Z M30 18H120V70H30Z"
      />
      <rect class="pv-outline pv-grow" x="30" y="18" width="90" height="52" />
    </g>

    <g v-else-if="tool === 'field'">
      <rect class="pv-outline pv-grow" x="20" y="66" width="78" height="18" rx="2" />
      <rect class="pv-ink-fill pv-blink" x="26" y="70" width="1.6" height="10" />
    </g>

    <!-- Redact: a solid block over the third line. -->
    <rect v-else-if="tool === 'redact'" class="pv-solid pv-wipe" x="16" y="40" width="102" height="9" rx="1" />

    <!-- Edit text: the old line is covered and a new one is typed over it. -->
    <g v-else-if="tool === 'patch'">
      <rect class="pv-cover pv-wipe" x="16" y="27" width="118" height="11" rx="1" />
      <rect class="pv-ink-fill pv-wipe pv-late" x="18" y="30" width="86" height="5" rx="2.5" />
    </g>

    <g v-else-if="tool === 'editImage'">
      <rect class="pv-fill" x="22" y="64" width="46" height="26" rx="2" />
      <polygon class="pv-picture" points="26,86 38,72 46,80 54,70 64,86" />
      <rect class="pv-outline pv-dash pv-pop" x="20" y="62" width="50" height="30" />
      <g class="pv-move">
        <rect class="pv-outline pv-fade-out" x="20" y="62" width="50" height="30" />
      </g>
    </g>

    <g v-else-if="tool === 'lift'">
      <rect class="pv-outline pv-dash pv-grow" x="18" y="64" width="46" height="24" />
      <g class="pv-move">
        <rect class="pv-fill" x="22" y="68" width="38" height="16" rx="2" />
        <rect class="pv-ink-fill" x="27" y="74" width="26" height="4" rx="2" />
      </g>
    </g>
  </svg>
</template>

<style scoped>
.pv {
  display: block;
  width: 100%;
  height: auto;
}
.pv-sheet { fill: var(--color-surface); stroke: var(--color-border-strong); stroke-width: 1; }
.pv-line { fill: var(--color-border-strong); }
.pv-fill { fill: var(--color-accent-subtle); stroke: var(--color-accent); stroke-width: 1; }
.pv-picture { fill: var(--color-accent); fill-opacity: 0.55; }
.pv-outline { fill: none; stroke: var(--color-accent); stroke-width: 1.6; }
.pv-dash { stroke-dasharray: 4 3; }
.pv-handle { fill: var(--color-surface); stroke: var(--color-accent); stroke-width: 1; }
.pv-stroke { fill: none; stroke: var(--color-accent); stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 1; }
.pv-base { stroke: var(--color-border-strong); stroke-width: 1; }
.pv-ink-fill { fill: var(--color-accent); }
.pv-cover { fill: var(--color-surface); stroke: var(--color-border-strong); stroke-width: 1; }
.pv-solid { fill: var(--color-text); }
.pv-mark { fill: var(--color-warning); fill-opacity: 0.55; }
/* fill-opacity, not opacity: the keyframes own `opacity` and would overwrite it. */
.pv-dim { fill: var(--color-text); fill-opacity: 0.28; }

/* Scaling happens from each shape's own top-left corner. */
.pv-grow, .pv-wipe, .pv-pop, .pv-draw, .pv-move, .pv-blink, .pv-fade-out {
  transform-box: fill-box;
  transform-origin: 0 0;
  animation-duration: 3.6s;
  animation-iteration-count: infinite;
  animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1);
}
.pv-grow { animation-name: pv-grow; }
.pv-wipe { animation-name: pv-wipe; }
.pv-pop { animation-name: pv-pop; }
.pv-draw { animation-name: pv-draw; }
.pv-move { animation-name: pv-move; }
.pv-blink { animation-name: pv-blink; animation-timing-function: steps(1, end); animation-duration: 1.2s; }
.pv-fade-out { animation-name: pv-fade-out; }
/* A second beat in the same loop: starts later but ends with the first. */
.pv-late.pv-wipe { animation-name: pv-wipe-late; }
.pv-late.pv-pop { animation-name: pv-pop-late; }

@keyframes pv-grow {
  0%, 8% { transform: scale(0, 0); }
  45%, 88% { transform: scale(1, 1); opacity: 1; }
  100% { transform: scale(1, 1); opacity: 0; }
}
@keyframes pv-wipe {
  0%, 8% { transform: scaleX(0); }
  45%, 88% { transform: scaleX(1); opacity: 1; }
  100% { transform: scaleX(1); opacity: 0; }
}
@keyframes pv-wipe-late {
  0%, 35% { transform: scaleX(0); }
  65%, 88% { transform: scaleX(1); opacity: 1; }
  100% { transform: scaleX(1); opacity: 0; }
}
@keyframes pv-pop {
  0%, 12% { opacity: 0; }
  35%, 88% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes pv-pop-late {
  0%, 45% { opacity: 0; }
  60%, 88% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes pv-draw {
  0%, 8% { stroke-dashoffset: 1; opacity: 1; }
  50%, 88% { stroke-dashoffset: 0; opacity: 1; }
  100% { stroke-dashoffset: 0; opacity: 0; }
}
@keyframes pv-move {
  0%, 15% { transform: translate(0, 0); }
  55%, 88% { transform: translate(72px, -2px); opacity: 1; }
  100% { transform: translate(72px, -2px); opacity: 0; }
}
@keyframes pv-blink {
  0% { opacity: 1; }
  50% { opacity: 0; }
}
@keyframes pv-fade-out {
  0%, 40% { opacity: 1; }
  60%, 100% { opacity: 0; }
}

/*
  Reduced motion: stop, and show the finished picture. The app-wide rule
  only shortens durations, which on an infinite loop would strobe.
*/
@media (prefers-reduced-motion: reduce) {
  .pv-grow, .pv-wipe, .pv-pop, .pv-draw, .pv-move, .pv-blink, .pv-fade-out {
    animation: none !important;
  }
  .pv-stroke { stroke-dasharray: none; }
}
</style>
