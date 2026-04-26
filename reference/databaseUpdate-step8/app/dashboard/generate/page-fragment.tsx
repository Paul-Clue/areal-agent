// Merge into /app/dashboard/generate/page.tsx per docs/databaseUpdate.md Step 8E.
// Adjust imports and state types to match your existing page.

import ParcelSelectModal from '@/components/ParcelSelectModal';

// Add to component state:
// const [multiParcels, setMultiParcels] = useState<...>(null);
// const [showModal, setShowModal] = useState(false);
// const [valuationForModal, setValuationForModal] = useState('');

/*
async function fetchProperty() {
  setError('');
  setMultiParcels(null);
  setShowModal(false);

  const res = await fetch(`/api/property/${valuation.trim()}`);
  const data = await res.json();

  if (!res.ok) {
    setError(data.error || 'Property not found.');
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
  const res = await fetch(`/api/parcel/${nlaObjectId}`);
  const data = await res.json();
  if (!res.ok) {
    setError('Could not load parcel data.');
    return;
  }
  setProperty(data);
  setBoundary(data.boundary_geojson);
}
*/

// In JSX:
/*
{showModal && multiParcels && (
  <ParcelSelectModal
    valuationNumber={valuationForModal}
    parcels={multiParcels}
    onSelect={handleParcelSelect}
    onClose={() => setShowModal(false)}
  />
)}
*/
