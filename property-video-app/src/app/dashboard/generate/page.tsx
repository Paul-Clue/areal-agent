'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import useSWR from 'swr';
import ParcelSelectModal from '@/components/ParcelSelectModal';

const MapEditor = dynamic(() => import('@/components/MapEditor'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[500px] items-center justify-center rounded-lg border border-zinc-200 bg-zinc-100 text-zinc-600">
      Loading map…
    </div>
  ),
});

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type LoadedProperty = {
  valuation_number: string;
  type?: string;
  street_address?: string | null;
  scheme_address?: string | null;
  parish?: string | null;
  boundary_geojson: object | null;
  latitude: number;
  longitude: number;
  frame_latitude?: number | null;
  frame_longitude?: number | null;
  has_boundary?: boolean;
  is_incomplete?: boolean;
  nla_object_id?: number;
};

export default function GeneratePage() {
  const [valuation, setValuation] = useState('');
  const [property, setProperty] = useState<LoadedProperty | null>(null);
  const [boundary, setBoundary] = useState<object | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [multiParcels, setMultiParcels] = useState<
    {
      nla_object_id: number;
      street_address: string | null;
      scheme_address: string | null;
      parish: string | null;
      location: string | null;
      has_boundary: boolean;
      is_incomplete: boolean;
      sibling_index: number;
      latitude: number | null;
      longitude: number | null;
    }[] | null
  >(null);
  const [showModal, setShowModal] = useState(false);
  const [valuationForModal, setValuationForModal] = useState('');
  const [selectedNlaId, setSelectedNlaId] = useState<number | null>(null);

  const { data: status } = useSWR(jobId ? `/api/status/${jobId}` : null, fetcher, {
    refreshInterval: 2000,
  });

  async function loadProperty() {
    setError('');
    setMultiParcels(null);
    setShowModal(false);
    setProperty(null);
    setSelectedNlaId(null);

    const res = await fetch(
      `/api/property/${encodeURIComponent(valuation.trim())}`
    );
    const data = await res.json();
    if (!res.ok) {
      setError(data.error === 'PROPERTY_NOT_FOUND' ? 'Property not found.' : data.error || 'Request failed.');
      return;
    }
    if (data.type === 'multiple') {
      setMultiParcels(data.parcels);
      setValuationForModal(data.valuation_number);
      setShowModal(true);
      return;
    }
    setProperty(data);
    setBoundary(data.boundary_geojson);
  }

  async function handleParcelSelect(nlaObjectId: number) {
    setShowModal(false);
    setSelectedNlaId(nlaObjectId);
    const res = await fetch(`/api/parcel/${nlaObjectId}`);
    const data = await res.json();
    if (!res.ok) {
      setError('Could not load parcel data.');
      return;
    }
    setProperty({ ...data, type: 'single' });
    setBoundary(data.boundary_geojson);
  }

  async function tryGenerate() {
    if (!property) return;
    setLoading(true);
    setError('');
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valuationNumber: property.valuation_number,
        nlaObjectId: selectedNlaId,
        boundary,
      }),
    });
    const data = (await res.json()) as { jobId?: string; error?: string; message?: string };
    if (!res.ok || data.error) {
      setError(
        data.message || data.error || (res.status === 503 ? 'Queue unavailable. Start Redis and the worker process.' : 'Generation failed')
      );
      setLoading(false);
      return;
    }
    if (data.jobId) {
      setJobId(data.jobId);
    }
    setLoading(false);
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-zinc-900">Generate</h1>
      <p className="text-zinc-600">
        Enter a valuation or folio number, then load the NLA record and review the map.
      </p>

      <div className="mt-6 flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="val" className="block text-sm font-medium text-zinc-700">
            Valuation or folio
          </label>
          <input
            id="val"
            value={valuation}
            onChange={(e) => setValuation(e.target.value)}
            placeholder="e.g. 031B6W02067 or 1559/614"
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-900"
          />
        </div>
        <button
          type="button"
          onClick={loadProperty}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
        >
          Load property
        </button>
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {property && property.type !== 'multiple' && (
        <>
          <p className="mt-6 text-zinc-800">
            <strong>
              {property.street_address || property.scheme_address || 'No address'}
            </strong>
            {property.parish && `, ${property.parish}`}
          </p>
          <p className="text-sm text-zinc-500">
            Adjust the boundary in the map if needed.
            {property.has_boundary
              ? ' Showing NLA boundary where available.'
              : ' Showing approximate box.'}
            {property.is_incomplete && ' Incomplete NLA record.'}
          </p>
          <div className="mt-4">
            <MapEditor property={property} onBoundaryChange={setBoundary} />
          </div>
          <button
            type="button"
            onClick={tryGenerate}
            disabled={loading || status?.status === 'processing'}
            className="mt-4 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading ? 'Submitting…' : 'Generate video'}
          </button>
        </>
      )}

      {status?.status === 'processing' && (
        <p className="mt-4 text-zinc-600">Generating — this can take several minutes (Mapbox + FFmpeg worker).</p>
      )}
      {status?.status === 'complete' && jobId && (
        <a
          href={`/api/download/${jobId}`}
          className="mt-4 inline-block text-emerald-700 underline"
          download
        >
          Download video
        </a>
      )}
      {status?.status === 'failed' && (
        <p className="mt-4 text-sm text-red-600">
          Generation failed. {(status as { error?: string | null })?.error || 'Check the worker log and try again.'}
        </p>
      )}

      {showModal && multiParcels && (
        <ParcelSelectModal
          valuationNumber={valuationForModal}
          parcels={multiParcels}
          onSelect={handleParcelSelect}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
