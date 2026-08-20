# The renderer stopped for good after a zoom click

Reported as the page going blurry after pressing the zoom + or − button. The blur was the
0.2-scale placeholder tier, and it was permanent: nothing rendered again for the rest of the
session.

## Measured

Sampling the page canvas's backing-store width against its displayed CSS width — anything below the
device pixel ratio is a bitmap being stretched — every 50ms after a zoom click:

```
before        : { canvasWidth: 1440, cssWidth: 720, ratio: 2 }   sharp
after zoom out: 2×80                                             sharp, no re-render needed
after zoom in : 0.161×80                                         placeholder, and it never recovers
```

`0.161` is `PLACEHOLDER_SCALE / zoom` — the low-resolution tier, stretched.

## Root cause

```ts
pumping = (async () => {
  try {
    while (dirty) { ...plan and render... }
  } finally {
    pumping = undefined
  }
})()
```

An async function body runs **synchronously until its first await**. A drain with nothing to do
never awaits: it plans zero tasks, the loop exits, and the `finally` clears `pumping` — all before
the assignment on the first line has happened. The assignment then overwrites `undefined` with the
already-settled promise.

`pumping` was left permanently truthy, so every later `pump()` hit `if (pumping) return pumping` and
returned immediately. **Rendering was dead.**

The trigger is a drain with no work, which is exactly what happens when you zoom back to a scale
already in the cache — pressing − then + is the shortest path to it. Instrumented:

```
[PUMP] planned 0:                       ← the poisoning drain
[PUMP] called dirty=false pumping=true
[ZOOM] setZoom(1.25) changed=true
[PUMP] called dirty=true pumping=true   ← returns early, forever
```

**Fix:** the drain moved into its own function and the flag is cleared with `.finally()`. A
`.finally` callback is always queued as a microtask, so the assignment has completed before it runs.

## Why no test caught it

There were already two neighbouring tests: one that pumps twice with nothing to do, and one that
pumps, changes the zoom, and pumps again. Each used a **fresh store**, so the no-op drain and the
drain after it never met — the bug needed both in one session.

The new tests put them in sequence. One asserts a render actually happens after a no-op drain; the
other follows the reported gesture — zoom out, back in, then to a new scale — and asserts the
bitmap's **resolution**, because `bitmapFor` falls back to the placeholder and "defined" is true
even when nothing rendered. Against the previous code they report `expected 5 to be greater than 5`
and `expected 122 to be 1836`.
