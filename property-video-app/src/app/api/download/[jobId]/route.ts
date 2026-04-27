import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db';
import { isLocalOutputUrl, localPathFromOutputUrl } from '@/lib/outputUrl';

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
    `SELECT j.output_url, j.status, a.clerk_user_id
     FROM jobs j
     JOIN agents a ON a.id = j.agent_id
     WHERE j.id = $1 AND a.clerk_user_id = $2 AND j.status = 'complete'`,
    [jobId, userId]
  );
  if (r.rows.length === 0) {
    return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  }
  const { output_url: outputUrl, status } = r.rows[0] as { output_url: string | null; status: string };
  if (status !== 'complete' || !outputUrl) {
    return Response.json({ error: 'NOT_READY' }, { status: 400 });
  }

  if (outputUrl.startsWith('http://') || outputUrl.startsWith('https://')) {
    return Response.redirect(outputUrl, 302);
  }

  if (isLocalOutputUrl(outputUrl)) {
    const p = localPathFromOutputUrl(outputUrl);
    if (!existsSync(p)) {
      return Response.json({ error: 'FILE_MISSING' }, { status: 404 });
    }
    const stream = createReadStream(p);
    return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="property-${jobId}.mp4"`,
      },
    });
  }

  return Response.json({ error: 'UNSUPPORTED_URL' }, { status: 500 });
}
