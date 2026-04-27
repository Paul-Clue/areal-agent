import fs from 'node:fs/promises';
import { SphericalMercator } from '@mapbox/sphericalmercator';
import sharp from 'sharp';
import { getCameraAtFrame } from './cameraPath';

const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;
const merc = new SphericalMercator({ size: 256 });

type PolygonInput = { coordinates: number[][][] };

/**
 * Mapbox Static Images are north-up; projects ring vertices to 1280x720 screen space.
 */
export function projectBoundaryFlat(
  boundary: PolygonInput,
  camera: { lon: number; lat: number; zoom: number }
): [number, number][] {
  const ring = boundary.coordinates[0];
  if (!ring?.length) return [];
  return ring.map(([lng, lat]) => {
    const [x, y] = merc.px([lng, lat], camera.zoom);
    const [cx, cy] = merc.px([camera.lon, camera.lat], camera.zoom);
    return [Math.round(x - cx + FRAME_WIDTH / 2), Math.round(y - cy + FRAME_HEIGHT / 2)] as [number, number];
  });
}

/**
 * Renders a green outline + light fill in screen space; skips invalid or tiny rings.
 */
export async function overlayPolygonOnPng(
  inputPng: Buffer,
  points: [number, number][],
  outPath: string
): Promise<void> {
  if (points.length < 3) {
    await sharp(inputPng).png().toFile(outPath);
    return;
  }
  const pts = points.map((p) => p.join(',')).join(' ');
  const svg = `<svg width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="blur"><feGaussianBlur stdDeviation="0" /></filter>
  </defs>
  <polygon points="${pts}" fill="rgba(0,200,100,0.28)" stroke="rgb(0,200,100)" stroke-width="3" />
</svg>`;
  const overlay = await sharp(Buffer.from(svg)).png().toBuffer();
  await sharp(inputPng)
    .composite([{ input: overlay, left: 0, top: 0 }])
    .png()
    .toFile(outPath);
}

/**
 * Composites boundary for each static frame when geometry is a Polygon.
 */
export async function overlayFramesWithBoundary(
  totalFrames: number,
  outputDir: string,
  center: { lat: number; lon: number },
  boundary: PolygonInput
): Promise<void> {
  for (let i = 0; i < totalFrames; i++) {
    const { zoom } = getCameraAtFrame(i, totalFrames);
    const camera = { lon: center.lon, lat: center.lat, zoom };
    const pixelPoints = projectBoundaryFlat(boundary, camera);
    const inFile = `${outputDir}/frame_${String(i).padStart(4, '0')}.raw.png`;
    const outFile = `${outputDir}/frame_${String(i).padStart(4, '0')}.png`;
    const buf = await sharp(inFile).png().toBuffer();
    try {
      await overlayPolygonOnPng(buf, pixelPoints, outFile);
    } catch {
      await fs.copyFile(inFile, outFile);
    } finally {
      await fs.unlink(inFile).catch(() => undefined);
    }
  }
}
