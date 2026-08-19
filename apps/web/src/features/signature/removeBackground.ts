/**
 * Luminance threshold -> alpha, so a phone photo of a signature on paper
 * does not paste an opaque white block over the page. Spec 2.1 is explicit
 * that without this the feature "feels broken".
 */
export const OPAQUE_BELOW = 120
export const TRANSPARENT_ABOVE = 235

/**
 * Mutates and returns `img`.
 *
 * A soft ramp between the two thresholds rather than a hard cut: hard
 * clipping leaves visibly jagged, aliased stroke edges, which is exactly
 * what makes a cut-out signature look pasted on.
 *
 * Pixels darker than OPAQUE_BELOW are left completely alone -- including
 * their existing alpha -- so running this over an already-transparent PNG
 * (the Draw tab's own output) is a no-op rather than a second erosion.
 */
export function removeBackground(img: ImageData): ImageData {
  const d = img.data
  const span = TRANSPARENT_ABOVE - OPAQUE_BELOW
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!
    if (lum >= TRANSPARENT_ABOVE) {
      d[i + 3] = 0
    } else if (lum > OPAQUE_BELOW) {
      d[i + 3] = Math.round(255 * (1 - (lum - OPAQUE_BELOW) / span))
    }
  }
  return img
}
