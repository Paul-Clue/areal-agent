-- Phase 0 — Database Update v1 Step 6 (docs/databaseUpdate.md)
-- Run after ingestParcels.js has populated property_parcels.
-- Canonical method below must match CANONICAL_METHOD in dataScraper/ingestParcels.js.

-- =============================================================================
-- STEP 6 — Populate has_multiple_parcels and canonical_selection_method
-- =============================================================================

UPDATE properties p
SET
  has_multiple_parcels        = TRUE,
  canonical_selection_method  = 'most_complete_address'
WHERE (
  SELECT COUNT(*)
  FROM property_parcels pp
  WHERE pp.valuation_number = p.valuation_number
) > 1;

UPDATE properties p
SET
  has_multiple_parcels       = FALSE,
  canonical_selection_method = 'only_parcel'
WHERE (
  SELECT COUNT(*)
  FROM property_parcels pp
  WHERE pp.valuation_number = p.valuation_number
) = 1;

SELECT
  has_multiple_parcels,
  COUNT(*) AS lv_count
FROM properties
GROUP BY has_multiple_parcels
ORDER BY has_multiple_parcels;
