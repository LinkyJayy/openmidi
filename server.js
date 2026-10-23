// OpenMidi server: serves the web app and stores presets on disk.
// On Railway, attach a volume and the presets file lives on it
// (RAILWAY_VOLUME_MOUNT_PATH is set automatically when a volume is attached).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidPreset } from './js/presets.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data'));
const PRESETS_FILE = path.join(DATA_DIR, 'presets.json');
const MAX_BODY = 1024 * 1024;
const MAX_PRESETS = 500;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
// Only these paths are public, so server files and the data folder are never served.
const STATIC_DIRS = ['css', 'js'];

async function readPresets() {
  try {
    const list = JSON.parse(await fs.readFile(PRESETS_FILE, 'utf8'));
    return Array.isArray(list) ? list.filter(isValidPreset) : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// Writes go through a queue and a temp file, so a crash never leaves half a file.
let writeQueue = Promise.resolve();
function writePresets(list) {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${PRESETS_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(list, null, 2));
    await fs.rename(tmp, PRESETS_FILE);
  });
  return writeQueue;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function handleApi(req, res, pathname) {
  if (pathname !== '/api/presets') return sendJson(res, 404, { error: 'Not found' });

  if (req.method === 'GET') return sendJson(res, 200, { presets: await readPresets() });

  if (req.method === 'PUT') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      return sendJson(res, error.status ?? 400, { error: error.status ? error.message : 'Invalid JSON' });
    }
    const list = body?.presets;
    if (!Array.isArray(list) || list.length > MAX_PRESETS || !list.every(p => isValidPreset(p) && typeof p.id === 'string')) {
      return sendJson(res, 400, { error: 'Invalid presets' });
    }
    const clean = list.map(({ id, name, mode, colors }) => ({ id: id.slice(0, 64), name: name.slice(0, 40), mode, colors }));
    await writePresets(clean);
    return sendJson(res, 200, { presets: clean });
  }

  res.setHeader('Allow', 'GET, PUT');
  return sendJson(res, 405, { error: 'Method not allowed' });
}

async function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const allowed = rel === 'index.html' || STATIC_DIRS.some(dir => rel.startsWith(`${dir}/`));
  const file = path.join(ROOT, rel);
  if (!allowed || !file.startsWith(ROOT + path.sep)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  try {
    if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    return await handleStatic(req, res, pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`OpenMidi listening on port ${PORT}`);
  console.log(`Presets stored in ${PRESETS_FILE}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
