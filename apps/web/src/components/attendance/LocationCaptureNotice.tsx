import type { LocationCaptureSnapshot } from './location-capture.js';
import './location-capture.css';

type LocationCaptureNoticeProps = Readonly<{ snapshot: LocationCaptureSnapshot }>;

function formatAccuracy(accuracyMeters: number): string {
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 }).format(accuracyMeters);
}

export function LocationCaptureNotice({ snapshot }: LocationCaptureNoticeProps) {
  if (snapshot.status === 'idle') return null;

  if (
    (snapshot.status === 'captured' || snapshot.status === 'accuracy-poor') &&
    snapshot.location
  ) {
    return (
      <section className="location-capture-notice" aria-label="Hasil pengambilan lokasi">
        <p>
          Akurasi perangkat: <strong>{formatAccuracy(snapshot.location.accuracyMeters)} m</strong>.
          Nilai ini informatif; browser tidak menetapkan jarak atau hasil geofence.
        </p>
        <p className="location-capture-notice__status" role="status">
          {snapshot.status === 'captured'
            ? 'Menunggu validasi lokasi server. Belum ada absensi yang dikirim atau disimpan.'
            : `${snapshot.message} Belum ada absensi yang dikirim atau disimpan.`}
        </p>
      </section>
    );
  }

  const isError =
    snapshot.status === 'denied' ||
    snapshot.status === 'timeout' ||
    snapshot.status === 'unavailable' ||
    snapshot.status === 'invalid' ||
    snapshot.status === 'unsupported' ||
    snapshot.status === 'error';

  return (
    <p
      className={`location-capture-notice${isError ? ' location-capture-notice--error' : ''}`}
      role={isError ? 'alert' : 'status'}
      aria-live="polite"
    >
      {snapshot.message}
    </p>
  );
}
