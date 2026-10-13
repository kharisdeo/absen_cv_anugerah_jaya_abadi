import { describe, expect, it } from 'vitest';

import type { StoreDto } from '../src/api/admin-stores-api.js';
import {
  emptyStoreDraft,
  storeSensitiveChangeLabels,
  validateStoreDraft,
} from '../src/pages/admin-store-form.js';

const existingStore: StoreDto = {
  id: '00000000-0000-4000-8000-000000000101',
  name: 'Toko Contoh',
  address: 'Alamat lama',
  latitude: -6.2,
  longitude: 106.8,
  radiusMeters: 10,
  accuracyLimitMeters: 30,
  wifiPublicIp: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('admin store form validation', () => {
  it('starts with the existing database defaults and requires confirmed name and coordinates', () => {
    const draft = emptyStoreDraft();
    expect(draft.radiusMeters).toBe('10');
    expect(draft.accuracyLimitMeters).toBe('30');
    expect(validateStoreDraft(draft).input).toBeNull();
  });

  it('normalizes optional values and accepts bounded coordinates and IP literals', () => {
    const result = validateStoreDraft({
      name: '  Toko Utama  ',
      address: '   ',
      latitude: '-6.200000',
      longitude: '106.816666',
      radiusMeters: '10',
      accuracyLimitMeters: '30',
      wifiPublicIp: '2001:db8::1',
    });

    expect(result.errors).toEqual({});
    expect(result.input).toEqual({
      name: 'Toko Utama',
      address: null,
      latitude: -6.2,
      longitude: 106.816666,
      radiusMeters: 10,
      accuracyLimitMeters: 30,
      wifiPublicIp: '2001:db8::1',
    });
  });

  it('rejects coordinates outside Earth bounds, excess precision, nonpositive distances, and malformed IPs', () => {
    const result = validateStoreDraft({
      name: 'Toko',
      address: '',
      latitude: '-90.000001',
      longitude: '181',
      radiusMeters: '0',
      accuracyLimitMeters: '1.5',
      wifiPublicIp: '999.1.1.1',
    });

    expect(result.input).toBeNull();
    expect(result.errors.latitude).toBeDefined();
    expect(result.errors.longitude).toBeDefined();
    expect(result.errors.radiusMeters).toBeDefined();
    expect(result.errors.accuracyLimitMeters).toBeDefined();
    expect(result.errors.wifiPublicIp).toBeDefined();
  });

  it('requires sensitive-change confirmation only when location validation settings differ', () => {
    const unchangedSettings = {
      name: 'Nama baru',
      address: 'Alamat baru',
      latitude: existingStore.latitude,
      longitude: existingStore.longitude,
      radiusMeters: existingStore.radiusMeters,
      accuracyLimitMeters: existingStore.accuracyLimitMeters,
      wifiPublicIp: existingStore.wifiPublicIp,
    };
    expect(storeSensitiveChangeLabels(existingStore, unchangedSettings)).toEqual([]);

    expect(
      storeSensitiveChangeLabels(existingStore, {
        ...unchangedSettings,
        latitude: -6.21,
        longitude: 106.81,
        radiusMeters: 20,
        accuracyLimitMeters: 50,
        wifiPublicIp: '203.0.113.10',
      }),
    ).toEqual(['Koordinat lokasi', 'Radius lokasi', 'Batas akurasi GPS', 'IP publik Wi-Fi']);
  });
});
