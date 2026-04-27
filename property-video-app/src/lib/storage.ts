import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
const SPACES = 'https://nyc3.digitaloceanspaces.com';

/**
 * Returns public video URL, or `null` if DO Spaces is not configured.
 */
export function isSpacesConfigured(): boolean {
  return Boolean(
    process.env.DO_SPACES_KEY && process.env.DO_SPACES_SECRET && process.env.DO_SPACES_BUCKET
  );
}

function getClient() {
  return new S3Client({
    region: 'nyc3',
    endpoint: process.env.DO_SPACES_ENDPOINT || SPACES,
    credentials: {
      accessKeyId: process.env.DO_SPACES_KEY!,
      secretAccessKey: process.env.DO_SPACES_SECRET!,
    },
  });
}

/**
 * Uploads a finished MP4 to DO Spaces. Caller must have verified `isSpacesConfigured()`.
 */
export async function uploadVideoToSpaces(
  filePath: string,
  jobId: string
): Promise<string> {
  const bucket = process.env.DO_SPACES_BUCKET!;
  const key = `videos/${jobId}.mp4`;
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(filePath),
      ACL: 'public-read',
      ContentType: 'video/mp4',
    })
  );
  return `https://${bucket}.nyc3.digitaloceanspaces.com/${key}`;
}
