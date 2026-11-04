// Offline runtime test for the board host half: drives the real HTTP handler.
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'refboard-home-'));
process.env.DSH_HOME = home;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href);

let route = null;
let disposed = 0;
const ctx = {
  effect(factory) {
    const dispose = factory();
    return () => {
      disposed += 1;
      if (typeof dispose === 'function') dispose();
    };
  },
  webServer: {
    register(spec) {
      route = spec;
      return () => {};
    },
  },
};

const effects = [];
const originalEffect = ctx.effect;
ctx.effect = (factory) => {
  const dispose = originalEffect(factory);
  effects.push(dispose);
  return dispose;
};

mod.apply(ctx);
check('apply registers a prefix route', route && route.kind === 'prefix' && route.path === '/session-ref-board');

const BASE = 'http://127.0.0.1/session-ref-board';

async function call(method, path, { body = null, type = null, headers = null } = {}) {
  const payload = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
  const req = Readable.from(payload ? [payload] : []);
  req.method = method;
  req.url = path;
  req.headers = {};
  if (headers) Object.assign(req.headers, headers);
  if (type) req.headers['content-type'] = type;
  if (payload) req.headers['content-length'] = String(payload.length);
  const chunks = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  const res = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value;
  };
  res.getHeader = (name) => res.headers[String(name).toLowerCase()];
  res.removeHeader = (name) => {
    delete res.headers[String(name).toLowerCase()];
  };
  Object.defineProperty(res, 'body', {
    get() {
      return Buffer.concat(chunks);
    },
  });
  void sink;
  await route.handler(req, res);
  if (!res.writableEnded) {
    await new Promise((resolve) => {
      res.once('finish', resolve);
      res.once('close', resolve);
    });
  }
  const text = res.body.toString('utf8');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* binary or plain text */
  }
  return { status: res.statusCode, headers: res.headers, text, json, bytes: res.body };
}

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !extra ? '' : ` — ${extra}`}`);
  if (!ok) failures += 1;
}

const ping = await call('GET', '/session-ref-board/ping');
check('GET /ping reports the store root', ping.json?.ok === true && ping.json.root === join(home, 'session-ref-board'), ping.text);

const session = 'session:with/slash 中文';
const imageBytes = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5ba0000000049454e44ae426082',
  'hex',
);

const up = await call('POST', `/session-ref-board/image?session=${encodeURIComponent(session)}&name=${encodeURIComponent('测试图.png')}`, {
  body: imageBytes,
  type: 'image/png',
});
check('POST /image stores bytes and returns an item', up.status === 200 && up.json?.item?.id && up.json.item.name === '测试图.png', up.text);
check('stored image lands inside the session directory', existsSync(up.json.item.path) && up.json.item.path.includes('session-ref-board'), up.json?.item?.path);

const fetched = await call('GET', `/session-ref-board/image?path=${encodeURIComponent(up.json.item.path)}`);
check('GET /image serves the stored bytes', fetched.status === 200 && fetched.bytes.length === imageBytes.length && fetched.headers['content-type'] === 'image/png');

const escape = await call('GET', `/session-ref-board/image?path=${encodeURIComponent('C:/Windows/win.ini')}`);
check('GET /image refuses a path outside the store', escape.status === 403, String(escape.status));

const board = {
  open: true,
  view: { x: -120.5, y: 44.25, s: 1.25 },
  bg: '#26262b',
  items: [
    { id: 'img-1', kind: 'image', path: up.json.item.path, name: '测试图.png', x: 10, y: 20, w: 300, h: 200, rot: 372.34, groupId: 'g1', addedAt: 1 },
    { id: 'txt-1', kind: 'text', text: '第一行\n第二行', fontSize: 18, color: '#ff8800', x: 400, y: 60, w: 200, h: 60 },
    { id: 'broken', kind: 'image', name: 'no-path', x: 0, y: 0, w: 10, h: 10 },
  ],
};
const saved = await call('POST', '/session-ref-board/state', { body: { session, board }, type: 'application/json' });
check('POST /state accepts a v3 board', saved.json?.ok === true, saved.text);

const loaded = await call('GET', `/session-ref-board/state?session=${encodeURIComponent(session)}`);
const stored = loaded.json?.board;
check('GET /state returns version 3', stored?.version === 3, String(stored?.version));
check('view keeps sub-pixel translation and zoom', stored?.view?.x === -120.5 && stored?.view?.y === 44.25 && stored?.view?.s === 1.25, JSON.stringify(stored?.view));
check('canvas background survives', stored?.bg === '#26262b', stored?.bg);
check('image item keeps rot modulo 360 / groupId', stored?.items?.[0]?.rot === 12.3 && stored?.items?.[0]?.groupId === 'g1', JSON.stringify(stored?.items?.[0]));
check('text item keeps text/fontSize/color', stored?.items?.[1]?.kind === 'text' && stored?.items?.[1]?.text === '第一行\n第二行' && stored?.items?.[1]?.fontSize === 18, JSON.stringify(stored?.items?.[1]));
check('item without a path is dropped', stored?.items?.length === 2, String(stored?.items?.length));

const zoomClamp = await call('POST', '/session-ref-board/state', { body: { session, board: { ...board, view: { x: 0, y: 0, s: 99 } } }, type: 'application/json' });
const clamped = await call('GET', `/session-ref-board/state?session=${encodeURIComponent(session)}`);
check('zoom is clamped into [0.05, 8]', clamped.json?.board?.view?.s === 8, String(clamped.json?.board?.view?.s));

const exported = await call('POST', `/session-ref-board/export?session=${encodeURIComponent(session)}&name=proj-test.json`, {
  body: Buffer.from('{"hello":"world"}', 'utf8'),
  type: 'application/json',
});
check('POST /export writes a .json project beside the images', exported.json?.path?.endsWith('proj-test.json') && existsSync(exported.json.path), exported.text);
check('exported project content round-trips', exported.json ? readFileSync(exported.json.path, 'utf8') === '{"hello":"world"}' : false);

const png = await call('POST', `/session-ref-board/export?session=${encodeURIComponent(session)}&name=board-1`, { body: imageBytes, type: 'image/png' });
check('POST /export appends .png when the name omits it', png.json?.path?.endsWith('.png'), png.text);

const jpg = await call('POST', `/session-ref-board/export?session=${encodeURIComponent(session)}&name=shot.jpg`, { body: imageBytes, type: 'image/jpeg' });
check('POST /export keeps a .jpg name', jpg.json?.path?.endsWith('shot.jpg') && existsSync(jpg.json.path), jpg.text);
const reveal = await call('POST', '/session-ref-board/reveal', { body: { path: up.json.item.path }, type: 'application/json' });
check('POST /reveal accepts a stored path', reveal.json?.ok === true, reveal.text);
const revealEscape = await call('POST', '/session-ref-board/reveal', { body: { path: 'C:/Windows/win.ini' }, type: 'application/json' });
check('POST /reveal refuses an outside path', revealEscape.status === 403, String(revealEscape.status));

const removed = await call('POST', '/session-ref-board/remove', { body: { path: up.json.item.path }, type: 'application/json' });
check('POST /remove deletes the stored copy', removed.json?.ok === true && !existsSync(up.json.item.path));

// A malformed save must not be able to wipe a stored board.
const noBoard = await call('POST', '/session-ref-board/state', { body: { session }, type: 'application/json' });
check('POST /state without a board answers 400', noBoard.status === 400, noBoard.text);
const noSession = await call('POST', '/session-ref-board/state', { body: { board }, type: 'application/json' });
check('POST /state without a session answers 400', noSession.status === 400, noSession.text);
const stillThere = await call('GET', `/session-ref-board/state?session=${encodeURIComponent(session)}`);
check('the stored board survived the rejected saves', stillThere.json?.board?.items?.length === 2, String(stillThere.json?.board?.items?.length));

const debugPost = await call('POST', '/session-ref-board/debug', { body: { kind: 'probe', detail: { x: 1 } }, type: 'application/json' });
const debugGet = await call('GET', '/session-ref-board/debug');
check('POST /debug is readable back from GET /debug', debugPost.json?.ok === true && typeof debugGet.json?.entries?.at(-1)?.entry === 'string', JSON.stringify(debugGet.json?.entries?.at(-1)));

const unknown = await call('GET', '/session-ref-board/nope');
check('unknown route answers 404', unknown.status === 404);

/* ---- security guards ---- */
const crossSite = await call('POST', '/session-ref-board/state', {
  body: { session, board },
  type: 'application/json',
  headers: { 'sec-fetch-site': 'cross-site' },
});
check('a cross-site save is rejected', crossSite.status === 403, crossSite.text);

const crossOrigin = await call('POST', '/session-ref-board/state', {
  body: { session, board },
  type: 'application/json',
  headers: { origin: 'https://evil.example', host: '127.0.0.1:1' },
});
check('a cross-origin save is rejected', crossOrigin.status === 403, crossOrigin.text);

const sameOrigin = await call('POST', '/session-ref-board/state', {
  body: { session, board },
  type: 'application/json',
  headers: { origin: 'http://127.0.0.1:1', host: '127.0.0.1:1' },
});
check('a same-origin save still succeeds', sameOrigin.json?.ok === true, sameOrigin.text);

const formPost = await call('POST', '/session-ref-board/state', { body: { session, board }, type: 'text/plain' });
check('a non-JSON save is rejected with 415', formPost.status === 415, formPost.text);

const traversal = await call('GET', `/session-ref-board/image?path=${encodeURIComponent('../../../Windows/win.ini')}`);
check('path traversal is refused', traversal.status === 403, `${traversal.status} ${traversal.text}`);

const traversal2 = await call('POST', '/session-ref-board/remove', {
  body: { path: `${join(home, '..', '..', 'Windows', 'win.ini')}` },
  type: 'application/json',
});
check('remove refuses paths outside the store', traversal2.status === 403, traversal2.text);

const noSessionUpload = await call('POST', '/session-ref-board/image?name=x.png', { body: imageBytes, type: 'image/png' });
check('an upload without a session answers 400', noSessionUpload.status === 400, noSessionUpload.text);

const svgHeader = await call('GET', `/session-ref-board/image?path=${encodeURIComponent(png.json.path)}`);
check('served files carry nosniff and the sandbox policy', svgHeader.headers['x-content-type-options'] === 'nosniff' && String(svgHeader.headers['content-security-policy']).includes('sandbox'), JSON.stringify(svgHeader.headers));

const foreignItem = await call('POST', '/session-ref-board/state', {
  body: {
    session,
    board: {
      items: [{ kind: 'image', name: 'x.png', x: 0, y: 0, w: 100, h: 80, path: 'C:/Windows/win.ini' }],
    },
  },
  type: 'application/json',
});
const foreignBoard = await call('GET', `/session-ref-board/state?session=${encodeURIComponent(session)}`);
check('a stored item outside the store is dropped', foreignItem.json?.ok === true && foreignBoard.json?.board?.items?.length === 0, JSON.stringify(foreignBoard.json?.board?.items));



for (const dispose of effects) dispose();
check('disposers run without throwing', disposed === effects.length, `${disposed}/${effects.length}`);

rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL HOST CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
if (failures > 0) process.exitCode = 1;
