-- Phase 0 — Database Update v1 (docs/databaseUpdate.md Steps 1–4)
-- Apply after schema.sql on a database that already has `properties` populated.
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/update_property_parcels_v1.sql
--
-- Note: `property_parcels.valuation_number` is nullable so FK ON DELETE SET NULL is valid in PostgreSQL.

-- =============================================================================
-- STEP 1 — Add columns to properties
-- =============================================================================

ALTER TABLE properties
ADD COLUMN IF NOT EXISTS has_multiple_parcels BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN properties.has_multiple_parcels IS
  'TRUE if this valuation number has more than one physical parcel '
  'in the property_parcels table. Set by the ingestion pipeline. '
  'When TRUE, the application presents a disambiguation modal to the agent.';

ALTER TABLE properties
ADD COLUMN IF NOT EXISTS canonical_selection_method TEXT;

COMMENT ON COLUMN properties.canonical_selection_method IS
  'How the canonical parcel was chosen when multiple parcels share this '
  'valuation number. Values: most_complete_address, largest_boundary, '
  'first_fetched, only_parcel. NULL for records ingested before this '
  'column existed.';

-- =============================================================================
-- STEP 2 — property_parcels table
-- =============================================================================

CREATE TABLE IF NOT EXISTS property_parcels (
  nla_object_id       INTEGER       PRIMARY KEY,

  valuation_number    TEXT
                      REFERENCES properties(valuation_number)
                      ON DELETE SET NULL
                      ON UPDATE CASCADE,

  folio_number        TEXT,

  street_address      TEXT,
  scheme_address      TEXT,
  parish              TEXT,
  location            TEXT,

  latitude            DOUBLE PRECISION,
  longitude           DOUBLE PRECISION,

  centroid            GEOGRAPHY(Point, 4326),
  boundary            GEOGRAPHY(Polygon, 4326),

  boundary_geojson    JSONB,

  has_coordinates     BOOLEAN       GENERATED ALWAYS AS
                      (latitude IS NOT NULL AND longitude IS NOT NULL) STORED,
  has_boundary        BOOLEAN       GENERATED ALWAYS AS
                      (boundary_geojson IS NOT NULL) STORED,

  is_incomplete       BOOLEAN       NOT NULL DEFAULT FALSE,

  incomplete_reason   TEXT,

  sibling_index       INTEGER,

  data_source         TEXT          DEFAULT 'NLA_GIS_API',
  last_fetched_at     TIMESTAMP     WITH TIME ZONE DEFAULT NOW(),
  created_at          TIMESTAMP     WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP     WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE property_parcels IS
  'Every individual NLA GIS feature, one row per nla_object_id. '
  'Stores the one-to-many relationship between valuation numbers '
  'and physical parcels. For single-parcel LV numbers, there is '
  'exactly one row here. For multi-parcel LV numbers, there is one '
  'row per parcel. The application uses this table to present a '
  'disambiguation modal when a valuation number matches multiple parcels.';

COMMENT ON COLUMN property_parcels.nla_object_id IS
  'NLA GIS OBJECTID. Globally unique across the entire NLA dataset. '
  'Used as the primary key for this table.';

COMMENT ON COLUMN property_parcels.valuation_number IS
  'Foreign key to properties.valuation_number. Multiple rows in this '
  'table can share the same valuation_number.';

COMMENT ON COLUMN property_parcels.is_incomplete IS
  'TRUE when the record has valid geometry but incomplete metadata. '
  'Triggers include: LV number ending in ---, null folio and parish, '
  'blank or whitespace-only address fields.';

COMMENT ON COLUMN property_parcels.sibling_index IS
  '1 = canonical parcel (data promoted to properties table). '
  '2+ = additional parcels shown in the disambiguation modal. '
  'NULL = not yet assigned.';

DROP TRIGGER IF EXISTS trg_property_parcels_updated_at ON property_parcels;
CREATE TRIGGER trg_property_parcels_updated_at
  BEFORE UPDATE ON property_parcels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- STEP 3 — Indexes
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_parcels_valuation_number
  ON property_parcels(valuation_number);

CREATE INDEX IF NOT EXISTS idx_parcels_nla_object_id
  ON property_parcels(nla_object_id);

CREATE INDEX IF NOT EXISTS idx_parcels_parish
  ON property_parcels(parish)
  WHERE parish IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_parcels_is_incomplete
  ON property_parcels(is_incomplete);

CREATE INDEX IF NOT EXISTS idx_parcels_has_coordinates
  ON property_parcels(has_coordinates);

CREATE INDEX IF NOT EXISTS idx_parcels_has_boundary
  ON property_parcels(has_boundary);

CREATE INDEX IF NOT EXISTS idx_parcels_centroid_geo
  ON property_parcels USING GIST(centroid)
  WHERE centroid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_parcels_boundary_geo
  ON property_parcels USING GIST(boundary)
  WHERE boundary IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_parcels_sibling_index
  ON property_parcels(valuation_number, sibling_index)
  WHERE sibling_index IS NOT NULL;

-- =============================================================================
-- STEP 4 — Views
-- =============================================================================

CREATE OR REPLACE VIEW v_parcels_quality_summary AS
SELECT
  COUNT(*)                                              AS total_parcels,
  COUNT(DISTINCT valuation_number)                      AS unique_lv_numbers,
  COUNT(*) FILTER (WHERE has_coordinates)               AS with_coordinates,
  COUNT(*) FILTER (WHERE has_boundary)                  AS with_boundary,
  COUNT(*) FILTER (WHERE is_incomplete)                 AS incomplete_records,
  COUNT(*) FILTER (WHERE sibling_index = 1)             AS canonical_parcels,
  COUNT(*) FILTER (WHERE sibling_index > 1)             AS additional_parcels,
  ROUND(
    COUNT(*) FILTER (WHERE is_incomplete)::NUMERIC
    / NULLIF(COUNT(*), 0) * 100, 2
  )                                                     AS pct_incomplete
FROM property_parcels;

COMMENT ON VIEW v_parcels_quality_summary IS
  'Run: SELECT * FROM v_parcels_quality_summary; for parcel dataset health.';

CREATE OR REPLACE VIEW v_multi_parcel_lv_numbers AS
SELECT
  valuation_number,
  COUNT(*)                                              AS parcel_count,
  COUNT(*) FILTER (WHERE is_incomplete)                 AS incomplete_count,
  COUNT(*) FILTER (WHERE has_boundary)                  AS with_boundary,
  MIN(parish) FILTER (WHERE parish IS NOT NULL)         AS parish,
  ARRAY_AGG(
    COALESCE(street_address, scheme_address, location, 'No address')
    ORDER BY sibling_index NULLS LAST
  )                                                     AS addresses
FROM property_parcels
GROUP BY valuation_number
HAVING COUNT(*) > 1
ORDER BY parcel_count DESC;

COMMENT ON VIEW v_multi_parcel_lv_numbers IS
  'All valuation numbers that have more than one parcel. '
  'Run: SELECT * FROM v_multi_parcel_lv_numbers LIMIT 20; to inspect.';

CREATE OR REPLACE VIEW v_incomplete_parcels AS
SELECT
  nla_object_id,
  valuation_number,
  folio_number,
  parish,
  street_address,
  scheme_address,
  incomplete_reason,
  has_coordinates,
  has_boundary
FROM property_parcels
WHERE is_incomplete = TRUE
ORDER BY valuation_number;

COMMENT ON VIEW v_incomplete_parcels IS
  'All parcels flagged as incomplete. '
  'Run: SELECT COUNT(*) FROM v_incomplete_parcels; to see total.';
