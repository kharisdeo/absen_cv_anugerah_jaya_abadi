import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, resolve, sep } from 'node:path';
import { argv, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const outputDirectoryArguments = argv.slice(2);
if (
  outputDirectoryArguments.length !== 0 &&
  (outputDirectoryArguments.length !== 2 || outputDirectoryArguments[0] !== '--output-dir')
) {
  throw new Error('Usage: check-performance-budget.mjs [--output-dir <directory>]');
}

const defaultOutputDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const outputDirectory = await realpath(
  resolve(outputDirectoryArguments[1] ?? defaultOutputDirectory),
);
const htmlPath = resolve(outputDirectory, 'index.html');
const html = await readFile(htmlPath);
const htmlText = html.toString();
const referencedAssets = new Set(
  [...htmlText.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((assetPath) => assetPath?.startsWith('/assets/') && /\.(?:js|css)$/i.test(assetPath)),
);

if (referencedAssets.size === 0) {
  throw new Error('No initial JavaScript or CSS assets were found in dist/index.html.');
}

function findClosingDelimiter(source, startIndex, openingDelimiter, closingDelimiter) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];

    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
    } else if (character === openingDelimiter) {
      depth += 1;
    } else if (character === closingDelimiter) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  throw new Error(`Unclosed ${openingDelimiter} in generated service worker.`);
}

function parsePrecacheManifest(source) {
  let cursor = 0;

  function skipWhitespace() {
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
  }

  function expect(character) {
    skipWhitespace();
    assert.equal(
      source[cursor],
      character,
      `Expected ${character} in generated precache manifest.`,
    );
    cursor += 1;
  }

  function parseString() {
    skipWhitespace();
    const start = cursor;
    assert.equal(source[cursor], '"', 'Expected a quoted string in generated precache manifest.');
    cursor += 1;
    let escaped = false;

    while (cursor < source.length) {
      const character = source[cursor];
      cursor += 1;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        return JSON.parse(source.slice(start, cursor));
      }
    }

    throw new Error('Unclosed string in generated precache manifest.');
  }

  expect('[');
  const entries = [];
  skipWhitespace();
  while (source[cursor] !== ']') {
    expect('{');
    const entry = {};
    skipWhitespace();

    while (source[cursor] !== '}') {
      skipWhitespace();
      let key;
      if (source[cursor] === '"') {
        key = parseString();
      } else {
        key = /^[\w$]+/u.exec(source.slice(cursor))?.[0];
        assert.ok(key, 'Expected a field name in generated precache entry.');
        cursor += key.length;
      }
      expect(':');
      skipWhitespace();

      if (source[cursor] === '"') {
        entry[key] = parseString();
      } else if (source.startsWith('null', cursor)) {
        entry[key] = null;
        cursor += 4;
      } else {
        throw new Error(`Unsupported value for generated precache field ${key}.`);
      }

      skipWhitespace();
      if (source[cursor] === ',') cursor += 1;
      else break;
    }

    expect('}');
    entries.push(entry);
    skipWhitespace();
    if (source[cursor] === ',') cursor += 1;
    else break;
  }

  expect(']');
  skipWhitespace();
  assert.equal(cursor, source.length, 'Unexpected data after generated precache manifest.');
  return entries;
}

async function requireNonEmptyFile(filePath, description) {
  const resolvedFilePath = await realpath(filePath);
  assert.ok(
    resolvedFilePath.startsWith(`${outputDirectory}${sep}`),
    `${description} must resolve inside the build output directory.`,
  );
  const fileStats = await stat(resolvedFilePath);
  assert.ok(fileStats.isFile() && fileStats.size > 0, `${description} must be a non-empty file.`);
}

const manifestPath = resolve(outputDirectory, 'manifest.webmanifest');
const manifestText = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText);
assert.equal(
  manifest.name,
  'Absensi CV Anugerah Jaya Abadi',
  'Manifest name must identify the app.',
);
assert.equal(manifest.short_name, 'Absensi AJ', 'Manifest short name must identify the app.');
assert.equal(manifest.display, 'standalone', 'Manifest must request standalone display.');
assert.equal(manifest.lang, 'id-ID', 'Manifest language must be Indonesian.');
assert.equal(manifest.start_url, '/', 'Manifest start URL must be the app root.');
assert.equal(manifest.scope, '/', 'Manifest scope must cover the app root.');

const manifestLinkTags = [...htmlText.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
assert.ok(
  manifestLinkTags.some(
    (tag) =>
      /\brel="[^"]*\bmanifest\b[^"]*"/i.test(tag) && /\bhref="\/manifest\.webmanifest"/i.test(tag),
  ),
  'Generated index.html must link to manifest.webmanifest.',
);

assert.ok(Array.isArray(manifest.icons), 'Manifest icons must be an array.');
for (const [requiredSize, requiredFilename] of [
  ['192x192', 'app-icon-192.png'],
  ['512x512', 'app-icon-512.png'],
]) {
  const matchingIcons = manifest.icons.filter((icon) => icon.sizes === requiredSize);
  assert.ok(matchingIcons.length > 0, `Manifest must declare a ${requiredSize} icon.`);

  const validIcon = matchingIcons.find((icon) => {
    if (
      typeof icon.src !== 'string' ||
      !icon.src.startsWith('/icons/') ||
      !icon.src.endsWith(requiredFilename) ||
      icon.type !== 'image/png'
    ) {
      return false;
    }

    const purposes = String(icon.purpose ?? 'any').split(/\s+/u);
    return purposes.includes('any');
  });
  assert.ok(
    validIcon,
    `Manifest must declare ${requiredSize} as a local PNG icon for any purpose.`,
  );

  const iconPath = resolve(outputDirectory, `.${validIcon.src}`);
  assert.ok(
    iconPath.startsWith(`${outputDirectory}${sep}`),
    `Manifest icon path must stay inside the build output: ${validIcon.src}`,
  );
  await requireNonEmptyFile(iconPath, `Manifest ${requiredSize} icon`);
  const iconBytes = await readFile(iconPath);
  assert.ok(
    iconBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      iconBytes.toString('ascii', 12, 16) === 'IHDR',
    `${requiredSize} icon must be a PNG with an IHDR chunk.`,
  );
  assert.equal(
    iconBytes.readUInt32BE(16),
    Number.parseInt(requiredSize, 10),
    `${requiredSize} icon width.`,
  );
  assert.equal(
    iconBytes.readUInt32BE(20),
    Number.parseInt(requiredSize.split('x')[0], 10),
    `${requiredSize} icon height.`,
  );
}

const outputEntries = await readdir(outputDirectory, { withFileTypes: true });
const serviceWorkerPath = resolve(outputDirectory, 'sw.js');
await requireNonEmptyFile(serviceWorkerPath, 'Generated service worker');
const serviceWorker = await readFile(serviceWorkerPath, 'utf8');
const workboxFiles = outputEntries.filter(
  (entry) => entry.isFile() && /^workbox-[\w-]+\.js$/u.test(entry.name),
);
assert.ok(workboxFiles.length > 0, 'Generated Workbox runtime artifact must exist.');
for (const workboxFile of workboxFiles) {
  await requireNonEmptyFile(
    resolve(outputDirectory, workboxFile.name),
    'Generated Workbox runtime',
  );
}
assert.ok(
  workboxFiles.some((workboxFile) =>
    serviceWorker.includes(workboxFile.name.replace(/\.js$/u, '')),
  ),
  'Generated service worker must reference its Workbox runtime artifact.',
);

const precacheCalls = [...serviceWorker.matchAll(/\bprecacheAndRoute\s*\(/gu)];
assert.equal(
  precacheCalls.length,
  1,
  'Generated service worker must have one supported static precache manifest.',
);
const [precacheCall] = precacheCalls;
const precacheOpen = serviceWorker.indexOf('(', precacheCall.index) + 1;
let precacheStart = precacheOpen;
while (/\s/u.test(serviceWorker[precacheStart] ?? '')) precacheStart += 1;
assert.equal(
  serviceWorker[precacheStart],
  '[',
  'Precache manifest must be an emitted static array.',
);
const precacheEnd = findClosingDelimiter(serviceWorker, precacheStart, '[', ']');
let precacheEntries;
try {
  precacheEntries = parsePrecacheManifest(serviceWorker.slice(precacheStart, precacheEnd + 1));
} catch (error) {
  throw new Error(
    `Unsupported Workbox precache literal format; expected a static array of records with string URLs and string/null revisions. ${error.message}`,
    { cause: error },
  );
}
assert.ok(Array.isArray(precacheEntries), 'Generated precache manifest must be an array.');

const precachePaths = new Set();
const requiredPrecachePaths = new Set([
  'index.html',
  'manifest.webmanifest',
  'icons/app-icon-192.png',
  'icons/app-icon-512.png',
]);
for (const entry of precacheEntries) {
  assert.equal(typeof entry.url, 'string', 'Every precache entry must have a URL.');
  assert.ok(
    typeof entry.revision === 'string' || entry.revision === null,
    'Every precache entry must have a string or null revision.',
  );
  assert.ok(
    !/^[a-z][a-z\d+.-]*:/iu.test(entry.url) && !entry.url.startsWith('//'),
    'Precache URLs must be local paths.',
  );
  assert.ok(!/[?#]/u.test(entry.url), 'Precache URLs must not contain query strings or fragments.');

  let relativePath;
  try {
    relativePath = decodeURIComponent(entry.url).replace(/^(?:\.\/|\/)+/u, '');
  } catch {
    throw new Error(`Precache URL has invalid percent encoding: ${entry.url}`);
  }
  assert.ok(
    relativePath && !relativePath.includes('\\'),
    `Precache URL must be a local file path: ${entry.url}`,
  );
  assert.ok(
    !relativePath.split('/').some((segment) => segment === '.' || segment === '..'),
    `Precache URL must not traverse directories: ${entry.url}`,
  );

  const cachedFilePath = resolve(outputDirectory, ...relativePath.split('/'));
  assert.ok(
    cachedFilePath.startsWith(`${outputDirectory}${sep}`),
    `Precache URL must stay inside the build output: ${entry.url}`,
  );
  await requireNonEmptyFile(cachedFilePath, `Precached file ${entry.url}`);

  assert.ok(
    requiredPrecachePaths.has(relativePath) ||
      relativePath.startsWith('assets/') ||
      relativePath.startsWith('icons/'),
    `Precache URL must reference a shell file, install icon, or emitted static build asset: ${entry.url}`,
  );
  precachePaths.add(relativePath);
}

for (const requiredPath of requiredPrecachePaths) {
  assert.ok(precachePaths.has(requiredPath), `Precache manifest must include ${requiredPath}.`);
}

const registerRouteMatches = [...serviceWorker.matchAll(/\bregisterRoute\s*\(/gu)];
assert.equal(
  registerRouteMatches.length,
  1,
  'Generated service worker must register only the app-shell navigation route; runtime caching routes are unsupported.',
);
const [registerRouteMatch] = registerRouteMatches;
const registerRouteOpen = serviceWorker.indexOf('(', registerRouteMatch.index);
const registerRouteEnd = findClosingDelimiter(serviceWorker, registerRouteOpen, '(', ')');
assert.match(
  serviceWorker.slice(registerRouteOpen + 1, registerRouteEnd),
  /^\s*new\s+(?:[$\w]+\.)?NavigationRoute\s*\(/u,
  'The sole registered Workbox route must be the navigation fallback.',
);

const navigationRouteMatches = [...serviceWorker.matchAll(/\bNavigationRoute\s*\(/gu)];
assert.equal(
  navigationRouteMatches.length,
  1,
  'Generated service worker must have one navigation route.',
);
const [navigationRouteMatch] = navigationRouteMatches;
const navigationOpen = serviceWorker.indexOf('(', navigationRouteMatch.index);
const navigationEnd = findClosingDelimiter(serviceWorker, navigationOpen, '(', ')');
const navigationArguments = serviceWorker.slice(navigationOpen + 1, navigationEnd);
assert.match(
  navigationArguments,
  /^\s*(?:[$\w]+\.)?createHandlerBoundToURL\(\s*(["'])\/index\.html\1\s*\)\s*,/u,
  'Navigation fallback must use the generated index.html shell.',
);
const denylistMatch = /\bdenylist\s*:\s*\[([^\]]*)\]/u.exec(navigationArguments);
assert.ok(denylistMatch, 'Navigation fallback must retain a denylist.');
assert.ok(
  denylistMatch[1].includes(String.raw`/^\/api\//`),
  'Navigation fallback denylist must exclude paths rooted at /api/.',
);

stdout.write(
  `[PWA] Build output contract passed: manifest, install icons, service worker/Workbox, ` +
    `${precachePaths.size} local precache path(s), one index.html navigation route, and /api/ exclusion.\n`,
);

const files = [{ name: 'index.html', bytes: html }];
for (const assetPath of referencedAssets) {
  const filePath = resolve(outputDirectory, `.${assetPath}`);
  if (!filePath.startsWith(`${outputDirectory}${sep}`)) {
    throw new Error(`Initial asset resolves outside the build output: ${assetPath}`);
  }
  files.push({ name: assetPath, bytes: await readFile(filePath) });
}

const rawBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
const gzipBytes = files.reduce(
  (total, file) => total + gzipSync(file.bytes, { level: 9 }).byteLength,
  0,
);
const rawBudgetBytes = 650 * 1024;
const gzipBudgetBytes = 180 * 1024;

stdout.write(
  `[INT-012] Initial assets (${files.length - 1} JS/CSS file(s) + HTML): ` +
    `${rawBytes}/${rawBudgetBytes} raw bytes; ${gzipBytes}/${gzipBudgetBytes} gzip bytes.\n`,
);

if (rawBytes > rawBudgetBytes || gzipBytes > gzipBudgetBytes) {
  throw new Error('Initial page assets exceed the INT-012 production build budget.');
}
