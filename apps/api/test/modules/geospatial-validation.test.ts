import { describe, expect, it } from 'vitest';

import {
  assessGeospatialAttempt,
  geodesicDistanceMeters,
  type ActiveAssignedStore,
} from '../../src/modules/attendance/geospatial-validation.js';

const EARTH_RADIUS_METERS = 6_371_008.8;
const STORE: ActiveAssignedStore = {
  id: 'store-one',
  latitude: 0,
  longitude: 0,
  radiusMeters: 10,
  accuracyLimitMeters: 30,
};

function longitudeOffsetForMeters(distanceMeters: number): number {
  return (distanceMeters / EARTH_RADIUS_METERS) * (180 / Math.PI);
}

function assess(overrides: Partial<Parameters<typeof assessGeospatialAttempt>[0]> = {}) {
  return assessGeospatialAttempt({
    stores: [STORE],
    storeIdHint: null,
    latitude: 0,
    longitude: 0,
    accuracyMeters: 30,
    repeatedCoordinate: false,
    ...overrides,
  });
}

describe('server-side geospatial assessment', () => {
  it('uses the geodesic distance from the reported fix to the assigned store', () => {
    expect(geodesicDistanceMeters(0, 0, 0, 0)).toBe(0);
    expect(geodesicDistanceMeters(0, 0, 0, longitudeOffsetForMeters(10))).toBeCloseTo(10, 5);
    expect(geodesicDistanceMeters(0, 0, 0, 180)).toBeGreaterThan(20_000_000);
  });

  it('accepts exact radius and accuracy boundaries at the PRD defaults', () => {
    const result = assess({ longitude: longitudeOffsetForMeters(10), accuracyMeters: 30 });

    expect(result).toMatchObject({
      storeId: STORE.id,
      distanceMeters: 10,
      radiusMeters: 10,
      accuracyLimitMeters: 30,
      result: 'WITHIN_LIMITS',
    });
  });

  it('marks a point outside the assigned store radius', () => {
    const result = assess({ longitude: longitudeOffsetForMeters(10.01) });

    expect(result.distanceMeters).toBeGreaterThan(10);
    expect(result.result).toBe('OUTSIDE_RADIUS');
  });

  it('marks accuracy above the store limit and combines simultaneous failures', () => {
    expect(assess({ accuracyMeters: 30.01 }).result).toBe('ACCURACY_EXCEEDED');
    expect(
      assess({ longitude: longitudeOffsetForMeters(10.01), accuracyMeters: 30.01 }).result,
    ).toBe('OUTSIDE_RADIUS_AND_ACCURACY_EXCEEDED');
  });

  it('uses only an employee active assignment when resolving the optional store hint', () => {
    const secondStore: ActiveAssignedStore = {
      ...STORE,
      id: 'store-two',
      longitude: 1,
    };

    expect(assess({ stores: [STORE, secondStore] }).result).toBe('STORE_SELECTION_REQUIRED');
    expect(assess({ stores: [STORE, secondStore], storeIdHint: secondStore.id }).storeId).toBe(
      secondStore.id,
    );
    expect(assess({ storeIdHint: 'not-assigned' })).toMatchObject({
      storeId: null,
      distanceMeters: null,
      result: 'STORE_NOT_ASSIGNED',
    });
    expect(assess({ stores: [] })).toMatchObject({
      storeId: null,
      distanceMeters: null,
      result: 'NO_ACTIVE_ASSIGNED_STORE',
    });
  });

  it('keeps the raw location result and independently flags an identical repeated coordinate', () => {
    expect(assess({ repeatedCoordinate: true })).toMatchObject({
      result: 'WITHIN_LIMITS',
      repeatedCoordinate: true,
    });
  });
});
