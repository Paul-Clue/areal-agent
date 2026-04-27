import type { ResolvedProperty } from '../../lib/property';
import { pool } from '../../lib/db';

/**
 * Chooses the frame pipeline. Jamaica has no Google 3D Tiles coverage; default Mapbox.
 * When `cesium_coverage` is null, persist false and use Mapbox (no headless probe in worker).
 */
export async function selectRenderer(
  property: Pick<ResolvedProperty, 'cesium_coverage' | 'valuation_number'>
): Promise<'mapbox'> {
  if (property.cesium_coverage == null) {
    await pool.query('UPDATE properties SET cesium_coverage = $1 WHERE valuation_number = $2', [
      false,
      property.valuation_number,
    ]);
  }
  return 'mapbox';
}
