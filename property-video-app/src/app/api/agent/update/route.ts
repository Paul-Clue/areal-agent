import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db';
import { isSpacesConfigured } from '@/lib/storage';

function s3(): S3Client {
  return new S3Client({
    region: 'nyc3',
    endpoint: process.env.DO_SPACES_ENDPOINT || 'https://nyc3.digitaloceanspaces.com',
    credentials: {
      accessKeyId: process.env.DO_SPACES_KEY!,
      secretAccessKey: process.env.DO_SPACES_SECRET!,
    },
  });
}

async function saveUploadToSpaces(
  file: File,
  agentId: string,
  kind: 'logo' | 'headshot'
): Promise<string> {
  const bucket = process.env.DO_SPACES_BUCKET!;
  const ext = (file.name?.split('.').pop() || 'png').toLowerCase();
  const key = `agents/${agentId}/${kind}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  const client = s3();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buf,
      ACL: 'public-read',
      ContentType: file.type || 'image/png',
    })
  );
  return `https://${bucket}.nyc3.digitaloceanspaces.com/${key}`;
}

async function saveUploadLocal(
  file: File,
  agentId: string,
  kind: 'logo' | 'headshot'
): Promise<string> {
  const ext = (file.name?.split('.').pop() || 'png').toLowerCase();
  const dir = path.join(process.cwd(), '.data', 'agent-assets', agentId);
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, `${kind}.${ext}`);
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(p, buf);
  return `file://${p}`;
}

/**
 * Updates agent profile. Use `multipart/form-data` to upload `logo` / `headshot` files, or `application/json` for text only.
 */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  const a = await pool.query('SELECT id FROM agents WHERE clerk_user_id = $1', [userId]);
  if (a.rows.length === 0) {
    return Response.json({ error: 'AGENT_NOT_FOUND' }, { status: 404 });
  }
  const agentId = (a.rows[0] as { id: string }).id;

  const ct = req.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    const form = await req.formData();
    const pick = (k: string) => {
      const v = form.get(k);
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
      return null;
    };

    const name = pick('name');
    const company = pick('company');
    const brokerage = pick('brokerage');
    const phone = pick('phone');
    const email = pick('email');
    const license_number = pick('license_number');
    const tagline = pick('tagline');
    const website = pick('website');
    const brand_color = pick('brand_color') || '#00FF00';

    const logo = form.get('logo');
    const headshot = form.get('headshot');

    let logoUrl: string | null = null;
    let headshotUrl: string | null = null;

    if (logo instanceof File && logo.size > 0) {
      logoUrl = isSpacesConfigured()
        ? await saveUploadToSpaces(logo, agentId, 'logo')
        : await saveUploadLocal(logo, agentId, 'logo');
    }
    if (headshot instanceof File && headshot.size > 0) {
      headshotUrl = isSpacesConfigured()
        ? await saveUploadToSpaces(headshot, agentId, 'headshot')
        : await saveUploadLocal(headshot, agentId, 'headshot');
    }

    await pool.query(
      `UPDATE agents SET
         name = COALESCE($1, name),
         company = COALESCE($2, company),
         brokerage = COALESCE($3, brokerage),
         phone = COALESCE($4, phone),
         email = COALESCE($5, email),
         license_number = COALESCE($6, license_number),
         tagline = COALESCE($7, tagline),
         website = COALESCE($8, website),
         brand_color = $9,
         logo_url = COALESCE($10, logo_url),
         headshot_url = COALESCE($11, headshot_url)
       WHERE id = $12`,
      [
        name,
        company,
        brokerage,
        phone,
        email,
        license_number,
        tagline,
        website,
        brand_color,
        logoUrl,
        headshotUrl,
        agentId,
      ]
    );
  } else {
    const b = (await req.json()) as Record<string, string | undefined>;
    await pool.query(
      `UPDATE agents SET
         name = COALESCE($1, name),
         company = COALESCE($2, company),
         brokerage = COALESCE($3, brokerage),
         phone = COALESCE($4, phone),
         email = COALESCE($5, email),
         license_number = COALESCE($6, license_number),
         tagline = COALESCE($7, tagline),
         website = COALESCE($8, website),
         brand_color = COALESCE($9, brand_color)
       WHERE id = $10`,
      [
        b.name ?? null,
        b.company ?? null,
        b.brokerage ?? null,
        b.phone ?? null,
        b.email ?? null,
        b.license_number ?? null,
        b.tagline ?? null,
        b.website ?? null,
        b.brand_color ?? null,
        agentId,
      ]
    );
  }

  return Response.json({ ok: true });
}
