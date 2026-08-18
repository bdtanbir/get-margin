// `pixelmatch` ships no type declarations and no `@types/pixelmatch` package
// exists as an available devDependency for this task (only `@types/pngjs`
// was provided). This is a minimal ambient declaration of the shape actually
// used by golden.ts — not a new dependency, just documenting an existing
// untyped module so `tsc --noEmit` (noImplicitAny) is satisfied.
declare module 'pixelmatch' {
  export interface PixelmatchOptions {
    threshold?: number
    includeAA?: boolean
    alpha?: number
    aaColor?: [number, number, number]
    diffColor?: [number, number, number]
    diffColorAlt?: [number, number, number]
    diffMask?: boolean
  }

  export default function pixelmatch(
    img1: Uint8Array | Uint8ClampedArray,
    img2: Uint8Array | Uint8ClampedArray,
    output: Uint8Array | Uint8ClampedArray | null,
    width: number,
    height: number,
    options?: PixelmatchOptions,
  ): number
}
