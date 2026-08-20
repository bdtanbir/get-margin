/**
 * jsdom's Blob/File implementation does not implement `arrayBuffer()`, even
 * though it's part of the standard File API that every real browser
 * supports. Vitest's jsdom environment installs jsdom's `File` as the
 * global (shadowing Node's own, which does have `arrayBuffer()`), so
 * `file.arrayBuffer()` — the spec-correct call the app code uses to read a
 * dropped/picked file — throws under test with a totally unrelated-looking
 * error ("file.arrayBuffer is not a function").
 *
 * Polyfill it via FileReader, which jsdom does implement correctly, rather
 * than working around a test-environment gap in production code.
 */
if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function arrayBuffer(): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
      reader.readAsArrayBuffer(this)
    })
  }
}

/**
 * Vitest's jsdom environment runs test code against jsdom's own ArrayBuffer
 * and Uint8Array constructors (a separate realm from Node's), but leaves
 * `crypto` pointing at Node's real, unmodified `crypto.subtle` — which
 * performs an internal brand check against Node's OWN ArrayBuffer. A buffer
 * built with the jsdom-realm's ArrayBuffer fails that check with an opaque
 * "2nd argument is not instance of ArrayBuffer" error, even though
 * `instanceof ArrayBuffer` returns true inside the test itself. Copy into a
 * genuine Node `Buffer` (never realm-swapped by vitest) before delegating,
 * rather than changing the production `sha256Hex` call site.
 */
if (typeof crypto !== 'undefined' && crypto.subtle) {
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle)
  crypto.subtle.digest = ((algorithm: AlgorithmIdentifier, data: BufferSource) => {
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)
    return nativeDigest(algorithm, Buffer.from(view))
  }) as typeof crypto.subtle.digest
}

/**
 * jsdom ships no `ImageData` constructor at all (Task 16). PageCanvas calls
 * `new ImageData(rgba, width, height)` to hand a rendered bitmap to
 * `putImageData`, and without this the test file wouldn't even load — every
 * PageCanvas test would fail before the component under test runs.
 *
 * Minimal but faithful: a test asserting `putImageData` was called with the
 * right pixels needs `.data`/`.width`/`.height` to hold the real values
 * that were passed in, not stand-ins.
 */
if (typeof globalThis.ImageData === 'undefined') {
  class ImageDataPolyfill {
    data: Uint8ClampedArray
    width: number
    height: number
    constructor(data: Uint8ClampedArray, width: number, height?: number) {
      this.data = data
      this.width = width
      this.height = height ?? data.length / 4 / width
    }
  }
  // @ts-expect-error -- minimal polyfill, not a full ImageData implementation
  globalThis.ImageData = ImageDataPolyfill
}

/**
 * jsdom's real `HTMLCanvasElement.getContext('2d')` throws "Not
 * implemented: ... (without installing the canvas npm package)" (Task 16)
 * — real browsers never throw here. Worse, jsdom emits that error to its
 * virtual console (which vitest forwards to stderr) as a side effect
 * *before* throwing, so wrapping the call in try/catch still leaves the
 * noise: the emission already happened by the time the catch runs.
 *
 * PageCanvas calls `getContext('2d')` from `onMounted`/`watchEffect` on
 * every mount, so every test that doesn't explicitly stub it would
 * otherwise print that jsdom error on every single mount. The only fix is
 * to never let jsdom's real implementation run at all: replace it outright
 * with a harmless stub. `vi.spyOn(HTMLCanvasElement.prototype,
 * 'getContext').mockReturnValue(...)` in the one PageCanvas test that
 * cares about paint behavior fully overrides this stub's body, so this has
 * no effect there.
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function (): unknown {
    return {
      putImageData() {},
      /**
       * jsdom implements no text metrics, and `lib/fonts.ts`'s
       * `measureText` uses a canvas to lay text out — so any component that
       * positions text by measuring it (TextObject, PatchEditor) throws
       * "ctx.measureText is not a function" the moment it renders.
       *
       * A crude proportional estimate rather than 0: returning 0 would make
       * every centred or right-aligned line land at the same place and let
       * a real positioning bug pass. This gives widths that scale with the
       * text and the size, which is enough for a component test to tell
       * "wider" from "narrower". Anything that depends on REAL metrics
       * belongs in an e2e test against a browser that has them.
       */
      measureText(this: { font?: string }, text: string) {
        const size = Number(/(\d+(?:\.\d+)?)px/.exec(String(this.font ?? ''))?.[1] ?? 16)
        return { width: text.length * size * 0.5 }
      },
      font: '',
    }
  } as typeof HTMLCanvasElement.prototype.getContext
}

/**
 * jsdom implements neither `URL.createObjectURL` nor `revokeObjectURL`.
 *
 * Any component that displays binary data it holds in memory — an image, a
 * signature — builds an object URL rather than a base64 data URL, because a
 * data URL is a third larger than the payload and gets re-encoded on every
 * re-render, which a drag does sixty times a second. Under test that throws
 * "URL.createObjectURL is not a function" the moment such a component
 * mounts.
 *
 * The counter makes each URL distinct, so a test asserting that a NEW url
 * was made for new data can tell them apart; returning one constant string
 * would make that assertion vacuous.
 */
if (typeof URL !== 'undefined' && typeof URL.createObjectURL !== 'function') {
  let n = 0
  URL.createObjectURL = () => `blob:margin-test/${++n}`
  URL.revokeObjectURL = () => {}
}

/**
 * jsdom implements no `window.matchMedia`. `lib/theme.ts` calls it once, at
 * module scope, to follow the OS's `prefers-color-scheme` — so ANY component
 * test that mounts TopBar (and therefore useTheme) dies with the
 * unhelpfully-generic "matchMedia is not a function" rather than anything
 * about themes.
 *
 * Reports "not dark" and accepts listeners that never fire, which is the
 * honest stand-in for a headless environment with no OS preference: a test
 * that wants to exercise theme switching stubs this itself.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

/**
 * Unmount every mounted component after each test.
 *
 * Vue Test Utils leaves wrappers mounted unless told otherwise, and a
 * surviving component keeps the store instance it resolved at setup. Once a
 * later test installs a fresh Pinia, the stale component still reacts to any
 * module-scope state it shares and still writes to the PREVIOUS test's
 * store — so a test can watch its own store sit untouched while the click it
 * just made lands somewhere else entirely.
 *
 * That is not hypothetical: it produced two green-in-isolation,
 * red-in-sequence failures in the page-grid suite, where the selection
 * composable's module-scope state let a dead component keep handling clicks.
 */
import { enableAutoUnmount } from '@vue/test-utils'
import { afterEach } from 'vitest'

enableAutoUnmount(afterEach)
