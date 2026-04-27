import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  const { jobId } = await params;
  const r = await pool.query(
    `SELECT j.id, j.status, j.error_message, j.output_url, j.valuation_number, j.created_at, j.completed_at
     FROM jobs j
     JOIN agents a ON a.id = j.agent_id
     WHERE j.id = $1 AND a.clerk_user_id = $2`,
    [jobId, userId]
  );
  if (r.rows.length === 0) {
    return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  }
  const row = r.rows[0] as {
    id: string;
    status: string;
    error_message: string | null;
    output_url: string | null;
    valuation_number: string;
    created_at: Date;
    completed_at: Date | null;
  };
  return Response.json({
    status: row.status,
    error: row.error_message,
    outputUrl: row.output_url,
    valuationNumber: row.valuation_number,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}
