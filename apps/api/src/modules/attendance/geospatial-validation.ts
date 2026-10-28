import type { GeofenceResult as PrismaGeofenceResult } from '../../generated/prisma/enums.js';

export type GeofenceResult = PrismaGeofenceResult;

export type ActiveAssignedStore = Readonly<{
  id: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  accuracyLimitMeters: number;
}>;

export type GeospatialAssessment = Readonly<{
  storeId: string | null;
  distanceMeters: number | null;
  radiusMeters: number | null;
  accuracyLimitMeters: number | null;
  result: GeofenceResult | null;
  repeatedCoordinate: boolean;
}>;

const MEAN_EARTH_RADIUS_METERS = 6_371_008.8;
const DISTANCE_DECIMAL_PLACES = 6;

/** Great-circle distance using the haversine formula and the IUGG mean Earth radius. */
export function geodesicDistanceMeters(
  latitude: number,
  longitude: number,
  storeLatitude: number,
  storeLongitude: number,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(storeLatitude - latitude);
  const longitudeDelta = toRadians(storeLongitude - longitude);
  const fromLatitude = toRadians(latitude);
  const toLatitude = toRadians(storeLatitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  const clampedHaversine = Math.min(1, Math.max(0, haversine));
  const meters =
    2 *
    MEAN_EARTH_RADIUS_METERS *
    Math.atan2(Math.sqrt(clampedHaversine), Math.sqrt(1 - clampedHaversine));

  // Persist and compare the same deterministic micrometer-rounded value.
  return Number(meters.toFixed(DISTANCE_DECIMAL_PLACES));
}

function assessStore(
  store: ActiveAssignedStore,
  input: Readonly<{
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    repeatedCoordinate: boolean;
  }>,
): GeospatialAssessment {
  const distanceMeters = geodesicDistanceMeters(
    input.latitude,
    input.longitude,
    store.latitude,
    store.longitude,
  );
  const outsideRadius = distanceMeters > store.radiusMeters;
  const accuracyExceeded = input.accuracyMeters > store.accuracyLimitMeters;
  const result: GeofenceResult =
    outsideRadius && accuracyExceeded
      ? 'OUTSIDE_RADIUS_AND_ACCURACY_EXCEEDED'
      : outsideRadius
        ? 'OUTSIDE_RADIUS'
        : accuracyExceeded
          ? 'ACCURACY_EXCEEDED'
          : 'WITHIN_LIMITS';

  return {
    storeId: store.id,
    distanceMeters,
    radiusMeters: store.radiusMeters,
    accuracyLimitMeters: store.accuracyLimitMeters,
    result,
    repeatedCoordinate: input.repeatedCoordinate,
  };
}

/**
 * Resolve a client store hint only against the employee's active assignments.
 * If there is no unique implicit choice, retain the attempt without attributing it
 * to an unverified store.
 */
export function assessGeospatialAttempt(
  input: Readonly<{
    stores: readonly ActiveAssignedStore[];
    storeIdHint: string | null;
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    repeatedCoordinate: boolean;
  }>,
): GeospatialAssessment {
  let selectedStore: ActiveAssignedStore | undefined;

  if (input.storeIdHint) {
    selectedStore = input.stores.find((store) => store.id === input.storeIdHint);
    if (!selectedStore) {
      return {
        storeId: null,
        distanceMeters: null,
        radiusMeters: null,
        accuracyLimitMeters: null,
        result: 'STORE_NOT_ASSIGNED',
        repeatedCoordinate: input.repeatedCoordinate,
      };
    }
  } else if (input.stores.length === 1) {
    selectedStore = input.stores[0];
  } else if (input.stores.length > 1) {
    return {
      storeId: null,
      distanceMeters: null,
      radiusMeters: null,
      accuracyLimitMeters: null,
      result: 'STORE_SELECTION_REQUIRED',
      repeatedCoordinate: input.repeatedCoordinate,
    };
  } else {
    return {
      storeId: null,
      distanceMeters: null,
      radiusMeters: null,
      accuracyLimitMeters: null,
      result: 'NO_ACTIVE_ASSIGNED_STORE',
      repeatedCoordinate: input.repeatedCoordinate,
    };
  }

  if (!selectedStore) {
    return {
      storeId: null,
      distanceMeters: null,
      radiusMeters: null,
      accuracyLimitMeters: null,
      result: 'NO_ACTIVE_ASSIGNED_STORE',
      repeatedCoordinate: input.repeatedCoordinate,
    };
  }

  return assessStore(selectedStore, input);
}
