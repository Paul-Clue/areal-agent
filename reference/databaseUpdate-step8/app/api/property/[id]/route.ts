// Copy into Next.js app: /app/api/property/[id]/route.ts (docs/databaseUpdate.md Step 8B)

import { lookupProperty } from '@/lib/property';
import { auth } from '@clerk/nextjs/server';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { userId } = auth();
  if (!userId) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

  const result = await lookupProperty(params.id);

  if (result.type === 'not_found') {
    return Response.json({ error: 'PROPERTY_NOT_FOUND' }, { status: 404 });
  }

  if (result.type === 'multiple') {
    return Response.json({
      type: 'multiple',
      valuation_number: result.valuation_number,
      parcels: result.parcels.map((p) => ({
        nla_object_id: p.nla_object_id,
        street_address: p.street_address,
        scheme_address: p.scheme_address,
        parish: p.parish,
        location: p.location,
        has_boundary: p.has_boundary,
        is_incomplete: p.is_incomplete,
        sibling_index: p.sibling_index,
        latitude: p.latitude,
        longitude: p.longitude,
      })),
    });
  }

  const p = result.property;
  return Response.json({
    type: 'single',
    valuation_number: p.valuation_number,
    folio_number: p.folio_number,
    street_address: p.street_address,
    scheme_address: p.scheme_address,
    parish: p.parish,
    location: p.location,
    latitude: p.latitude,
    longitude: p.longitude,
    boundary_geojson: p.boundary_geojson,
    has_coordinates: p.has_coordinates,
    has_boundary: p.has_boundary,
    is_incomplete: p.is_incomplete,
  });
}
