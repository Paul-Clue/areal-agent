// Copy into Next.js app: /app/api/parcel/[nlaObjectId]/route.ts (docs/databaseUpdate.md Step 8C)

import { getParcelById } from '@/lib/property';
import { auth } from '@clerk/nextjs/server';

export async function GET(
  req: Request,
  { params }: { params: { nlaObjectId: string } }
) {
  const { userId } = auth();
  if (!userId) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

  const parcel = await getParcelById(parseInt(params.nlaObjectId, 10));
  if (!parcel) return Response.json({ error: 'PARCEL_NOT_FOUND' }, { status: 404 });

  return Response.json({
    nla_object_id: parcel.nla_object_id,
    valuation_number: parcel.valuation_number,
    street_address: parcel.street_address,
    scheme_address: parcel.scheme_address,
    parish: parcel.parish,
    location: parcel.location,
    latitude: parcel.latitude,
    longitude: parcel.longitude,
    boundary_geojson: parcel.boundary_geojson,
    has_coordinates: parcel.has_coordinates,
    has_boundary: parcel.has_boundary,
    is_incomplete: parcel.is_incomplete,
  });
}
