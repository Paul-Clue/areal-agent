import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db';

const requirePayment = process.env.REQUIRE_PAYMENT === 'true';

/**
 * Idempotent: ensure a row exists in `agents` for the signed-in Clerk user.
 * When `REQUIRE_PAYMENT` is not `true`, new signups are active with unlimited video quota
 * (billing handled later, e.g. Paddle).
 */
export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  if (requirePayment) {
    await pool.query(
      `INSERT INTO agents (id, clerk_user_id) VALUES (gen_random_uuid(), $1)
       ON CONFLICT (clerk_user_id) DO NOTHING`,
      [userId]
    );
  } else {
    await pool.query(
      `INSERT INTO agents (id, clerk_user_id, subscription_status, monthly_video_limit)
       VALUES (gen_random_uuid(), $1, 'active', -1)
       ON CONFLICT (clerk_user_id) DO UPDATE SET
         updated_at = NOW(),
         subscription_status = 'active',
         monthly_video_limit = -1`,
      [userId]
    );
  }
  return Response.json({ ok: true });
}
