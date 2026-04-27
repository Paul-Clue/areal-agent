import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { getCameraAtFrame } from './cameraPath';

const limit = pLimit(5);

function mapboxToken(): string {
  const t = process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!t) throw new Error('MAPBOX_TOKEN or NEXT_PUBLIC_MAPBOX_TOKEN is required for the worker');
  return t;
}

/**
 * Fetches one Mapbox Static API frame (raw, before boundary overlay) as PNG on disk.
 */
export async function fetchMapboxFrame(
  i: number,
  lat: number,
  lon: number,
  zoom: number,
  bearing: number,
  outputDir: string
) {
  const url =
    `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
    `${lon},${lat},${zoom.toFixed(4)},${bearing.toFixed(2)},0/` +
    `1280x720?access_token=${mapboxToken()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mapbox fetch failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const rawPath = path.join(outputDir, `frame_${String(i).padStart(4, '0')}.raw.png`);
  fs.writeFileSync(rawPath, buffer);
}

/**
 * Fetches all fly-through frames for a property. Writes `frame_####.raw.png` (overlay step produces `.png`).
 */
export async function generateMapboxFrames(
  property: { latitude: number; longitude: number; frame_latitude?: number | null; frame_longitude?: number | null },
  outputDir: string,
  totalFrames: number
) {
  const lat = property.frame_latitude ?? property.latitude;
  const lon = property.frame_longitude ?? property.longitude;
  if (lat == null || lon == null) {
    throw new Error('Property has no coordinates for map frames');
  }

  const tasks = Array.from({ length: totalFrames }, (_, i) => {
    const { zoom, bearing } = getCameraAtFrame(i, totalFrames);
    return limit(() => fetchMapboxFrame(i, lat, lon, zoom, bearing, outputDir));
  });
  await Promise.all(tasks);
}
