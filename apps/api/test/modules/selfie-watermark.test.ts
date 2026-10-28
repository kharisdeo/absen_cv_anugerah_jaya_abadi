import { describe, expect, it } from 'vitest';

import sharp from 'sharp';
import { renderWatermarkedSelfie } from '../../src/modules/attendance/selfie-watermark.js';

describe('renderWatermarkedSelfie', () => {
  it('creates a visible JPEG derivative with server WIB time, DB employee name, and location', async () => {
    const width = 640;
    const height = 480;
    const source = await sharp(Buffer.alloc(width * height * 3, 255), {
      raw: { width, height, channels: 3 },
    })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    const result = await renderWatermarkedSelfie(source, 'image/jpeg', {
      employeeName: 'Karyawan & Uji',
      serverTime: '2026-10-11T03:00:00.000Z',
      latitude: -6.2,
      longitude: 106.816666,
    });
    const decoded = await sharp(result).raw().toBuffer({ resolveWithObject: true });
    const bottomPixel = (decoded.info.height - 4) * decoded.info.width * decoded.info.channels;

    expect(result.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(result.equals(source)).toBe(false);
    expect(result.byteLength).toBeLessThanOrEqual(200 * 1024);
    expect(decoded.info.width).toBe(width);
    expect(decoded.info.height).toBe(height);
    // The dark band is the rasterized watermark background, not metadata-only JSON.
    expect(decoded.data[bottomPixel]).toBeLessThan(100);
    expect(decoded.data[bottomPixel + 1]).toBeLessThan(100);
  }, 15_000);

  it('labels missing GPS as unavailable and rejects invalid source metadata', async () => {
    const source = await sharp(Buffer.alloc(800 * 600 * 3, 245), {
      raw: { width: 800, height: 600, channels: 3 },
    })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();

    await expect(
      renderWatermarkedSelfie(source, 'image/jpeg', {
        employeeName: 'Karyawan Uji',
        serverTime: '2026-10-11T03:00:00.000Z',
        locationFailureReason: 'PERMISSION_DENIED',
      }),
    ).resolves.toBeInstanceOf(Buffer);
    await expect(
      renderWatermarkedSelfie(source, 'image/png', {
        employeeName: 'Karyawan Uji',
        serverTime: 'not-a-time',
      }),
    ).rejects.toThrow();
  });
});
