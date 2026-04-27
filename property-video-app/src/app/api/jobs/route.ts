import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db';

/** Recent jobs for the signed-in agent (dashboard). */
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  const r = await pool.query(
    `SELECT j.id, j.valuation_number, j.status, j.renderer, j.created_at, j.completed_at, j.error_message
     FROM jobs j
     JOIN agents a ON a.id = j.agent_id
     WHERE a.clerk_user_id = $1
     ORDER BY j.created_at DESC
     LIMIT 50`,
    [userId]
  );
  return Response.json({ jobs: r.rows });
}
