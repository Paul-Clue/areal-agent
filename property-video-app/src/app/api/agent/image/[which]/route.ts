import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db';

/**
 * Serves a logo or headshot for the current agent. Use when `logo_url` / `headshot_url` is a `file://` path; HTTPS URLs are redirected.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ which: string }> }
) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  const { which } = await params;
  if (which !== 'logo' && which !== 'headshot') {
    return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  const r = await pool.query(
    `SELECT logo_url, headshot_url FROM agents WHERE clerk_user_id = $1`,
    [userId]
  );
  if (r.rows.length === 0) {
    return Response.json({ error: 'AGENT_NOT_FOUND' }, { status: 404 });
  }
  const row = r.rows[0] as { logo_url: string | null; headshot_url: string | null };
  const u = which === 'logo' ? row.logo_url : row.headshot_url;
  if (!u) {
    return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  }
  if (u.startsWith('http://') || u.startsWith('https://')) {
    return Response.redirect(u, 302);
  }
  if (u.startsWith('file:')) {
    const p = fileURLToPath(u);
    if (!existsSync(p)) {
      return Response.json({ error: 'FILE_MISSING' }, { status: 404 });
    }
    const stream = createReadStream(p);
    return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
      headers: { 'Content-Type': 'image/png' },
    });
  }
  return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
}
