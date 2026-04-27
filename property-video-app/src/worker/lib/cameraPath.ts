/**
 * Cinematic map camera along the fly-through. Bearing is fixed at 0 so
 * flat Mercator boundary projection matches Mapbox Static Images (north-up).
 */
export function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - 2 ** (-10 * t);
}

export function getCameraAtFrame(i: number, totalFrames: number) {
  const t = i / Math.max(1, totalFrames - 1);
  const eased = easeOutExpo(t);
  return {
    zoom: 14 + (18 - 14) * eased,
    /** Kept 0 for consistent boundary reprojection to pixels. */
    bearing: 0,
  };
}
