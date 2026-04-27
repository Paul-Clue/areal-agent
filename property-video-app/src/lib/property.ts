// Adapted from areal-agent/reference/databaseUpdate-step8 (docs/databaseUpdate.md Step 8A)

import { pool } from './db';

export type ResolvedProperty = {
  source: 'properties' | 'property_parcels';
  nla_object_id: number | null;
  valuation_number: string;
  folio_number: string | null;
  street_address: string | null;
  scheme_address: string | null;
  parish: string | null;
  location: string | null;
  latitude: number;
  longitude: number;
  /** Point inside the NLA polygon; use for map/video framing when set (avoids vertex-mean vs polygon mismatch). */
  frame_latitude: number | null;
  frame_longitude: number | null;
  boundary_geojson: object | null;
  has_coordinates: boolean;
  has_boundary: boolean;
  cesium_coverage: boolean | null;
  is_incomplete: boolean;
};

export type ParcelSummary = {
  nla_object_id: number;
  street_address: string | null;
  scheme_address: string | null;
  parish: string | null;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  has_boundary: boolean;
  is_incomplete: boolean;
  sibling_index: number;
};

export type LookupResult =
  | { type: 'single'; property: ResolvedProperty }
  | { type: 'multiple'; parcels: ParcelSummary[]; valuation_number: string }
  | { type: 'not_found' };

export async function lookupProperty(input: string): Promise<LookupResult> {
  const query = input.trim();

  const primaryResult = await pool.query(
    `SELECT
       valuation_number, folio_number,
       street_address, scheme_address, parish, location,
       latitude, longitude, boundary_geojson,
       (CASE WHEN boundary IS NOT NULL
         THEN ST_Y(ST_PointOnSurface(boundary::geometry)) END) AS frame_latitude,
       (CASE WHEN boundary IS NOT NULL
         THEN ST_X(ST_PointOnSurface(boundary::geometry)) END) AS frame_longitude,
       has_coordinates, has_boundary,
       cesium_coverage, has_multiple_parcels
     FROM properties
     WHERE valuation_number = $1 OR folio_number = $1
     LIMIT 1`,
    [query]
  );

  if (primaryResult.rows.length > 0) {
    const row = primaryResult.rows[0];

    if (row.has_multiple_parcels) {
      const parcelsResult = await pool.query(
        `SELECT
           nla_object_id, street_address, scheme_address,
           parish, location, latitude, longitude,
           has_boundary, is_incomplete, sibling_index
         FROM property_parcels
         WHERE valuation_number = $1
         ORDER BY sibling_index ASC NULLS LAST`,
        [row.valuation_number]
      );

      return {
        type: 'multiple',
        parcels: parcelsResult.rows,
        valuation_number: row.valuation_number,
      };
    }

    const { has_multiple_parcels: _hasMulti, ...rest } = row;
    void _hasMulti;
    return {
      type: 'single',
      property: {
        source: 'properties',
        nla_object_id: null,
        is_incomplete: false,
        cesium_coverage: row.cesium_coverage,
        ...rest,
      },
    };
  }

  const parcelResult = await pool.query(
    `SELECT
       nla_object_id, valuation_number, folio_number,
       street_address, scheme_address, parish, location,
       latitude, longitude, boundary_geojson,
       (CASE WHEN boundary IS NOT NULL
         THEN ST_Y(ST_PointOnSurface(boundary::geometry)) END) AS frame_latitude,
       (CASE WHEN boundary IS NOT NULL
         THEN ST_X(ST_PointOnSurface(boundary::geometry)) END) AS frame_longitude,
       has_coordinates, has_boundary,
       is_incomplete, sibling_index
     FROM property_parcels
     WHERE valuation_number = $1 OR folio_number = $1
     ORDER BY sibling_index ASC NULLS LAST`,
    [query]
  );

  if (parcelResult.rows.length === 0) {
    return { type: 'not_found' };
  }

  if (parcelResult.rows.length === 1) {
    const row = parcelResult.rows[0];
    return {
      type: 'single',
      property: {
        source: 'property_parcels',
        cesium_coverage: null,
        ...row,
      },
    };
  }

  return {
    type: 'multiple',
    parcels: parcelResult.rows,
    valuation_number: parcelResult.rows[0].valuation_number,
  };
}

export async function getParcelById(nlaObjectId: number): Promise<ResolvedProperty | null> {
  const res = await pool.query(
    `SELECT
       nla_object_id, valuation_number, folio_number,
       street_address, scheme_address, parish, location,
       latitude, longitude, boundary_geojson,
       (CASE WHEN boundary IS NOT NULL
         THEN ST_Y(ST_PointOnSurface(boundary::geometry)) END) AS frame_latitude,
       (CASE WHEN boundary IS NOT NULL
         THEN ST_X(ST_PointOnSurface(boundary::geometry)) END) AS frame_longitude,
       has_coordinates, has_boundary, is_incomplete
     FROM property_parcels
     WHERE nla_object_id = $1`,
    [nlaObjectId]
  );
  if (!res.rows[0]) return null;
  return {
    source: 'property_parcels',
    cesium_coverage: null,
    ...res.rows[0],
  };
}
