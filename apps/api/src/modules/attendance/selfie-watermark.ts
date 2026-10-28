import sharp from 'sharp';

const MAX_OUTPUT_BYTES = 200 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;

export type SelfieWatermarkMetadata = Readonly<{
  employeeName: string;
  serverTime: string;
  latitude?: number;
  longitude?: number;
  locationFailureReason?: string | null;
}>;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function watermarkTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid server receipt timestamp');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}:${part('second')} WIB`;
}

function locationText(metadata: SelfieWatermarkMetadata): string {
  if (
    typeof metadata.latitude === 'number' &&
    Number.isFinite(metadata.latitude) &&
    typeof metadata.longitude === 'number' &&
    Number.isFinite(metadata.longitude)
  ) {
    return `Lokasi: ${metadata.latitude.toFixed(5)}, ${metadata.longitude.toFixed(5)}`;
  }
  return 'Lokasi tidak tersedia';
}

function svgOverlay(width: number, height: number, metadata: SelfieWatermarkMetadata): Buffer {
  const stripHeight = Math.max(62, Math.min(116, Math.round(height * 0.2)));
  const fontSize = Math.max(13, Math.min(22, Math.round(width / 42)));
  const lineGap = Math.max(18, Math.round(fontSize * 1.28));
  const firstY = height - stripHeight + Math.round((stripHeight - lineGap * 2) / 2) + fontSize;
  const employeeName = metadata.employeeName.trim().slice(0, 100);
  if (!employeeName) throw new Error('Employee name is required for watermark');
  const rows = [
    `Karyawan: ${employeeName}`,
    `Server: ${watermarkTime(metadata.serverTime)}`,
    locationText(metadata),
  ];
  const text = rows
    .map(
      (row, index) =>
        `<text x="${Math.round(width * 0.035)}" y="${firstY + index * lineGap}" fill="#fff" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="600">${escapeXml(row)}</text>`,
    )
    .join('');
  return Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="${height - stripHeight}" width="${width}" height="${stripHeight}" fill="#07111f" fill-opacity="0.78"/>${text}</svg>`,
  );
}

/** Renders a private, bounded-size JPEG derivative. The source bytes are never modified. */
export async function renderWatermarkedSelfie(
  bytes: Uint8Array,
  contentType: string,
  metadata: SelfieWatermarkMetadata,
): Promise<Buffer> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType) || bytes.byteLength < 1) {
    throw new Error('Unsupported selfie source');
  }

  const source = Buffer.from(bytes);
  const probe = sharp(source, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS });
  const sourceMetadata = await probe.metadata();
  const expectedFormat =
    contentType === 'image/jpeg' ? 'jpeg' : contentType === 'image/png' ? 'png' : 'webp';
  if (
    sourceMetadata.format !== expectedFormat ||
    !sourceMetadata.width ||
    !sourceMetadata.height ||
    sourceMetadata.width < 1 ||
    sourceMetadata.height < 1
  ) {
    throw new Error('Selfie content does not match its declared image type');
  }

  for (const edge of [1600, 1280, 1024, 800]) {
    for (const quality of [80, 68, 56]) {
      const base = await sharp(source, {
        failOn: 'error',
        limitInputPixels: MAX_INPUT_PIXELS,
      })
        .rotate()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      const output = await sharp(base.data)
        .composite([{ input: svgOverlay(base.info.width, base.info.height, metadata) }])
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (output.byteLength <= MAX_OUTPUT_BYTES) return output;
    }
  }

  throw new Error('Watermarked selfie exceeds the private evidence size limit');
}
