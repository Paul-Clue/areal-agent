/** Resolve NLA boundary GeoJSON or fall back to a small bbox around the centroid. */
export function resolveBoundary(property: {
  boundary_geojson: object | null;
  latitude: number;
  longitude: number;
}): object {
  if (property.boundary_geojson) {
    return property.boundary_geojson;
  }
  return generateBoundingBox(property.latitude, property.longitude);
}

function metersToLat(meters: number): number {
  return meters / 111320;
}

function metersToLng(meters: number, lat: number): number {
  return meters / (111320 * Math.cos((lat * Math.PI) / 180));
}

export function generateBoundingBox(lat: number, lng: number, zoom: number = 17) {
  const size = zoom < 16 ? 60 : 40;
  const dLat = metersToLat(size);
  const dLng = metersToLng(size, lat);

  return {
    type: 'Polygon',
    coordinates: [
      [
        [lng - dLng, lat - dLat],
        [lng + dLng, lat - dLat],
        [lng + dLng, lat + dLat],
        [lng - dLng, lat + dLat],
        [lng - dLng, lat - dLat],
      ],
    ],
  };
}
