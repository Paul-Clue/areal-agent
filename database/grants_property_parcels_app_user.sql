-- Run as admin after database/update_property_parcels_v1.sql (views exist).
-- Do not fold into app_user.template.sql until that template is applied only
-- after parcel tables exist, or GRANT will fail on fresh schema-only installs.

GRANT SELECT, INSERT, UPDATE, DELETE ON property_parcels TO app_user;

GRANT SELECT ON v_parcels_quality_summary  TO app_user;
GRANT SELECT ON v_multi_parcel_lv_numbers  TO app_user;
GRANT SELECT ON v_incomplete_parcels       TO app_user;
