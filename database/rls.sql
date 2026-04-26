-- Step 7A — Row-Level Security (run after schema.sql, as admin)
-- Application must SET app.current_user_id for agent-scoped queries.

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agents_isolation_policy ON agents;

CREATE POLICY agents_isolation_policy ON agents
  USING (clerk_user_id = current_setting('app.current_user_id', true));
