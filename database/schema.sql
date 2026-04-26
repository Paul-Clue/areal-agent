-- Phase 0 — Production schema (databasePlanv2.md Step 2)
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f schema.sql
-- Requires: PostgreSQL 15+ (per plan)

-- 2A — Extensions
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2B — properties
CREATE TABLE properties (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  nla_object_id     INTEGER      UNIQUE,
  valuation_number  TEXT         UNIQUE NOT NULL,
  folio_number      TEXT,

  street_address    TEXT,
  scheme_address    TEXT,
  parish            TEXT,
  location          TEXT,

  latitude          DOUBLE PRECISION,
  longitude         DOUBLE PRECISION,

  centroid          GEOGRAPHY(Point, 4326),
  boundary          GEOGRAPHY(Polygon, 4326),

  boundary_geojson  JSONB,

  cesium_coverage   BOOLEAN,

  has_coordinates   BOOLEAN      GENERATED ALWAYS AS
                    (latitude IS NOT NULL AND longitude IS NOT NULL) STORED,
  has_boundary      BOOLEAN      GENERATED ALWAYS AS
                    (boundary_geojson IS NOT NULL) STORED,

  data_source       TEXT         DEFAULT 'NLA_GIS_API',
  last_fetched_at   TIMESTAMP    WITH TIME ZONE DEFAULT NOW(),
  created_at        TIMESTAMP    WITH TIME ZONE DEFAULT NOW(),
  updated_at        TIMESTAMP    WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE  properties                    IS 'All Jamaica land parcels from NLA GIS API (eLand Jamaica).';
COMMENT ON COLUMN properties.valuation_number   IS 'LV_NUMBER from NLA. Primary agent lookup key.';
COMMENT ON COLUMN properties.folio_number       IS 'VOL_FOL from NLA. Alternative lookup (e.g. 1559/614).';
COMMENT ON COLUMN properties.cesium_coverage    IS 'NULL=unchecked, true=covered, false=not covered. Set by video worker.';

-- 2C — agents
CREATE TABLE agents (
  id                  UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id       TEXT  UNIQUE NOT NULL,
  name                TEXT,
  company             TEXT,
  brokerage           TEXT,
  phone               TEXT,
  email               TEXT,
  license_number      TEXT,
  logo_url            TEXT,
  headshot_url        TEXT,
  brand_color         TEXT  DEFAULT '#00FF00',
  tagline             TEXT,
  website             TEXT,
  subscription_status TEXT  DEFAULT 'inactive'
                      CHECK (subscription_status IN ('inactive','active','cancelled','past_due')),
  monthly_video_limit INT   DEFAULT 10
                      CHECK (monthly_video_limit = -1 OR monthly_video_limit >= 0),
  videos_used         INT   DEFAULT 0 CHECK (videos_used >= 0),
  billing_cycle_start TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE agents IS 'Registered real estate agents. Subscription status controls video generation access.';

-- 2D — jobs
CREATE TABLE jobs (
  id               TEXT  PRIMARY KEY,
  agent_id         UUID  NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  property_id      UUID  REFERENCES properties(id) ON DELETE SET NULL,
  valuation_number TEXT  NOT NULL,
  renderer         TEXT  CHECK (renderer IN ('mapbox','cesium')),
  status           TEXT  NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','processing','complete','failed')),
  output_url       TEXT,
  error_message    TEXT,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at     TIMESTAMP WITH TIME ZONE
);

COMMENT ON TABLE jobs IS 'Video generation jobs. output_url populated when status = complete.';

-- 2E — Indexes
CREATE INDEX idx_properties_valuation_number
  ON properties(valuation_number);

CREATE INDEX idx_properties_folio_number
  ON properties(folio_number)
  WHERE folio_number IS NOT NULL;

CREATE INDEX idx_properties_nla_object_id
  ON properties(nla_object_id)
  WHERE nla_object_id IS NOT NULL;

CREATE INDEX idx_properties_parish
  ON properties(parish)
  WHERE parish IS NOT NULL;

CREATE INDEX idx_properties_has_coordinates
  ON properties(has_coordinates);

CREATE INDEX idx_properties_has_boundary
  ON properties(has_boundary);

CREATE INDEX idx_properties_centroid_geo
  ON properties USING GIST(centroid)
  WHERE centroid IS NOT NULL;

CREATE INDEX idx_properties_boundary_geo
  ON properties USING GIST(boundary)
  WHERE boundary IS NOT NULL;

CREATE INDEX idx_properties_street_address_trgm
  ON properties USING GIN(street_address gin_trgm_ops)
  WHERE street_address IS NOT NULL;

CREATE INDEX idx_agents_clerk_user_id      ON agents(clerk_user_id);
CREATE INDEX idx_agents_subscription_status ON agents(subscription_status);

CREATE INDEX idx_jobs_agent_id         ON jobs(agent_id);
CREATE INDEX idx_jobs_status           ON jobs(status);
CREATE INDEX idx_jobs_valuation_number ON jobs(valuation_number);

-- 2F — Triggers (PostgreSQL 14+ syntax: EXECUTE FUNCTION)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 2G — Data quality view
CREATE OR REPLACE VIEW v_data_quality_summary AS
SELECT
  COUNT(*)                                        AS total_parcels,
  COUNT(*) FILTER (WHERE has_coordinates)         AS with_coordinates,
  COUNT(*) FILTER (WHERE has_boundary)            AS with_boundary_polygon,
  COUNT(*) FILTER (WHERE NOT has_coordinates)     AS missing_coordinates,
  COUNT(*) FILTER (WHERE has_coordinates
                   AND NOT has_boundary)          AS coords_only_no_boundary,
  COUNT(*) FILTER (WHERE parish IS NOT NULL)      AS with_parish,
  ROUND(
    COUNT(*) FILTER (WHERE has_coordinates)::NUMERIC
    / NULLIF(COUNT(*),0) * 100, 2
  )                                               AS pct_with_coordinates,
  ROUND(
    COUNT(*) FILTER (WHERE has_boundary)::NUMERIC
    / NULLIF(COUNT(*),0) * 100, 2
  )                                               AS pct_with_boundary
FROM properties;

COMMENT ON VIEW v_data_quality_summary IS
  'Run: SELECT * FROM v_data_quality_summary; to see dataset health.';

-- 2H — Parish summary view
CREATE OR REPLACE VIEW v_parish_summary AS
SELECT
  COALESCE(parish,'UNKNOWN')                      AS parish,
  COUNT(*)                                        AS total_parcels,
  COUNT(*) FILTER (WHERE has_boundary)            AS with_boundary,
  COUNT(*) FILTER (WHERE has_coordinates)         AS with_coordinates,
  ROUND(
    COUNT(*) FILTER (WHERE has_boundary)::NUMERIC
    / NULLIF(COUNT(*),0) * 100, 1
  )                                               AS pct_with_boundary
FROM properties
GROUP BY parish
ORDER BY total_parcels DESC;

COMMENT ON VIEW v_parish_summary IS
  'Run: SELECT * FROM v_parish_summary; to see coverage by parish.';

-- 2I — refresh_log
CREATE TABLE refresh_log (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at       TIMESTAMP WITH TIME ZONE NOT NULL,
  completed_at     TIMESTAMP WITH TIME ZONE,
  records_fetched  INTEGER,
  records_inserted INTEGER,
  records_updated  INTEGER,
  records_skipped  INTEGER,
  notes            TEXT
);

COMMENT ON TABLE refresh_log IS
  'Log of every full data refresh from the NLA GIS API.';
