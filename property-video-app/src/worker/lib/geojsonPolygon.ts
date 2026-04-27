type PolygonInput = { coordinates: number[][][] };

/**
 * Coerces a GeoJSON-style geometry object into a single Polygon (first ring of MultiPolygon if needed).
 */
export function toPolygonInput(b: object): PolygonInput | null {
  if (!b || typeof b !== 'object') return null;
  const t = b as { type?: string; coordinates?: number[][][] | number[][][][] };
  if (t.type === 'Polygon' && t.coordinates?.[0]?.length) {
    return { coordinates: t.coordinates as number[][][] };
  }
  if (t.type === 'MultiPolygon' && t.coordinates?.[0]?.[0]?.length) {
    return { coordinates: t.coordinates[0] as number[][][] };
  }
  return null;
}
