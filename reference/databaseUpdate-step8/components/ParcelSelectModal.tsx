// Copy into Next.js app: /components/ParcelSelectModal.tsx (docs/databaseUpdate.md Step 8D)

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
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: 'white',
          borderRadius: 8,
          padding: 32,
          maxWidth: 600,
          width: '90%',
          maxHeight: '80vh',
          overflowY: 'auto',
        }}
      >
        <h2 style={{ marginTop: 0 }}>Multiple properties found</h2>
        <p>
          Valuation number <strong>{valuationNumber}</strong> is linked to multiple physical
          properties. Select the one you want to create a video for.
        </p>

        {parcels.map((parcel) => (
          <button
            key={parcel.nla_object_id}
            type="button"
            onClick={() => onSelect(parcel.nla_object_id)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '12px 16px',
              marginBottom: 8,
              border: '1px solid #ddd',
              borderRadius: 6,
              background: '#f9f9f9',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            <strong>{formatAddress(parcel)}</strong>
            {parcel.parish && <span style={{ color: '#666' }}> — {parcel.parish}</span>}
            <br />
            <span style={{ fontSize: 12, color: '#888' }}>
              {parcel.has_boundary ? '✓ Boundary data available' : '⚠ No boundary — approximate box will be used'}
              {parcel.is_incomplete && ' · ⚠ Incomplete NLA record'}
            </span>
          </button>
        ))}

        <button
          type="button"
          onClick={onClose}
          style={{ marginTop: 8, color: '#666', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
