// Mount the board with real React so render-time crashes surface without restarting the app.
const path = require('node:path');
const fs = require('node:fs');

const React = require('react');
const ReactDOMServer = require('react-dom/server');

const source = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');

let captured = null;
const styleTags = [];
const listeners = new Map();

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    children: [],
    style: {},
    dataset: {},
    files: [],
    attributes: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) { this.children = this.children.filter((entry) => entry !== child); return child; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 10, top: 20, right: 810, bottom: 620, width: 800, height: 600, x: 10, y: 20 }; },
    closest() { return null; },
    focus() {},
    click() {},
    showPicker() {},
    load() {},
    decode: async () => {},
  };
  Object.defineProperty(el, 'innerHTML', { get: () => '', set: () => {} });
  return el;
}

const head = makeEl('head');
const body = makeEl('body');
const doc = {
  head,
  body,
  documentElement: makeEl('html'),
  createElement: (tag) => makeEl(tag),
  createElementNS: (_ns, tag) => makeEl(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: (type, handler) => {
    const list = listeners.get(type) ?? [];
    list.push(handler);
    listeners.set(type, list);
  },
  removeEventListener: (type, handler) => {
    listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== handler));
  },
  getElementById: () => null,
};

global.window = {
  innerWidth: 1600,
  innerHeight: 960,
  devicePixelRatio: 1,
  document: doc,
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: clearTimeout,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' },
  navigator: { clipboard: { read: async () => [] }, userAgent: 'node' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
};
global.document = doc;
global.navigator = window.navigator;
global.Element = class Element {};
global.HTMLElement = class HTMLElement extends Element {};
global.Node = class Node {};
global.Image = class Image {
  constructor() {
    this.decode = async () => {};
  }
  addEventListener() {}
};
global.URL = URL;
global.Blob = Blob;
global.File = class File extends Blob {
  constructor(parts, name, options) {
    super(parts, options);
    this.name = name;
  }
};
global.FormData = FormData;
global.AbortController = AbortController;
global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
global.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
global.requestAnimationFrame = window.requestAnimationFrame;
global.cancelAnimationFrame = window.cancelAnimationFrame;
global.performance = { now: () => Date.now() };

global.document.head.appendChild = (tag) => {
  styleTags.push(tag);
  return tag;
};

window.__ModuleLoader__ = {
  load: ({ id, factory }) => {
    captured = { id, module: factory((name) => (name === 'react' ? React : {})) };
  },
};

const __eval = new Function('window', 'document', 'navigator', 'HTMLElement', 'Element', 'Image', 'fetch', 'React', source);
__eval(global.window, global.document, global.navigator, global.HTMLElement, global.Element, global.Image, global.fetch, React);

if (!captured) {
  console.log('FAIL factory never ran');
  process.exit(1);
}

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
            getSnapshot: () => ({
              key: 'session-probe',
              props: { inputActions: { addAttachments() {}, captureInsertion: () => ({}), insertText() {}, submit() {} } },
            }),
            subscribe: () => () => {},
          },
        },
      };
    }
    if (name === 'conversation') return { createDrafts: () => [] };
    return undefined;
  },
  effect: (factory) => {
    const dispose = factory();
    return dispose;
  },
  on: () => () => {},
  slots: {
    inject: (_key, callback) => callback(),
    register: (options, component) => {
      registered.push({ options, component });
      return () => {};
    },
    registerFactory: () => () => {},
  },
};

captured.module.apply(ctx);
check('module id is the package name', captured.id === '@local/session-ref-board', captured.id);
check('exactly one slot registered (the Conversation tab)', registered.length === 1, String(registered.length));

const session = {
  sessionId: 'session-probe',
  inputActions: { addAttachments() {}, captureInsertion: () => ({}), insertText() {}, submit() {} },
};

for (const { options, component } of registered) {
  const props = options.name === 'conversation.view' ? session : {};
  try {
    const html = ReactDOMServer.renderToStaticMarkup(React.createElement(component, props));
    check(`${options.name} renders without throwing`, true);
    console.log(`  info  ${options.name} first paint: ${html.length === 0 ? 'empty (board loads async)' : `${html.length} chars`}`);
  } catch (error) {
    check(`${options.name} renders without throwing`, false, `${error.name}: ${error.message}\n${String(error.stack).split('\n').slice(0, 6).join('\n')}`);
  }
}

const crashes = [];
for (const tag of styleTags) void tag;
console.log(failures === 0 ? '\nALL MOUNT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
if (failures > 0) process.exitCode = 1;
