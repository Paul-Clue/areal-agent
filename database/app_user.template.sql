-- Step 7B — Application role (run as admin, e.g. doadmin)
-- 1. Choose password per databasePlanv2.md Step 7B clarification (openssl / DO panel / etc.)
-- 2. Replace PASTE_GENERATED_PASSWORD_HERE below
-- 3. Run: psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -f app_user.template.sql
--
-- Connection: app uses PgBouncer port 25061; admin/ingestion use direct 25060 when on DO.

CREATE USER app_user WITH PASSWORD 'PASTE_GENERATED_PASSWORD_HERE';

GRANT USAGE ON SCHEMA public TO app_user;

GRANT SELECT, INSERT, UPDATE, DELETE ON properties TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON agents     TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs       TO app_user;

GRANT SELECT ON v_data_quality_summary TO app_user;
GRANT SELECT ON v_parish_summary       TO app_user;
GRANT SELECT ON refresh_log            TO app_user;

GRANT EXECUTE ON FUNCTION gen_random_uuid() TO app_user;

-- Ingestion loads use admin URL; app never uses superuser.
