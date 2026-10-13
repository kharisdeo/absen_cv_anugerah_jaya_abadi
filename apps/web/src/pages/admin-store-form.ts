import type { StoreDto, StoreWriteInput } from '../api/admin-stores-api.js';

export type StoreDraft = Readonly<{
  name: string;
  address: string;
  latitude: string;
  longitude: string;
  radiusMeters: string;
  accuracyLimitMeters: string;
  wifiPublicIp: string;
}>;

export type StoreDraftField = keyof StoreDraft;
export type StoreDraftErrors = Partial<Record<StoreDraftField, string>>;

export function emptyStoreDraft(): StoreDraft {
  return {
    name: '',
    address: '',
    latitude: '',
    longitude: '',
    radiusMeters: '10',
    accuracyLimitMeters: '30',
    wifiPublicIp: '',
  };
}

export function storeToDraft(store: StoreDto): StoreDraft {
  return {
    name: store.name,
    address: store.address ?? '',
    latitude: String(store.latitude),
    longitude: String(store.longitude),
    radiusMeters: String(store.radiusMeters),
    accuracyLimitMeters: String(store.accuracyLimitMeters),
    wifiPublicIp: store.wifiPublicIp ?? '',
  };
}

/** Fields that change the location checks applied to future attendance attempts. */
export function storeSensitiveChangeLabels(
  store: StoreDto,
  input: StoreWriteInput,
): readonly string[] {
  const changes: readonly Readonly<{ changed: boolean; label: string }>[] = [
    { changed: store.latitude !== input.latitude, label: 'Koordinat lokasi' },
    { changed: store.longitude !== input.longitude, label: 'Koordinat lokasi' },
    { changed: store.radiusMeters !== input.radiusMeters, label: 'Radius lokasi' },
    {
      changed: store.accuracyLimitMeters !== input.accuracyLimitMeters,
      label: 'Batas akurasi GPS',
    },
    { changed: store.wifiPublicIp !== input.wifiPublicIp, label: 'IP publik Wi-Fi' },
  ];
  return [...new Set(changes.filter(({ changed }) => changed).map(({ label }) => label))];
}

function parseCoordinate(value: string, minimum: number, maximum: number): number | null {
  const normalized = value.trim();
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return null;
  return parsed;
}

function parsePositiveInteger(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) return null;
  return parsed;
}

function isIpv4Literal(value: string): boolean {
  const octets = value.split('.');
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255,
    )
  );
}

function isIpv6Literal(value: string): boolean {
  if (!value.includes(':') || value.includes('%')) return false;
  try {
    const parsed = new URL(`http://[${value}]/`);
    return parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']');
  } catch {
    return false;
  }
}

export function validateStoreDraft(draft: StoreDraft): Readonly<{
  errors: StoreDraftErrors;
  input: StoreWriteInput | null;
}> {
  const errors: StoreDraftErrors = {};
  const name = draft.name.trim();
  const address = draft.address.trim();
  const latitude = parseCoordinate(draft.latitude, -90, 90);
  const longitude = parseCoordinate(draft.longitude, -180, 180);
  const radiusMeters = parsePositiveInteger(draft.radiusMeters);
  const accuracyLimitMeters = parsePositiveInteger(draft.accuracyLimitMeters);
  const wifiPublicIp = draft.wifiPublicIp.trim();

  if (name.length === 0) errors.name = 'Nama toko wajib diisi.';
  else if (name.length > 160) errors.name = 'Nama toko maksimal 160 karakter.';
  if (address.length > 500) errors.address = 'Alamat maksimal 500 karakter.';
  if (latitude === null)
    errors.latitude = 'Masukkan latitude antara -90 dan 90, maksimal 6 desimal.';
  if (longitude === null)
    errors.longitude = 'Masukkan longitude antara -180 dan 180, maksimal 6 desimal.';
  if (radiusMeters === null)
    errors.radiusMeters = 'Radius harus bilangan bulat positif hingga 2.147.483.647 meter.';
  if (accuracyLimitMeters === null) {
    errors.accuracyLimitMeters =
      'Batas akurasi harus bilangan bulat positif hingga 2.147.483.647 meter.';
  }
  if (wifiPublicIp.length > 45) errors.wifiPublicIp = 'Alamat IP maksimal 45 karakter.';
  else if (wifiPublicIp && !isIpv4Literal(wifiPublicIp) && !isIpv6Literal(wifiPublicIp)) {
    errors.wifiPublicIp = 'Masukkan satu alamat IPv4 atau IPv6 yang valid.';
  }

  if (
    Object.keys(errors).length > 0 ||
    latitude === null ||
    longitude === null ||
    radiusMeters === null ||
    accuracyLimitMeters === null
  ) {
    return { errors, input: null };
  }

  return {
    errors,
    input: {
      name,
      address: address || null,
      latitude,
      longitude,
      radiusMeters,
      accuracyLimitMeters,
      wifiPublicIp: wifiPublicIp || null,
    },
  };
}
