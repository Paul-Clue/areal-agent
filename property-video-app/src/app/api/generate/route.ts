import { randomUUID } from 'node:crypto';
import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db';
import { getVideoQueue } from '@/lib/queue';

const requirePayment = process.env.REQUIRE_PAYMENT === 'true';

type AgentRow = {
  id: string;
  subscription_status: string;
  monthly_video_limit: number;
  videos_used: number;
  billing_cycle_start: Date;
};

async function resetIfNeeded(agent: AgentRow): Promise<AgentRow> {
  const start = new Date(agent.billing_cycle_start).getTime();
  const diffDays = (Date.now() - start) / (1000 * 60 * 60 * 24);
  if (diffDays >= 30) {
    await pool.query(
      'UPDATE agents SET videos_used = 0, billing_cycle_start = NOW() WHERE id = $1',
      [agent.id]
    );
    const r = await pool.query('SELECT * FROM agents WHERE id = $1', [agent.id]);
    return (r.rows[0] as AgentRow) || agent;
  }
  return agent;
}

/**
 * Enqueues a Mapbox+FFmpeg video job (BullMQ). Requires Redis and a running `npm run worker` process.
 * Payment is optional: set `REQUIRE_PAYMENT=true` when billing is live (Paddle, etc.).
 */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  let body: { valuationNumber?: string; nlaObjectId?: number | null; boundary?: object | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'INVALID_JSON' }, { status: 400 });
  }

  const { valuationNumber, nlaObjectId, boundary } = body;
  if (!valuationNumber || typeof valuationNumber !== 'string' || !valuationNumber.trim()) {
    return Response.json({ error: 'VALIDATION_ERROR' }, { status: 400 });
  }

  const agentRes = await pool.query('SELECT * FROM agents WHERE clerk_user_id = $1', [userId]);
  const a = agentRes.rows[0] as AgentRow | undefined;
  if (!a) {
    return Response.json({ error: 'AGENT_NOT_FOUND' }, { status: 404 });
  }

  const agent = await resetIfNeeded(a);

  if (requirePayment && agent.subscription_status !== 'active') {
    return Response.json({ error: 'SUBSCRIPTION_REQUIRED' }, { status: 403 });
  }

  if (agent.monthly_video_limit !== -1 && agent.videos_used >= agent.monthly_video_limit) {
    return Response.json({ error: 'LIMIT_REACHED' }, { status: 403 });
  }

  const jobId = randomUUID();
  const val = valuationNumber.trim();

  try {
    await pool.query(
      `INSERT INTO jobs (id, agent_id, valuation_number, status) VALUES ($1, $2, $3, 'queued')`,
      [jobId, agent.id, val]
    );
    await pool.query('UPDATE agents SET videos_used = videos_used + 1 WHERE id = $1', [agent.id]);
    await getVideoQueue().add(
      'generate-video',
      {
        agentId: agent.id,
        valuationNumber: val,
        nlaObjectId: nlaObjectId ?? null,
        customBoundary: boundary ?? null,
      },
      { jobId }
    );
  } catch (e) {
    await pool.query('DELETE FROM jobs WHERE id = $1', [jobId]).catch(() => undefined);
    await pool
      .query('UPDATE agents SET videos_used = GREATEST(videos_used - 1, 0) WHERE id = $1', [agent.id])
      .catch(() => undefined);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes('econnrefused') || msg.includes('connect')) {
      return Response.json(
        { error: 'QUEUE_UNAVAILABLE', message: 'Redis is not running or not reachable. Start Redis and npm run worker.' },
        { status: 503 }
      );
    }
    throw e;
  }

  return Response.json({ jobId });
}
