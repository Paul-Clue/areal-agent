-- docs/databaseUpdate.md Step 7 — verification queries

-- 7A
SELECT COUNT(*) AS total_parcels FROM property_parcels;

-- 7B
SELECT * FROM v_parcels_quality_summary;

-- 7C
SELECT valuation_number, parcel_count, parish, addresses
FROM v_multi_parcel_lv_numbers
LIMIT 10;

-- 7D
SELECT incomplete_reason, COUNT(*) AS count
FROM property_parcels
WHERE is_incomplete = TRUE
GROUP BY incomplete_reason
ORDER BY count DESC;

-- 7E — expect 0 rows
SELECT valuation_number, COUNT(*) FILTER (WHERE sibling_index = 1) AS canonical_count
FROM property_parcels
GROUP BY valuation_number
HAVING COUNT(*) FILTER (WHERE sibling_index = 1) <> 1
LIMIT 20;

-- 7F — expect inconsistent_rows = 0
SELECT COUNT(*) AS inconsistent_rows
FROM properties p
WHERE p.has_multiple_parcels = TRUE
  AND (
    SELECT COUNT(*) FROM property_parcels pp
    WHERE pp.valuation_number = p.valuation_number
  ) <= 1;

-- 7G — known multi-parcel example from dataset analysis
SELECT
  nla_object_id,
  valuation_number,
  sibling_index,
  street_address,
  scheme_address,
  parish,
  latitude,
  longitude,
  is_incomplete,
  incomplete_reason
FROM property_parcels
WHERE valuation_number = '031B6W02067'
ORDER BY sibling_index;

-- 7H
SELECT
  nla_object_id,
  valuation_number,
  folio_number,
  parish,
  street_address,
  incomplete_reason
FROM property_parcels
WHERE is_incomplete = TRUE
LIMIT 10;
