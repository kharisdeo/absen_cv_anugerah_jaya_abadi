import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LocationCaptureNotice } from '../src/components/attendance/LocationCaptureNotice.js';
import type { LocationCaptureSnapshot } from '../src/components/attendance/location-capture.js';

function snapshot(overrides: Partial<LocationCaptureSnapshot> = {}): LocationCaptureSnapshot {
  return {
    status: 'idle',
    location: null,
    message: '',
    ...overrides,
  };
}

describe('LocationCaptureNotice', () => {
  it('renders no prompt while idle', () => {
    expect(renderToStaticMarkup(<LocationCaptureNotice snapshot={snapshot()} />)).toBe('');
  });

  it('shows device accuracy and waits for server geofence without showing coordinates', () => {
    const html = renderToStaticMarkup(
      <LocationCaptureNotice
        snapshot={snapshot({
          status: 'captured',
          location: { latitude: -6.2, longitude: 106.8, accuracyMeters: 12.34 },
          message: 'Lokasi diperoleh.',
        })}
      />,
    );

    expect(html).toContain('Akurasi perangkat');
    expect(html).toContain('12,3 m');
    expect(html).toContain('Menunggu validasi lokasi server');
    expect(html).toContain('Belum ada absensi yang dikirim atau disimpan');
    expect(html).not.toContain('-6.2');
    expect(html).not.toContain('106.8');
    expect(html).not.toContain('Valid');
  });

  it('shows poor-accuracy guidance as a status, not a false geofence decision', () => {
    const html = renderToStaticMarkup(
      <LocationCaptureNotice
        snapshot={snapshot({
          status: 'accuracy-poor',
          location: { latitude: -6.2, longitude: 106.8, accuracyMeters: 42 },
          message: 'Akurasi GPS belum mencapai batas toko.',
        })}
      />,
    );

    expect(html).toContain('42 m');
    expect(html).toContain('Akurasi GPS belum mencapai batas toko');
    expect(html).not.toContain('Di luar radius');
    expect(html).not.toContain('Valid');
  });

  it('uses an accessible alert for permission errors without leaking device data', () => {
    const html = renderToStaticMarkup(
      <LocationCaptureNotice
        snapshot={snapshot({
          status: 'denied',
          message: 'Izin lokasi ditolak. Aktifkan lokasi untuk mencoba kembali.',
        })}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Izin lokasi ditolak');
    expect(html).not.toContain('latitude');
    expect(html).not.toContain('longitude');
  });
});
