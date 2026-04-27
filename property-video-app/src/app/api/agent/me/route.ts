import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db';

/** Current agent row (branding, limits, no secrets). */
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  const r = await pool.query(
    'SELECT * FROM agents WHERE clerk_user_id = $1',
    [userId]
  );
  if (r.rows.length === 0) {
    return Response.json({ error: 'AGENT_NOT_FOUND' }, { status: 404 });
  }
  return Response.json(r.rows[0]);
}
