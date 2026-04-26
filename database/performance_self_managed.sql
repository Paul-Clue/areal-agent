-- Step 7F — Self-managed Droplet tuning only (skip on DigitalOcean Managed)
-- After editing postgresql.conf paths, run and restart if required.

ALTER SYSTEM SET shared_buffers              = '512MB';
ALTER SYSTEM SET effective_cache_size        = '1536MB';
ALTER SYSTEM SET maintenance_work_mem        = '128MB';
ALTER SYSTEM SET checkpoint_completion_target = '0.9';
ALTER SYSTEM SET wal_buffers                 = '16MB';
ALTER SYSTEM SET default_statistics_target   = '100';
ALTER SYSTEM SET random_page_cost            = '1.1';
ALTER SYSTEM SET effective_io_concurrency    = '200';
SELECT pg_reload_conf();
