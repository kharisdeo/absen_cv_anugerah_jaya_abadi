import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const iconDirectory = resolve(scriptDirectory, '../public/icons');
const supersampling = 3;
const background = [18, 60, 54];
const mark = [244, 247, 246];
const accent = [226, 173, 97];

const crcTable = new Uint32Array(256);
for (let value = 0; value < crcTable.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  crcTable[value] = crc >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const content = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(content));
  return Buffer.concat([length, content, checksum]);
}

function inRoundedSquare(x, y, size, radius) {
  const closestX = Math.max(radius, Math.min(size - radius, x));
  const closestY = Math.max(radius, Math.min(size - radius, y));
  const dx = x - closestX;
  const dy = y - closestY;
  return dx * dx + dy * dy <= radius * radius;
}

function isInMark(x, y) {
  const dx = x - 256;
  const dy = y - 256;
  const radius = Math.hypot(dx, dy);
  const openOnRight = dx > 0 && Math.abs(Math.atan2(dy, dx)) < 0.69;
  return radius >= 83 && radius <= 135 && !openOnRight;
}

function isInCheck(x, y, scale) {
  const segments = [
    [211, 270, 243, 302],
    [243, 302, 310, 230],
  ];
  for (const [x1, y1, x2, y2] of segments) {
    const startX = x1;
    const startY = y1;
    const deltaX = x2 - startX;
    const deltaY = y2 - startY;
    const lengthSquared = deltaX ** 2 + deltaY ** 2;
    const projection = Math.max(
      0,
      Math.min(1, ((x - startX) * deltaX + (y - startY) * deltaY) / lengthSquared),
    );
    if (
      Math.hypot(x - (startX + projection * deltaX), y - (startY + projection * deltaY)) <=
      11 * scale
    ) {
      return true;
    }
  }
  return false;
}

function renderIcon(size) {
  const scale = size / 512;
  const highResolutionSize = size * supersampling;
  const highResolutionPixels = Buffer.alloc(highResolutionSize * highResolutionSize * 3);
  const radius = 120 * scale * supersampling;

  for (let y = 0; y < highResolutionSize; y += 1) {
    for (let x = 0; x < highResolutionSize; x += 1) {
      const pixelOffset = (y * highResolutionSize + x) * 3;
      const markX = (x + 0.5) / supersampling;
      const markY = (y + 0.5) / supersampling;
      const color = inRoundedSquare(x + 0.5, y + 0.5, highResolutionSize, radius)
        ? isInCheck(markX, markY, scale)
          ? accent
          : isInMark(markX, markY)
            ? mark
            : background
        : background;
      highResolutionPixels.set(color, pixelOffset);
    }
  }

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const destination = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        let total = 0;
        for (let subY = 0; subY < supersampling; subY += 1) {
          for (let subX = 0; subX < supersampling; subX += 1) {
            const source =
              ((y * supersampling + subY) * highResolutionSize + x * supersampling + subX) * 3 +
              channel;
            total += highResolutionPixels[source];
          }
        }
        pixels[destination + channel] = Math.round(total / supersampling ** 2);
      }
      pixels[destination + 3] = 255;
    }
  }

  const scanlines = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (size * 4 + 1);
    scanlines[rowOffset] = 0;
    pixels.copy(scanlines, rowOffset + 1, y * size * 4, (y + 1) * size * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(iconDirectory, { recursive: true });
for (const [name, size] of [
  ['app-icon-192.png', 192],
  ['app-icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  await writeFile(resolve(iconDirectory, name), renderIcon(size));
}
