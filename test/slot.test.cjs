/**
 * Strict-Cordis verification for the session-ref-board client half.
 *
 * The real Cordis Context cannot be instantiated outside the running app
 * (cordis is vendored into the app bundle, no standalone package on disk), so
 * this harness reproduces the one behaviour that broke activation twice:
 * reading a service property that is not declared in `inject` throws
 * `cannot get property "x" without inject`, and optional chaining does not help.
 */
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'client.js');
const source = fs.readFileSync(FILE, 'utf8');

/* --------------------------- DOM / module stubs --------------------------- */

let loadedModule = null;
const styleTags = [];
const listeners = [];

const documentStub = {
  head: {
    appendChild(node) { styleTags.push(node); node.parentNode = documentStub.head; },
    removeChild(node) { const i = styleTags.indexOf(node); if (i >= 0) styleTags.splice(i, 1); },
  },
  body: { appendChild() {}, removeChild() {} },
  createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      parentNode: null,
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      appendChild() {},
      removeChild() {},
      textContent: '',
    };
  },
  addEventListener(type, fn) { listeners.push([type, fn]); },
  removeEventListener(type, fn) {
    const i = listeners.findIndex((entry) => entry[0] === type && entry[1] === fn);
    if (i >= 0) listeners.splice(i, 1);
  },
  querySelectorAll() { return []; },
  querySelector() { return null; },
};

const windowStub = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  addEventListener() {},
  removeEventListener() {},
  devicePixelRatio: 1,
  innerWidth: 1280,
  innerHeight: 800,
  __ModuleLoader__: {
    load(mod) { loadedModule = mod; },
  },
};

const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  Component: class { constructor(props) { this.props = props; this.state = {}; } setState(next) { Object.assign(this.state, next); } },
  Fragment: 'Fragment',
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
};

globalThis.window = windowStub;
globalThis.document = documentStub;
globalThis.navigator = { clipboard: null };
globalThis.HTMLElement = class {};
globalThis.fetch = async () => { throw new Error('network disabled in harness'); };

/* ------------------------------ Cordis model ------------------------------ */

const CORE_API = new Set([
  'effect', 'get', 'on', 'once', 'provide', 'set', 'plugin', 'inject', 'emit',
  'bail', 'serial', 'waterfall', 'parallel', 'ctx', 'root', 'registry', 'scope',
  'fiber', 'name', 'dispose', 'options', 'extend', 'isolate',
]);

/**
 * Mirrors Cordis service proxies: a service that is not listed in `inject`
 * throws on property read; `ctx.get(name)` never throws and returns undefined.
 */
function makeStrictCtx(services, injected) {
  const effects = [];
  const base = {
    effect(callback, label) {
      const result = callback();
      effects.push([label, typeof result]);
      return result;
    },
    get(name) {
      return services[name];
    },
    provide() {},
    on() {},
    set() {},
    extend() { return this; },
    isolate() { return this; },
  };

  const proxy = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (injected.includes(prop)) return services[prop];
      if (typeof prop === 'symbol') return undefined;
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
    has(target, prop) {
      return prop in target || injected.includes(prop);
    },
  });

  return { ctx: proxy, effects };
}

/* -------------------------------- run it --------------------------------- */

const registered = [];
const slots = {
  inject(key, callback) {
    const disposer = callback();
    return () => { if (typeof disposer === 'function') disposer(); };
  },
  register(options, component) {
    registered.push({ options, component });
    if (typeof options?.id !== 'string' || options.id === '') {
      throw new Error('slot registration without an id');
    }
    return () => {};
  },
  registerFactory(options, component) { return slots.register(options, component); },
};

const plugin = (() => {
  const requireStub = (name) => {
    if (name === 'react') return ReactStub;
    throw new Error(`unexpected require: ${name}`);
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'require', 'navigator', 'HTMLElement', source)(
    windowStub, documentStub, requireStub, globalThis.navigator, globalThis.HTMLElement,
  );
  if (!loadedModule) throw new Error('module never registered with __ModuleLoader__');
  return loadedModule;
})();

const failures = [];
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); } catch (error) { failures.push(`${label}: ${error.message}`); console.log(`  FAIL ${label}: ${error.message}`); }
};

console.log(`module id  = ${plugin.id}`);
console.log(`factory    = ${typeof plugin.factory}`);

const moduleExports = (() => {
  const exp = plugin.factory((name) => {
    if (name === 'react') return ReactStub;
    throw new Error(`unexpected require: ${name}`);
  });
  return exp;
})();

console.log(`inject     = ${JSON.stringify(moduleExports.inject)}`);

const { ctx, effects } = makeStrictCtx({ slots }, moduleExports.inject);
let disposeAll = null;

check('apply() completes against a strict context', () => {
  moduleExports.apply(ctx);
});

check('every apply effect returned a disposer', () => {
  const usable = effects.filter(([, kind]) => kind === 'function');
  if (effects.length < 3) throw new Error(`only ${effects.length} effects: ${JSON.stringify(effects)}`);
  if (usable.length !== effects.length) throw new Error(`non-disposable effect: ${JSON.stringify(effects)}`);
});

check('no floating overlay entry: the board lives in its Conversation tab only', () => {
  const hit = registered.find((entry) => entry.options.name === 'shell.overlay');
  if (hit) throw new Error(`overlay still registered: ${JSON.stringify(hit.options)}`);
  if (registered.length !== 1) throw new Error(`expected 1 registration, got ${registered.length}`);
});

check('view slot registered on conversation.view with the Chinese label intact', () => {
  const hit = registered.find((entry) => entry.options.name === 'conversation.view');
  if (!hit) throw new Error(`missing: ${JSON.stringify(registered.map((r) => r.options))}`);
  if (hit.options.label !== '图片集') throw new Error(`label=${JSON.stringify(hit.options.label)}`);
  if (hit.options.order !== 40) throw new Error(`order=${hit.options.order}`);
});

check('styles effect survived: ctx.get("styles") is absent yet activation continued', () => {
  const stylesEffect = effects.find(([label]) => /styles/i.test(label));
  if (!stylesEffect) throw new Error(`no styles effect: ${JSON.stringify(effects)}`);
  if (stylesEffect[1] !== 'function') throw new Error('styles effect returned no disposer');
});

check('negative control: reading ctx.styles throws exactly like Cordis', () => {
  let message = '';
  try { void ctx.styles; } catch (error) { message = error.message; }
  if (!/without inject/.test(message)) throw new Error(`unexpected: ${message || 'no throw'}`);
});

check('CSS was installed (real <style> fallback, since styles service is absent)', () => {
  if (styleTags.length !== 1) throw new Error(`style tags = ${styleTags.length}`);
  if (styleTags[0].attributes['data-plugin-css'] !== 'session-ref-board') {
    throw new Error(`attr=${JSON.stringify(styleTags[0].attributes)}`);
  }
  if (!styleTags[0].textContent.includes('.dsh-rb-panel-inline')) throw new Error('view CSS missing');
});

check('contextmenu listener attached once', () => {
  const hits = listeners.filter(([type]) => type === 'contextmenu');
  if (hits.length !== 1) throw new Error(`listeners = ${hits.length}`);
});

check('inline view CSS outranks the floating panel chrome (no border, no shadow)', () => {
  const css = styleTags[0].textContent;
  if (!css.includes('.dsh-rb-panel.dsh-rb-panel-inline')) {
    throw new Error('inline rule is not specificity-boosted; .dsh-rb-panel would win by source order');
  }
  const inlineRule = css.slice(css.indexOf('.dsh-rb-panel.dsh-rb-panel-inline'));
  if (!/border:\s*0\s*!important/.test(inlineRule)) throw new Error('border reset missing');
  if (!/box-shadow:\s*none\s*!important/.test(inlineRule)) throw new Error('shadow reset missing');
  const panelIndex = css.indexOf('.dsh-rb-panel {');
  const inlineIndex = css.indexOf('.dsh-rb-panel.dsh-rb-panel-inline {');
  if (panelIndex < 0 || inlineIndex < 0) throw new Error('rules missing');
  if (!inlineIndex) throw new Error('inline rule absent');
});

check('no undeclared service read in source (ctx.<name> not in inject / core API)', () => {
  const allowed = new Set([...CORE_API, ...moduleExports.inject]);
  const bad = new Set();
  for (const match of source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    if (!allowed.has(match[1])) bad.add(match[1]);
  }
  if (bad.size > 0) throw new Error(`undeclared: ${[...bad].join(', ')}`);
});

check('disposers remove the injected <style> and the listener', () => {
  const record = [];
  const localCtx = (() => {
    const base = {
      effect(callback) { const d = callback(); record.push(d); return d; },
      get: (name) => undefined,
      provide() {}, on() {}, set() {},
    };
    return new Proxy(base, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (moduleExports.inject.includes(prop)) return slots;
        if (typeof prop === 'symbol') return undefined;
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
    });
  })();
  moduleExports.apply(localCtx);
  const stylesBefore = styleTags.length;
  const listenersBefore = listeners.filter(([t]) => t === 'contextmenu').length;
  for (const d of record) if (typeof d === 'function') d();
  if (styleTags.length !== stylesBefore - 1) throw new Error(`style tags ${stylesBefore} -> ${styleTags.length}`);
  if (listeners.filter(([t]) => t === 'contextmenu').length !== listenersBefore - 1) {
    throw new Error('listener survived dispose');
  }
});

check('canvas architecture: absolute cards inside a transformed stage', () => {
  const css = styleTags[0].textContent;
  for (const selector of ['.dsh-rb-stage {', '.dsh-rb-card {', '.dsh-rb-marquee {', '.dsh-rb-handle {']) {
    if (!css.includes(selector)) throw new Error(`missing ${selector}`);
  }
  if (!/\.dsh-rb-card \{[^}]*position:\s*absolute/.test(css)) throw new Error('cards are not absolutely positioned');
  if (/\.dsh-rb-grid/.test(css)) throw new Error('grid layout still present');
  if (!/className: 'dsh-rb-stage'/.test(source)) throw new Error('stage element not rendered');
  if (!/translate3d\(/.test(source)) throw new Error('stage transform not applied');
  if (!/=> onCardPointerDown\(event, item\)/.test(source)) throw new Error('card drag handler not wired');
  if (!/=> startResize\(event, item, corner\)/.test(source)) throw new Error('resize handle not wired');
  if (!/const CORNER_SIGNS = \{ se: \[1, 1\], sw: \[-1, 1\], ne: \[1, -1\], nw: \[-1, -1\] \}/.test(source)) throw new Error('corner resize directions missing');
  if (!/fontSize: font \}/.test(source)) throw new Error('text cards do not scale by type size');
  if (!/const bumpFont = useCallback/.test(source)) throw new Error('labels cannot be re-scaled from the menu');
  if (!/addEventListener\('wheel'/.test(source)) throw new Error('wheel zoom not wired');
  if (!/function trackPointer/.test(source)) throw new Error('pointer tracking helper missing');
  if (!/addEventListener\('drop', onDrop, true\)/.test(source)) throw new Error('board does not intercept file drops before the app-wide overlay');
  if (!/bridge\.acceptDrop/.test(source)) throw new Error('drop guard is not routed into the board');
  if (!/pushToComposer\(picked\)/.test(source)) throw new Error('dragging a card out of the canvas does not reach the composer');
});

check('menus survive their own pointerdown and are not clipped by the panel', () => {
  const css = styleTags[0].textContent;
  if (!/closest\('\.dsh-rb-menu'\)/.test(source)) throw new Error('the window-level menu close handler does not spare the menu itself');
  if (!/backdrop-filter: none !important/.test(css)) throw new Error('the inline panel still establishes a containing block, so the fixed menu gets clipped');
  if (!/\.dsh-rb-menu \{[^}]*z-index:\s*140/.test(css)) throw new Error('menu z-index is below the surrounding chrome');
  if (!/const runAction = useCallback\(\(action\) => \{[\s\S]{0,200}action\.run\(\)/.test(source)) throw new Error('menu items do not invoke their action');
  if (!/Array\.isArray\(action\.children\)/.test(source)) throw new Error('long menus are not folded into submenus');
  if (!/\.dsh-rb-submenu \{ z-index: 150/.test(css)) throw new Error('the submenu does not sit above its parent menu');
});

console.log('');
if (failures.length > 0) {
  console.log(`FAILED (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log('ALL CHECKS PASSED');
}
