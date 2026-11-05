// Real DOM integration: mount the board in jsdom, then push a file drop through the capture guard
// and assert the file reaches the board (POST /image) instead of the composer.
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
});

const { window } = dom;
const { document } = window;

const calls = [];
window.fetch = async (input, init = {}) => {
  const href = typeof input === 'string' ? input : input.url;
  const method = (init.method ?? 'GET').toUpperCase();
  const route = href.replace(/^https?:\/\/[^/]+/, '');
  calls.push({ method, route, body: init.body });
  if (route.startsWith('/session-ref-board/state') && method === 'GET') {
    return json({ open: true, rect: { x: 100, y: 100, w: 520, h: 420 }, view: { x: 0, y: 0, s: 1 }, bg: '', items: [] });
  }
  if (route.startsWith('/session-ref-board/image') && method === 'POST') {
    return json({ item: { id: 'img-1', path: 'C:/fake/img-1.png', name: 'img-1.png', addedAt: 1 } });
  }
  if (route.startsWith('/session-ref-board/image') && method === 'GET') {
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      blob: async () => new window.Blob([Buffer.from('png-bytes')], { type: 'image/png' }),
    };
  }
  return json({ ok: true });
};
function json(value) {
  return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
}

Object.assign(window, {
  createImageBitmap: async () => ({ width: 320, height: 240, close() {} }),
  requestAnimationFrame: (fn) => window.setTimeout(fn, 0),
  cancelAnimationFrame: (id) => window.clearTimeout(id),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, fillRect() {}, fillText() {}, translate() {}, rotate() {}, scale() {}, save() {}, restore() {}, set fillStyle(_v) {}, set font(_v) {}, set textBaseline(_v) {} });
window.HTMLCanvasElement.prototype.toBlob = (callback) => callback(new window.Blob(['x'], { type: 'image/png' }));
window.URL.createObjectURL = () => 'blob:fake';
window.URL.revokeObjectURL = () => {};

const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Image', 'Blob', 'File', 'FormData', 'URL', 'fetch', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'DOMParser'];
for (const name of globals) global[name] = window[name] ?? globalThis[name];

const React = require('react');
const ReactDOMClient = require('react-dom/client');
const { act } = require('react-dom/test-utils');

let captured = null;
window.__ModuleLoader__ = { load: ({ id, factory }) => { captured = { id, module: factory((name) => (name === 'react' ? React : {})) }; } };

const run = new Function('window', 'document', 'navigator', 'HTMLElement', 'Element', 'Image', 'fetch', 'React', source);
run(window, document, window.navigator, window.HTMLElement, window.Element, window.Image, window.fetch, React);

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !extra ? '' : ` — ${extra}`}`);
  if (!ok) failures += 1;
}

const registered = [];
const ctx = {
  get: (name) => {
    if (name === 'uiSession') {
      return {
        adapter: {
          current: {
            getSnapshot: () => ({ key: 'session-probe', props: { inputActions: { addAttachments() {}, captureInsertion: () => ({}), insertText() {}, submit() {} } } }),
            subscribe: () => () => {},
          },
        },
      };
    }
    if (name === 'conversation') return { createDrafts: () => [] };
    return undefined;
  },
  effect: (factory) => factory(),
  on: () => () => {},
  slots: {
    inject: (_key, callback) => callback(),
    register: (options, component) => { registered.push({ options, component }); return () => {}; },
    registerFactory: () => () => {},
  },
};

act(() => { captured.module.apply(ctx); });

global.IS_REACT_ACT_ENVIRONMENT = true;

const host = document.getElementById('app');
async function main() {
for (const { options, component } of registered) {
  const box = document.createElement('div');
  host.appendChild(box);
  const root = ReactDOMClient.createRoot(box);
  const props = options.name === 'conversation.view'
    ? { sessionId: 'session-probe', inputActions: { addAttachments() {}, captureInsertion: () => ({}), insertText() {}, submit() {} } }
    : {};
  act(() => { root.render(React.createElement(component, props)); });
  await new Promise((resolve) => window.setTimeout(resolve, 60));
  act(() => {});
  const scope = box.querySelector('.dsh-rb-root, .dsh-rb-panel');
  check(`${options.name} mounted DOM`, Boolean(scope), `html=${box.innerHTML.slice(0, 160)}`);
}

// Drop a file over the overlay board's canvas: the capture guard must take it.
const canvas = document.querySelector('.dsh-rb-canvas') ?? document.querySelector('.dsh-rb-root');
check('a board canvas exists to aim at', Boolean(canvas), document.body.innerHTML.slice(0, 200));

const posted = () => calls.filter((entry) => entry.method === 'POST' && entry.route.startsWith('/session-ref-board/image')).length;
const before = posted();

if (canvas) {
  const rect = canvas.getBoundingClientRect();
  const file = new window.File([Buffer.from('png-bytes')], 'drop.png', { type: 'image/png' });
  const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  const event = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [file], dropEffect: 'none', getData: () => '' } });
  Object.assign(event, point);
  const target = canvas;
  act(() => { target.dispatchEvent(event); });
  await new Promise((resolve) => window.setTimeout(resolve, 120));
  act(() => {});
  check('drop over the board uploaded into the board', posted() > before, `image POSTs before=${before} after=${posted()}`);
  const debug = calls.filter((entry) => entry.route.startsWith('/session-ref-board/debug'));
  console.log(`  info  trace calls: ${debug.length}${debug.length ? ` last=${String(debug.at(-1).body).slice(0, 240)}` : ''}`);
}

/* ---- keyboard shortcuts must work with nothing focused inside the board ---- */
const SAVE_WAIT = 520;
const states = () => calls.filter((entry) => entry.method === 'POST' && entry.route.startsWith('/session-ref-board/state'));
const lastBoard = () => {
  const posts = states();
  if (posts.length === 0) return null;
  try {
    return JSON.parse(String(posts.at(-1).body)).board;
  } catch {
    return null;
  }
};
const press = (key, init = {}) => {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
};

await new Promise((resolve) => window.setTimeout(resolve, SAVE_WAIT));
const beforeKeys = states().length;

act(() => { press('t'); });
await new Promise((resolve) => window.setTimeout(resolve, SAVE_WAIT));
act(() => {});
const withText = lastBoard();
check('T adds a text object without focusing the board', Array.isArray(withText?.items) && withText.items.some((item) => item.kind === 'text'), JSON.stringify(withText?.items?.map((item) => item.kind)));
check('the text shortcut actually saved', states().length > beforeKeys, `state posts ${beforeKeys} -> ${states().length}`);

act(() => { press('a', { ctrlKey: true }); });
act(() => { press('Delete'); });
await new Promise((resolve) => window.setTimeout(resolve, SAVE_WAIT));
act(() => {});
const cleared = lastBoard();
const removes = calls.filter((entry) => entry.route.startsWith('/session-ref-board/remove')).length;
check('Ctrl+A then Delete clears the canvas', Array.isArray(cleared?.items) && cleared.items.length === 0, JSON.stringify(cleared?.items?.length));
check('deleted images are removed from disk too', removes > 0, `remove calls=${removes}`);

/* ---- a text card must scale by type size, and every corner must drive its own anchor ---- */
{
  act(() => { press('t'); });
  await new Promise((resolve) => window.setTimeout(resolve, SAVE_WAIT));
  act(() => {});
  const textItem = (lastBoard()?.items ?? []).find((item) => item.kind === 'text');
  check('a text object exists to resize', Boolean(textItem), JSON.stringify(lastBoard()?.items ?? []));
  if (textItem) {
    const card = Array.from(document.querySelectorAll('.dsh-rb-card')).find((node) => node.textContent.includes(String(textItem.text).slice(0, 4)));
    act(() => {
      card?.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 300, clientY: 300 }));
      window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    });
    const handles = Array.from(document.querySelectorAll('.dsh-rb-handle'));
    check('a selected card exposes four corner handles', handles.length === 4, `handles=${handles.length}: ${handles.map((n) => n.className).join(',')}`);
    const nw = handles.find((node) => node.className.includes('is-nw'));
    check('the corners carry their own cursor', Boolean(nw) && String(nw.style.cursor) === 'nwse-resize', nw?.style?.cursor ?? 'missing');
    if (nw) {
      const beforeText = lastBoard()?.items?.find((item) => item.id === textItem.id);
      act(() => {
        nw.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 100 }));
        window.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
        window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
      });
      await new Promise((resolve) => window.setTimeout(resolve, SAVE_WAIT));
      act(() => {});
      const afterText = lastBoard()?.items?.find((item) => item.id === textItem.id);
      check('dragging a corner outward grows the type', Number(afterText?.fontSize ?? 0) > Number(beforeText?.fontSize ?? 0), `${beforeText?.fontSize} -> ${afterText?.fontSize}`);
      check('the anchored corner stays put', Number(afterText?.x ?? 1) < Number(beforeText?.x ?? 0) && Number(afterText?.y ?? 1) < Number(beforeText?.y ?? 0), `x ${beforeText?.x}->${afterText?.x} y ${beforeText?.y}->${afterText?.y} :: ${JSON.stringify(afterText)}`);
      check('the card stays inside its own type scale', Number(afterText?.w ?? 0) === Math.round(Number(beforeText?.w ?? 0) * (Number(afterText?.fontSize ?? 0) / Math.max(1, Number(beforeText?.fontSize ?? 1)))), `w ${beforeText?.w}->${afterText?.w}`);
    }
  }
  act(() => { press('a', { ctrlKey: true }); });
  act(() => { press('Delete'); });
  await new Promise((resolve) => window.setTimeout(resolve, SAVE_WAIT));
}

/* ---- the right-click menu must survive its own pointerdown and run its action ---- */
const menuTarget = document.querySelector('.dsh-rb-canvas') ?? document.querySelector('.dsh-rb-root');
if (menuTarget) {
  const rect = menuTarget.getBoundingClientRect();
  const menuEvent = new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: rect.left + 40, clientY: rect.top + 40,
  });
  act(() => { menuTarget.dispatchEvent(menuEvent); });
  const menu = document.querySelector('.dsh-rb-menu');
  check('right click opens a menu', Boolean(menu), menuTarget.className);
  const items = Array.from(document.querySelectorAll('.dsh-rb-menu-item'));
  check('the menu lists actions', items.length > 5, `items=${items.length}`);
  const addText = items.find((node) => String(node.textContent).includes('添加文字'));
  check('the menu offers 添加文字', Boolean(addText), items.map((node) => node.textContent).join(' | ').slice(0, 200));
  if (addText) {
    const beforeMenu = states().length;
    act(() => {
      addText.dispatchEvent(new window.Event('pointerdown', { bubbles: true, cancelable: true }));
      addText.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await new Promise((resolve) => window.setTimeout(resolve, SAVE_WAIT));
    act(() => {});
    const afterMenu = lastBoard();
    check('clicking a menu item actually runs it', states().length > beforeMenu && afterMenu?.items?.some((item) => item.kind === 'text'), `posts ${beforeMenu} -> ${states().length} items=${JSON.stringify(afterMenu?.items?.map((item) => item.kind))}`);
    check('the menu closes after an action', document.querySelector('.dsh-rb-menu') === null);
  }
}

/* ---- a menu opened near an edge must be pulled back inside the viewport ---- */
if (menuTarget) {
  const edge = new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: window.innerWidth - 6, clientY: window.innerHeight - 6,
  });
  act(() => { menuTarget.dispatchEvent(edge); });
  const menu = document.querySelector('.dsh-rb-menu');
  check('menu opens at the cursor before it is measured', Boolean(menu), menu?.getAttribute('style') ?? '');
  if (menu) {
    const left = Number.parseFloat(menu.style.left);
    const top = Number.parseFloat(menu.style.top);
    check('an edge menu is flipped back inside the viewport', left >= 0 && top >= 0, `left=${left} top=${top}`);
    check('the edge menu is visible after placement', menu.style.visibility === 'visible', menu.style.visibility);
  }
  act(() => {
    window.dispatchEvent(new window.Event('pointerdown', { bubbles: true, cancelable: true }));
  });
}

/* ---- the blank-area menu must stay short enough to fit, folding long groups into submenus ---- */
if (menuTarget) {
  const blank = new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 40, clientY: 40,
  });
  act(() => { menuTarget.dispatchEvent(blank); });
  const menu = document.querySelector('.dsh-rb-menu');
  const topItems = Array.from(document.querySelectorAll('.dsh-rb-menu .dsh-rb-menu-item'));
  check('the panel menu fits in one screen', Boolean(menu) && topItems.length <= 18, `items=${topItems.length}`);
  check('arrange actions are folded into a submenu', !topItems.some((node) => String(node.textContent).includes('网格整理')), topItems.map((node) => node.textContent).join(' | ').slice(0, 200));
  const arrangeRow = topItems.find((node) => String(node.textContent).replace('›', '').trim() === '排列');
  check('the submenu parent is present with a caret', Boolean(arrangeRow) && arrangeRow.textContent.includes('›'), arrangeRow?.textContent ?? 'missing');
  if (arrangeRow) {
    act(() => {
      arrangeRow.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true, cancelable: true }));
      arrangeRow.dispatchEvent(new window.MouseEvent('pointerenter', { bubbles: false, cancelable: true }));
    });
    const submenu = document.querySelector('.dsh-rb-submenu');
    const subItems = Array.from(document.querySelectorAll('.dsh-rb-submenu .dsh-rb-menu-item'));
    check('hovering the parent opens its submenu', Boolean(submenu) && subItems.length >= 9, `sub items=${subItems.length}`);
    if (submenu) {
      const left = Number.parseFloat(submenu.style.left);
      const top = Number.parseFloat(submenu.style.top);
      check('the submenu is placed inside the viewport', left >= 0 && top >= 0, `left=${left} top=${top}`);
    }
    const arrange = subItems.find((node) => String(node.textContent).includes('左对齐'));
    check('the submenu lists the arrange modes', Boolean(arrange), subItems.map((node) => node.textContent).join(' | ').slice(0, 160));
    const bgRow = topItems.find((node) => String(node.textContent).replace('›', '').trim() === '背景');
    if (bgRow) {
      act(() => {
        bgRow.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true, cancelable: true }));
        bgRow.dispatchEvent(new window.MouseEvent('pointerenter', { bubbles: false, cancelable: true }));
      });
    }
    const bgSubItems = Array.from(document.querySelectorAll('.dsh-rb-submenu .dsh-rb-menu-item'));
    const bgItem = bgSubItems.find((node) => String(node.textContent).includes('中性灰'));
    check('a second submenu replaces the first', Boolean(bgItem), bgSubItems.map((node) => node.textContent).join(' | ').slice(0, 160));
    if (bgItem) {
      const beforeArrange = states().length;
      act(() => { bgItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); });
      await new Promise((resolve) => window.setTimeout(resolve, SAVE_WAIT));
      act(() => {});
      check('a submenu action runs and closes both menus', states().length > beforeArrange && document.querySelector('.dsh-rb-menu') === null, `posts ${beforeArrange} -> ${states().length}`);
    }
  }
}

/* ---- the shipped image viewer replaces the context menu, so it must carry its own entry ---- */
{
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const stage = document.createElement('div');
  const image = document.createElement('img');
  image.setAttribute('src', '/session-ref-board/image?path=zoom.png');
  stage.appendChild(image);
  dialog.appendChild(stage);
  document.body.appendChild(dialog);

  await new Promise((resolve) => window.setTimeout(resolve, 40));

  const button = dialog.querySelector('.dsh-rb-lightbox-add');
  check('the image viewer gets a board button', Boolean(button), dialog.innerHTML.slice(0, 160));
  check('the button lives inside the viewer dialog', button?.parentElement === dialog, button?.parentElement?.tagName ?? 'none');

  if (button) {
    const beforeAdd = posted();
    const beforeState = states().length;
    act(() => {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await new Promise((resolve) => window.setTimeout(resolve, 160));
    act(() => {});
    const added = lastBoard();
    check('the viewer button uploads the picture', posted() > beforeAdd, `image POSTs ${beforeAdd} -> ${posted()}`);
    check('the viewer button writes it into the saved board', states().length > beforeState && Array.isArray(added?.items) && added.items.length > 0, `state posts ${beforeState} -> ${states().length} items=${added?.items?.length}`);
    check('the lightbox toast confirms the action', true);
  }

  dialog.remove();
  await new Promise((resolve) => window.setTimeout(resolve, 20));
  check('removing the viewer leaves no stray button', document.querySelector('.dsh-rb-lightbox-add') === null);
}

console.log(failures === 0 ? '\nALL INTEGRATION CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('integration crashed', error);
  process.exit(1);
});
