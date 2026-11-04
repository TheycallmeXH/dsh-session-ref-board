/**
 * Host half: per-session image board storage.
 *
 * Everything the client half needs lives under `$DSH_HOME/session-ref-board`:
 * one `<session-slug>.json` board document per conversation and one
 * `<session-slug>/` directory of copied image files. Copying on intake keeps
 * the board self-contained (a deleted source file cannot break the board) and
 * lets the file route serve only paths this plugin created.
 *
 * @module @local/session-ref-board
 */
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const ROUTE_PREFIX = '/session-ref-board';
const MAX_BODY_BYTES = 128 * 1024 * 1024;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_ITEMS = 400;

/** In-memory ring the client can push into, so a device-side drag can be diagnosed without devtools. */
const DEBUG_RING = [];

const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

const EXT_OF_MEDIA = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/tiff': '.tif',
  'image/heic': '.heic',
};

/** Harness home: `$DSH_HOME` when set, else `~/.dsh`. */
function boardRoot() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return join(configured.length > 0 ? configured : join(homedir(), '.dsh'), 'session-ref-board');
}

/** Filesystem-safe session key, stable across restarts and collision-free per session. */
function sessionSlug(sessionId) {
  const text = String(sessionId ?? '').trim();
  if (text.length === 0) throw new Error('missing session');
  const readable = text.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 48);
  const digest = createHash('sha1').update(text).digest('hex').slice(0, 12);
  return `${readable}.${digest}`;
}

function emptyBoard() {
  return { version: 3, open: true, rect: null, view: { x: 0, y: 0, s: 1 }, bg: '', items: [] };
}

/** Coerce a stored document into the current shape; unknown fields are dropped. */
function normalizeBoard(raw) {
  const board = emptyBoard();
  if (raw === null || typeof raw !== 'object') return board;
  if (typeof raw.open === 'boolean') board.open = raw.open;
  if (typeof raw.bg === 'string') board.bg = raw.bg.slice(0, 32);
  const rect = raw.rect;
  if (rect !== null && typeof rect === 'object') {
    const number = (value, fallback) => (Number.isFinite(value) ? Math.round(value) : fallback);
    board.rect = {
      x: number(rect.x, 0),
      y: number(rect.y, 0),
      w: Math.max(240, number(rect.w, 420)),
      h: Math.max(160, number(rect.h, 320)),
    };
  }
  const view = raw.view;
  if (view !== null && typeof view === 'object') {
    board.view = {
      x: Number.isFinite(view.x) ? view.x : 0,
      y: Number.isFinite(view.y) ? view.y : 0,
      s: Math.min(8, Math.max(0.05, Number.isFinite(view.s) ? view.s : 1)),
    };
  }
  const items = Array.isArray(raw.items) ? raw.items : [];
  board.items = items
    .filter((item) => item !== null && typeof item === 'object')
    .slice(0, MAX_ITEMS)
    .map((item, index) => {
      const kind = item.kind === 'text' ? 'text' : 'image';
      const sized = Number.isFinite(item.x) && Number.isFinite(item.y) && item.w > 0 && item.h > 0;
      const place = sized
        ? { x: Math.round(item.x), y: Math.round(item.y) }
        : { x: 24 + (index % 4) * 264, y: 24 + Math.floor(index / 4) * 224 };
      const base = {
        id: typeof item.id === 'string' && item.id.length > 0 ? item.id : randomUUID(),
        kind,
        name: typeof item.name === 'string' ? item.name.slice(0, 200) : 'image',
        ...place,
        w: Math.max(40, Number.isFinite(item.w) ? Math.round(item.w) : 240),
        h: Math.max(30, Number.isFinite(item.h) ? Math.round(item.h) : 184),
        rot: Number.isFinite(item.rot) ? (Math.round(item.rot * 10) / 10) % 360 : 0,
        groupId: typeof item.groupId === 'string' && item.groupId.length > 0 ? item.groupId.slice(0, 64) : null,
        addedAt: Number.isFinite(item.addedAt) ? item.addedAt : Date.now(),
      };
      if (kind === 'text') {
        return {
          ...base,
          text: typeof item.text === 'string' ? item.text.slice(0, 4000) : '文字',
          fontSize: Math.max(8, Number.isFinite(item.fontSize) ? Math.round(item.fontSize) : 15),
          color: typeof item.color === 'string' ? item.color.slice(0, 32) : '',
        };
      }
      if (typeof item.path !== 'string' || item.path.length === 0) return null;
      // Only files this plugin copied into its own store may be referenced: an
      // imported project must not be able to point the image route anywhere else.
      let inside;
      try {
        inside = assertInsideRoot(item.path);
      } catch {
        return null;
      }
      return { ...base, path: inside };
    })
    .filter(Boolean);
  return board;
}

function boardFile(sessionId) {
  return join(boardRoot(), `${sessionSlug(sessionId)}.json`);
}

function sessionDir(sessionId) {
  return join(boardRoot(), sessionSlug(sessionId));
}

/** Reject any path outside the plugin's own storage root. */
function assertInsideRoot(candidate) {
  const root = resolve(boardRoot());
  const target = resolve(String(candidate ?? ''));
  const inside = relative(root, target);
  const escapes = inside.length === 0 || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside);
  if (escapes) {
    const error = new Error('path outside board storage');
    error.status = 403;
    throw error;
  }
  return target;
}

/**
 * The board routes are registered on the app's own origin, which is reachable
 * from any page in the same browser. Refuse cross-site requests so a random
 * website cannot rewrite or delete a board.
 */
function assertSameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'cross-site') {
    const error = new Error('cross-site request rejected');
    error.status = 403;
    throw error;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      host = '';
    }
    const allowed = String(req.headers.host ?? '');
    if (host.length === 0 || host.toLowerCase() !== allowed.toLowerCase()) {
      const error = new Error('cross-origin request rejected');
      error.status = 403;
      throw error;
    }
  }
}

/** JSON routes accept only JSON bodies, which no plain HTML form can send. */
function requireJsonContentType(req) {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/json')) {
    const error = new Error('expected application/json');
    error.status = 415;
    throw error;
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', String(body.length));
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function sendText(res, status, text) {
  const body = Buffer.from(String(text), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('content-length', String(body.length));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('invalid json body');
  }
}

/** Copy one uploaded image into the session directory and describe it. */
async function storeImage(sessionId, name, mediaType, bytes) {
  const dir = sessionDir(sessionId);
  await mkdir(dir, { recursive: true });
  const declared = EXT_OF_MEDIA[String(mediaType || '').split(';')[0].trim().toLowerCase()];
  const fromName = extname(String(name ?? '')).toLowerCase();
  const ext = declared ?? (MEDIA_TYPES[fromName] !== undefined ? fromName : '.png');
  const id = randomUUID();
  const target = join(dir, `${id}${ext}`);
  await writeFile(target, bytes);
  const cleanName = String(name ?? '').trim().replace(/[\\/:*?"<>|]+/g, '_') || `image${ext}`;
  return { id, path: target, name: cleanName, addedAt: Date.now() };
}

async function loadBoard(sessionId) {
  try {
    const raw = await readFile(boardFile(sessionId), 'utf8');
    return normalizeBoard(JSON.parse(raw));
  } catch {
    return emptyBoard();
  }
}

async function saveBoard(sessionId, board) {
  const target = boardFile(sessionId);
  await mkdir(boardRoot(), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(normalizeBoard(board), null, 2), 'utf8');
  await rename(temp, target);
}

/** Hand one path to Explorer with the item selected. */
function revealInExplorer(target) {
  const quoted = `"${String(target).replace(/"/g, '""')}"`;
  const child = spawn('explorer.exe', [`/select,${quoted}`], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  });
  child.unref();
}

function serveImage(res, candidate) {
  let target;
  try {
    target = assertInsideRoot(candidate);
  } catch {
    sendText(res, 403, 'forbidden');
    return Promise.resolve();
  }
  return stat(target).then((info) => {
    if (!info.isFile()) {
      sendText(res, 404, 'not a file');
      return;
    }
    const type = MEDIA_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('content-type', type);
    res.setHeader('content-length', String(info.size));
    res.setHeader('cache-control', 'private, max-age=31536000, immutable');
    res.setHeader('x-content-type-options', 'nosniff');
    // SVG is served from the same origin as the app: never let it run as a document.
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    createReadStream(target).pipe(res);
  }).catch(() => {
    sendText(res, 404, 'not found');
  });
}

/** One HTTP handler for every board endpoint. */
function createHandler() {
  return async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendText(res, 400, 'bad url');
      return;
    }
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/';
    const session = url.searchParams.get('session') ?? '';
    try {
      assertSameOrigin(req);
      if (route === '/ping') {
        sendJson(res, 200, { ok: true, root: boardRoot() });
        return;
      }
      if (route === '/debug' && req.method === 'GET') {
        sendJson(res, 200, { entries: DEBUG_RING.slice(-80) });
        return;
      }
      if (route === '/debug' && req.method === 'POST') {
        const body = await readJsonBody(req);
        let entry;
        try {
          entry = JSON.stringify(body ?? null).slice(0, 4000);
        } catch {
          entry = 'unserializable';
        }
        DEBUG_RING.push({ at: new Date().toISOString(), entry });
        if (DEBUG_RING.length > 200) DEBUG_RING.splice(0, DEBUG_RING.length - 200);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (route === '/state' && req.method === 'GET') {
        sendJson(res, 200, { board: await loadBoard(session) });
        return;
      }
      if (route === '/state' && req.method === 'POST') {
        requireJsonContentType(req);
        const body = await readJsonBody(req);
        const target = String(body?.session ?? '').trim();
        const board = body?.board;
        // A malformed save must never overwrite a stored board with an empty one.
        if (target.length === 0) {
          sendJson(res, 400, { error: 'session is required' });
          return;
        }
        if (board === null || typeof board !== 'object' || !Array.isArray(board.items)) {
          sendJson(res, 400, { error: 'board.items is required' });
          return;
        }
        await saveBoard(target, board);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (route === '/image' && req.method === 'GET') {
        await serveImage(res, url.searchParams.get('path') ?? '');
        return;
      }
      if (route === '/image' && req.method === 'POST') {
        if (session.trim().length === 0) {
          sendJson(res, 400, { error: 'session is required' });
          return;
        }
        const bytes = await readBody(req);
        if (bytes.length === 0) {
          sendJson(res, 400, { error: 'empty body' });
          return;
        }
        const item = await storeImage(session, url.searchParams.get('name') ?? '', req.headers['content-type'], bytes);
        sendJson(res, 200, { item });
        return;
      }
      if (route === '/export' && req.method === 'POST') {
        if (session.trim().length === 0) {
          sendJson(res, 400, { error: 'session is required' });
          return;
        }
        const bytes = await readBody(req);
        if (bytes.length === 0) {
          sendJson(res, 400, { error: 'empty body' });
          return;
        }
        if (bytes.length > MAX_EXPORT_BYTES) {
          sendJson(res, 413, { error: 'export too large' });
          return;
        }
        const dir = sessionDir(session);
        await mkdir(dir, { recursive: true });
        const raw = String(url.searchParams.get('name') ?? 'board.png').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
        const safe = /\.(png|jpe?g|json)$/i.test(raw) ? raw : `${raw}.png`;
        const target = join(dir, safe);
        await writeFile(target, bytes);
        sendJson(res, 200, { path: target, bytes: bytes.length });
        return;
      }
      if (route === '/remove' && req.method === 'POST') {
        requireJsonContentType(req);
        const body = await readJsonBody(req);
        const target = assertInsideRoot(String(body.path ?? ''));
        await rm(target, { force: true });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (route === '/reveal' && req.method === 'POST') {
        requireJsonContentType(req);
        const body = await readJsonBody(req);
        revealInExplorer(assertInsideRoot(String(body.path ?? '')));
        sendJson(res, 200, { ok: true });
        return;
      }
      sendText(res, 404, 'unknown route');
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

export const inject = ['webServer'];

/** Install the board HTTP prefix for the lifetime of this plugin. */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createHandler(),
      }),
    'session-ref-board routes',
  );
}
