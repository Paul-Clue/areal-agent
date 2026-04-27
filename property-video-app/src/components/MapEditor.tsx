'use client';

import { useState, useCallback } from 'react';
import MapGL from 'react-map-gl/mapbox';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import type { Map as MapboxMap } from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { generateBoundingBox } from '@/lib/boundary';
import { simpleSelectDragWholePolygon } from '@/lib/mapboxDrawSimpleSelectDrag';

const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
if (typeof window !== 'undefined' && !token) {
  console.warn('NEXT_PUBLIC_MAPBOX_TOKEN is not set; map preview will not load.');
}

type Property = {
  latitude: number;
  longitude: number;
  /** When boundary exists, prefer these for camera center (inside polygon). */
  frame_latitude?: number | null;
  frame_longitude?: number | null;
  boundary_geojson: object | null;
  valuation_number: string;
  nla_object_id?: number | null;
};

type Props = {
  property: Property;
  onBoundaryChange: (boundary: object) => void;
};

function toPolygon(geo: object | null, lat: number, lng: number): Polygon {
  if (!geo || typeof geo !== 'object' || !('type' in geo)) {
    return generateBoundingBox(lat, lng) as Polygon;
  }
  const g = geo as { type: string; coordinates?: number[][][] | number[][][][] };
  if (g.type === 'Polygon' && g.coordinates) {
    return { type: 'Polygon', coordinates: g.coordinates as Position[][] };
  }
  if (g.type === 'MultiPolygon' && (g as MultiPolygon).coordinates?.[0]) {
    return { type: 'Polygon', coordinates: (g as MultiPolygon).coordinates[0] as Position[][] };
  }
  return generateBoundingBox(lat, lng) as Polygon;
}

/**
 * Satellite preview and optional manual boundary edit (MapboxDraw polygon).
 * Requires NEXT_PUBLIC_MAPBOX_TOKEN.
 */
function mapCenter(p: Property): { latitude: number; longitude: number } {
  const lat = p.frame_latitude ?? p.latitude;
  const lng = p.frame_longitude ?? p.longitude;
  return { latitude: lat, longitude: lng };
}

/** Default Draw styles hide vertex handles in `simple_select`; show them so corners stay editable after we allow body-drag without auto `direct_select`. */
function themeWithVerticesInSimpleSelect() {
  return MapboxDraw.lib.theme.map((layer) => {
    const f = layer.filter;
    if (!Array.isArray(f)) return layer;
    const next = f.filter(
      (clause) =>
        !(
          Array.isArray(clause) &&
          clause.length >= 3 &&
          clause[0] === '!=' &&
          clause[1] === 'mode' &&
          clause[2] === 'simple_select'
        )
    );
    if (next.length === f.length) return layer;
    return { ...layer, filter: next };
  });
}

export default function MapEditor({ property, onBoundaryChange }: Props) {
  const [warn, setWarn] = useState<string | null>(null);
  const center = mapCenter(property);

  const handleLoad = useCallback(
    (ev: { target: MapboxMap }) => {
      const map = ev.target;
      setWarn(null);

      const draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: { polygon: true, trash: true },
        styles: themeWithVerticesInSimpleSelect(),
        modes: {
          ...MapboxDraw.modes,
          simple_select: simpleSelectDragWholePolygon,
        },
      });
      map.addControl(draw, 'top-left');

      const initial: Feature<Polygon> = {
        type: 'Feature',
        properties: {},
        geometry: toPolygon(property.boundary_geojson, property.latitude, property.longitude),
      };

      try {
        draw.add(initial);
      } catch {
        setWarn('Could not add boundary to the map. Using centroid box.');
        draw.add({
          type: 'Feature',
          properties: {},
          geometry: generateBoundingBox(property.latitude, property.longitude) as Polygon,
        });
      }

      if (draw.getAll().features[0]?.geometry) {
        onBoundaryChange(draw.getAll().features[0].geometry);
      }

      const sync = () => {
        const data = draw.getAll();
        if (data.features[0]?.geometry) {
          onBoundaryChange(data.features[0].geometry);
        }
      };
      map.on('draw.create', sync);
      map.on('draw.update', sync);
      map.on('draw.delete', sync);
    },
    [property.boundary_geojson, property.latitude, property.longitude, onBoundaryChange]
  );

  if (!token) {
    return (
      <p className="rounded border border-amber-200 bg-amber-50 p-3 text-amber-900">
        Set NEXT_PUBLIC_MAPBOX_TOKEN in .env.local to show the map preview.
      </p>
    );
  }

  return (
    <div className="w-full overflow-hidden rounded-lg border border-gray-200">
      {warn && <p className="m-0 bg-amber-50 p-2 text-sm text-amber-900">{warn}</p>}
      <p className="m-0 border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
        <strong className="text-zinc-800">Move:</strong> click the shaded parcel, then drag anywhere inside the
        blue shape. <strong className="text-zinc-800">Reshape:</strong> drag the white dots on the outline.
      </p>
      <MapGL
        key={`${property.valuation_number}-${String(property.nla_object_id ?? '')}`}
        onLoad={handleLoad}
        mapboxAccessToken={token}
        initialViewState={{
          longitude: center.longitude,
          latitude: center.latitude,
          zoom: 16,
        }}
        style={{ width: '100%', height: 500 }}
        mapStyle="mapbox://styles/mapbox/satellite-v9"
      />
    </div>
  );
}
