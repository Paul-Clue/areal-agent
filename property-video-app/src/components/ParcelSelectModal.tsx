'use client';

type Parcel = {
  nla_object_id: number;
  street_address: string | null;
  scheme_address: string | null;
  parish: string | null;
  location: string | null;
  has_boundary: boolean;
  is_incomplete: boolean;
  sibling_index: number;
};

type Props = {
  valuationNumber: string;
  parcels: Parcel[];
  onSelect: (nlaObjectId: number) => void;
  onClose: () => void;
};

function formatAddress(parcel: Parcel): string {
  if (parcel.street_address) return parcel.street_address;
  if (parcel.scheme_address) return parcel.scheme_address;
  if (parcel.location) return parcel.location;
  return 'No address available';
}

export default function ParcelSelectModal({
  valuationNumber,
  parcels,
  onSelect,
  onClose,
}: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby="parcel-modal-title"
    >
      <div className="max-h-[80vh] w-[90%] max-w-2xl overflow-y-auto rounded-lg bg-white p-8 shadow-lg">
        <h2 id="parcel-modal-title" className="mt-0 text-xl font-semibold text-gray-900">
          Multiple properties found
        </h2>
        <p className="text-gray-700">
          Valuation number <strong>{valuationNumber}</strong> is linked to multiple physical
          properties. Select the one you want to create a video for.
        </p>

        {parcels.map((parcel) => (
          <button
            key={parcel.nla_object_id}
            type="button"
            onClick={() => onSelect(parcel.nla_object_id)}
            className="mb-2 block w-full cursor-pointer rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-left text-sm transition hover:bg-gray-100"
          >
            <strong>{formatAddress(parcel)}</strong>
            {parcel.parish && <span className="text-gray-600"> — {parcel.parish}</span>}
            <br />
            <span className="text-xs text-gray-500">
              {parcel.has_boundary
                ? 'Boundary data available'
                : 'No boundary — approximate box will be used'}
              {parcel.is_incomplete && ' · Incomplete NLA record'}
            </span>
          </button>
        ))}

        <button
          type="button"
          onClick={onClose}
          className="mt-2 cursor-pointer border-0 bg-transparent text-gray-600 underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
