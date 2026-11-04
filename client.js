/**
 * Client half: a PureRef-style per-conversation image board that floats over
 * the conversation (`shell.overlay`), remembers its window rectangle, and can
 * push any collected picture into the composer as a real attachment.
 *
 * Intake paths
 *   - drag files from Explorer onto the board
 *   - drag a picture out of the conversation (uri-list / text-html payload)
 *   - right-click any picture in the app -> add to board
 *   - Ctrl+V with the board focused
 *   - the board's own right-click menu
 *
 * Outbound paths
 *   - right-click an item -> add to the composer input / add and ask about it
 *   - right-click an item -> reveal in Explorer
 *
 * @module @local/session-ref-board
 */
window.__ModuleLoader__.load({
  id: '@local/session-ref-board',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;

    const ROUTE = '/session-ref-board';
    const SLOT = 'shell.overlay';
    const SLOT_ID = 'session-ref-board';
    const VIEW_SLOT = 'conversation.view';
    const VIEW_ID = 'session-ref-board-view';
    const DEFAULT_SIZE = { w: 430, h: 330 };
    const MIN_SIZE = { w: 250, h: 170 };
    const ITEM_THUMB = 78;
    const MIN_ZOOM = 0.05;
    const MAX_ZOOM = 8;
    const CARD_MIN = { w: 40, h: 30 };
    const CARD_DEFAULT_MAX = 340;
    const SAVE_DELAY = 400;
    const IMAGE_EXT_RE = /\.(png|jpe?g|jfif|webp|gif|bmp|avif|svg|ico|tiff?|heic|heif)$/i;

    let ctxRef = null;
    /** Set by the mounted board so the plugin-level contextmenu listener can reach React state. */
    const bridge = { openExternal: null, region: null, acceptDrop: null };

    /* ------------------------------------------------------------------ */
    /* session plumbing                                                    */
    /* ------------------------------------------------------------------ */

    function getUiSession() {
      try {
        return ctxRef ? ctxRef.get('uiSession') : null;
      } catch {
        return null;
      }
    }

    /** Active main session: `{ key, props: { inputActions } }` from the ui-session adapter. */
    function readActive() {
      try {
        const value = getUiSession()?.adapter?.current?.getSnapshot?.();
        if (!value || value.key === undefined) return { id: null, inputActions: null };
        return { id: String(value.key), inputActions: value.props?.inputActions ?? null };
      } catch {
        return { id: null, inputActions: null };
      }
    }

    function useActiveSession() {
      const [active, setActive] = useState(readActive);
      useEffect(() => {
        let source = null;
        try {
          source = getUiSession()?.adapter?.current ?? null;
        } catch {
          source = null;
        }
        setActive(readActive());
        if (!source) return undefined;
        const sync = () => {
          const next = readActive();
          setActive((prev) => (prev.id === next.id && prev.inputActions === next.inputActions ? prev : next));
        };
        return source.subscribe(sync);
      }, []);
      return active;
    }

    function focusComposer() {
      try {
        const editor = document.querySelector('[data-lexical-editor="true"]');
        if (editor instanceof HTMLElement) editor.focus();
      } catch {
        /* focus is best effort */
      }
    }

    /* ------------------------------------------------------------------ */
    /* board server                                                        */
    /* ------------------------------------------------------------------ */

    function url(path, params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
      }
      const suffix = search.toString();
      return `${ROUTE}${path}${suffix ? `?${suffix}` : ''}`;
    }

    /** Fire-and-forget trace: the desktop build has no devtools, so the host keeps a small ring. */
    function trace(kind, detail) {
      try {
        void fetch(url('/debug'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, detail }),
          keepalive: true,
        }).catch(() => {});
      } catch {
        /* tracing must never break the interaction */
      }
    }


    async function requestJson(path, init) {
      const response = await fetch(url(path, init?.params), {
        method: init?.method ?? 'GET',
        credentials: 'same-origin',
        headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      });
      if (!response.ok) {
        let detail = '';
        try {
          detail = (await response.json())?.error ?? '';
        } catch {
          detail = '';
        }
        throw new Error(detail || `${path} failed (${response.status})`);
      }
      return response.json().catch(() => ({}));
    }

    const fileSrc = (path) => url('/image', { path });

    async function uploadBlob(sessionId, blob, name) {
      const type = blob.type || 'image/png';
      const response = await fetch(url('/image', { session: sessionId, name }), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': type },
        body: blob,
      });
      if (!response.ok) throw new Error(`upload failed (${response.status})`);
      const data = await response.json();
      return data.item;
    }

    async function measureBlob(blob) {
      try {
        if (typeof createImageBitmap === 'function') {
          const bitmap = await createImageBitmap(blob);
          const size = { w: bitmap.width, h: bitmap.height };
          if (typeof bitmap.close === 'function') bitmap.close();
          return size;
        }
      } catch {
        /* SVG and exotic codecs may refuse to decode */
      }
      return { w: 0, h: 0 };
    }

    function normalizeBoard(raw) {
      const board = { open: true, rect: null, view: { x: 0, y: 0, s: 1 }, bg: '', items: [] };
      if (raw === null || typeof raw !== 'object') return board;
      if (typeof raw.open === 'boolean') board.open = raw.open;
      if (typeof raw.bg === 'string') board.bg = raw.bg;
      const rect = raw.rect;
      if (rect !== null && typeof rect === 'object') {
        const num = (value, fallback) => (Number.isFinite(value) ? Math.round(value) : fallback);
        board.rect = {
          x: num(rect.x, 0),
          y: num(rect.y, 0),
          w: Math.max(MIN_SIZE.w, num(rect.w, DEFAULT_SIZE.w)),
          h: Math.max(MIN_SIZE.h, num(rect.h, DEFAULT_SIZE.h)),
        };
      }
      const view = raw.view;
      if (view !== null && typeof view === 'object') {
        board.view = {
          x: Number.isFinite(view.x) ? view.x : 0,
          y: Number.isFinite(view.y) ? view.y : 0,
          s: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(view.s) ? view.s : 1)),
        };
      }
      const items = Array.isArray(raw.items) ? raw.items : [];
      const num = (value, fallback) => (Number.isFinite(value) ? Math.round(value) : fallback);
      board.items = items
        .map((item, index) => {
          if (item === null || typeof item !== 'object') return null;
          const kind = item.kind === 'text' ? 'text' : 'image';
          if (kind === 'image' && (typeof item.path !== 'string' || item.path.length === 0)) return null;
          const base = {
            id: typeof item.id === 'string' && item.id.length > 0 ? item.id : `item-${index}`,
            kind,
            name:
              typeof item.name === 'string' && item.name.length > 0
                ? item.name
                : kind === 'text'
                  ? '文字'
                  : 'image',
            addedAt: num(item.addedAt, Date.now()),
            rot: Number.isFinite(item.rot) ? (Math.round(item.rot * 10) / 10) % 360 : 0,
            groupId: typeof item.groupId === 'string' && item.groupId.length > 0 ? item.groupId : null,
          };
          const sized = Number.isFinite(item.w) && Number.isFinite(item.h) && item.w > 0 && item.h > 0;
          const geometry = sized
            ? {
              x: num(item.x, 24),
              y: num(item.y, 24),
              w: Math.max(CARD_MIN.w, num(item.w, 240)),
              h: Math.max(CARD_MIN.h, num(item.h, 184)),
            }
            : { x: 24 + (index % 4) * 264, y: 24 + Math.floor(index / 4) * 224, w: 240, h: 184 };
          if (kind === 'text') {
            return {
              ...base,
              ...geometry,
              text: typeof item.text === 'string' && item.text.length > 0 ? item.text : '文字',
              fontSize: Math.max(8, num(item.fontSize, 15)),
              color: typeof item.color === 'string' ? item.color : '',
            };
          }
          return { ...base, ...geometry, path: item.path };
        })
        .filter(Boolean);
      return board;
    }

    function clampZoom(scale) {
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
    }

    /** Pan/zoom window: world point p maps to stage coordinate p * s + offset. */
    function zoomWindow(view, nextScale, anchorX, anchorY) {
      const s = clampZoom(nextScale);
      return {
        s,
        x: anchorX - (anchorX - view.x) * (s / view.s),
        y: anchorY - (anchorY - view.y) * (s / view.s),
      };
    }

    function itemsBounds(items) {
      if (items.length === 0) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const item of items) {
        // A rotated card sweeps a bigger box than its own w/h, so use the rotated extent.
        const rad = ((item.rot ?? 0) * Math.PI) / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));
        const w = item.w * cos + item.h * sin;
        const h = item.w * sin + item.h * cos;
        const cx = item.x + item.w / 2;
        const cy = item.y + item.h / 2;
        minX = Math.min(minX, cx - w / 2);
        minY = Math.min(minY, cy - h / 2);
        maxX = Math.max(maxX, cx + w / 2);
        maxY = Math.max(maxY, cy + h / 2);
      }
      return { minX, minY, maxX, maxY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
    }

    /** Track a pointer gesture on window so it survives the pointer leaving the panel. */
    function trackPointer(event, move, end, after) {
      const onMove = (next) => move(next);
      const onUp = (next) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (typeof end === 'function') end(next);
        if (typeof after === 'function') after(next);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      if (typeof event?.preventDefault === 'function') event.preventDefault();
    }

    function defaultRect() {
      const width = typeof window === 'undefined' ? 1280 : window.innerWidth;
      const height = typeof window === 'undefined' ? 800 : window.innerHeight;
      const w = Math.min(DEFAULT_SIZE.w, Math.max(MIN_SIZE.w, width - 120));
      const h = Math.min(DEFAULT_SIZE.h, Math.max(MIN_SIZE.h, height - 220));
      return { x: Math.max(16, width - w - 28), y: Math.max(72, Math.round((height - h) * 0.28)), w, h };
    }

    function clampRect(rect) {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const w = Math.max(MIN_SIZE.w, Math.min(rect.w, Math.max(MIN_SIZE.w, width - 24)));
      const h = Math.max(MIN_SIZE.h, Math.min(rect.h, Math.max(MIN_SIZE.h, height - 24)));
      return {
        x: Math.max(8, Math.min(rect.x, width - w - 8)),
        y: Math.max(8, Math.min(rect.y, height - h - 8)),
        w,
        h,
      };
    }

    /* ------------------------------------------------------------------ */
    /* payload readers                                                     */
    /* ------------------------------------------------------------------ */

    const INTERNAL_DRAG = 'application/x-dsh-ref-board-item';

    function isImageLike(blob, name) {
      if (blob && typeof blob.type === 'string' && blob.type.startsWith('image/')) return true;
      return typeof name === 'string' && IMAGE_EXT_RE.test(name);
    }

    /** Image URLs carried by a browser drag (conversation pictures, links, downloads). */
    function readDraggedSources(dataTransfer) {
      if (!dataTransfer) return [];
      const found = [];
      const push = (value) => {
        const text = String(value ?? '').trim();
        if (text.length === 0) return;
        if (!found.includes(text)) found.push(text);
      };
      try {
        const download = dataTransfer.getData('DownloadURL');
        if (download) {
          const parts = download.split(':');
          push(parts.length >= 3 ? parts.slice(2).join(':') : download);
        }
      } catch {
        /* type may be absent */
      }
      try {
        for (const line of String(dataTransfer.getData('text/uri-list') ?? '').split(/\r?\n/)) {
          if (line.trim().startsWith('#')) continue;
          push(line);
        }
      } catch {
        /* type may be absent */
      }
      try {
        const html = String(dataTransfer.getData('text/html') ?? '');
        if (html.length > 0 && typeof DOMParser === 'function') {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          for (const img of doc.querySelectorAll('img')) push(img.getAttribute('src'));
        }
      } catch {
        /* malformed html */
      }
      return found.filter((src) => /^(blob:|data:image\/|https?:\/\/)/i.test(src));
    }

    async function fetchAsBlob(src) {
      const response = await fetch(src, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`fetch failed (${response.status})`);
      return response.blob();
    }

    function nameFromSrc(src, blob) {
      const type = (blob?.type || 'image/png').split(';')[0];
      const ext = type === 'image/jpeg' ? 'jpg' : type.split('/')[1] || 'png';
      try {
        const parsed = new URL(src, location.href);
        const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
        if (last && IMAGE_EXT_RE.test(last)) return last;
      } catch {
        /* not a URL */
      }
      return `board-${Date.now().toString(36)}.${ext}`;
    }

    /* ------------------------------------------------------------------ */
    /* main component                                                      */
    /* ------------------------------------------------------------------ */

    function RefBoard(props) {
      const mode = props?.mode === 'view' ? 'view' : 'float';
      const forcedSession = props?.sessionId;
      const forcedActions = props?.inputActions;
      const active = useActiveSession();
      const sessionId = forcedSession || active.id;
      const [board, setBoard] = useState(null);
      const [rect, setRect] = useState(defaultRect);
      const [busy, setBusy] = useState(0);
      const [notice, setNotice] = useState('');
      const [menu, setMenu] = useState(null);
      const [menuBox, setMenuBox] = useState({ left: 0, top: 0, ready: false });
      const menuRef = useRef(null);
      const [dragOver, setDragOver] = useState(false);
      const [focusRing, setFocusRing] = useState(false);
      const [view, setView] = useState({ x: 0, y: 0, s: 1 });
      const [selection, setSelection] = useState(() => new Set());
      const [marquee, setMarquee] = useState(null);
      const [panning, setPanning] = useState(false);
      const [editor, setEditor] = useState(null);

      const rootRef = useRef(null);
      const fileInputRef = useRef(null);
      const canvasRef = useRef(null);
      const wheelCleanup = useRef(null);
      const saveTimer = useRef(0);
      const lastSaved = useRef('');
      const rectRef = useRef(rect);
      const dragState = useRef(null);
      const boardRef = useRef(board);
      const viewRef = useRef(view);

      /** Every mutation reads through these two refs, so define them before anything lists items. */
      const itemsOf = useCallback(() => boardRef.current?.items ?? [], []);

      const selRef = useRef(selection);
      const autoFit = useRef(false);
      const undoStack = useRef([]);
      const redoStack = useRef([]);
      const clipboard = useRef([]);
      const spaceDown = useRef(false);

      rectRef.current = rect;
      boardRef.current = board;
      viewRef.current = view;
      selRef.current = selection;

      const pushHistory = useCallback(() => {
        const current = boardRef.current;
        if (current === null) return;
        undoStack.current.push(current);
        if (undoStack.current.length > 100) undoStack.current.shift();
        redoStack.current.length = 0;
      }, []);

      const flash = useCallback((text) => {
        setNotice(text);
        window.setTimeout(() => setNotice((current) => (current === text ? '' : current)), 2600);
      }, []);

      /* ---------------------------- load / save --------------------------- */

      useEffect(() => {
        if (!sessionId) {
          setBoard(null);
          return undefined;
        }
        let cancelled = false;
        setBoard(null);
        requestJson('/state', { params: { session: sessionId } })
          .then((data) => {
            if (cancelled) return;
            const loaded = normalizeBoard(data?.board);
            lastSaved.current = JSON.stringify({ session: sessionId, board: loaded });
            setBoard(loaded);
            setRect(loaded.rect === null ? defaultRect() : clampRect(loaded.rect));
            setView(loaded.view);
            viewRef.current = loaded.view;
            const empty = new Set();
            setSelection(empty);
            selRef.current = empty;
            autoFit.current = loaded.items.length > 0 && loaded.view.x === 0 && loaded.view.y === 0 && loaded.view.s === 1;
          })
          .catch(() => {
            if (cancelled) return;
            const fresh = normalizeBoard(null);
            lastSaved.current = JSON.stringify({ session: sessionId, board: fresh });
            setBoard(fresh);
            setRect(defaultRect());
            setView(fresh.view);
            viewRef.current = fresh.view;
            const empty = new Set();
            setSelection(empty);
            selRef.current = empty;
            autoFit.current = false;
          });
        return () => {
          cancelled = true;
        };
      }, [sessionId]);

      const persist = useCallback(
        (next, immediate) => {
          if (!sessionId) return;
          window.clearTimeout(saveTimer.current);
          const body = { session: sessionId, board: next };
          const signature = JSON.stringify(body);
          if (signature === lastSaved.current) return;
          const send = () => {
            lastSaved.current = signature;
            requestJson('/state', { method: 'POST', body }).catch(() => {
              lastSaved.current = '';
            });
          };
          if (immediate) send();
          else saveTimer.current = window.setTimeout(send, SAVE_DELAY);
        },
        [sessionId],
      );

      useEffect(() => () => window.clearTimeout(saveTimer.current), []);

      const commit = useCallback(
        (updater, immediate, options) => {
          const current = boardRef.current;
          if (current === null) return;
          const next = typeof updater === 'function' ? updater(current) : updater;
          if (next === current) {
            persist(current, immediate);
            return;
          }
          if (options?.history !== false) pushHistory();
          boardRef.current = next;
          setBoard(next);
          persist(next, immediate);
        },
        [persist, pushHistory],
      );

      /** Local-only board change (drag frames); persisted by flush() when the gesture ends. */
      const updateLocal = useCallback((updater) => {
        const current = boardRef.current;
        if (current === null) return;
        const next = typeof updater === 'function' ? updater(current) : updater;
        boardRef.current = next;
        setBoard(next);
      }, []);

      const flush = useCallback(() => {
        const current = boardRef.current;
        if (current !== null) persist(current, false);
      }, [persist]);

      const setViewNow = useCallback((next) => {
        viewRef.current = next;
        setView(next);
      }, []);

      const persistView = useCallback(
        (next) => {
          setViewNow(next);
          const current = boardRef.current;
          if (current === null) return;
          const patch = { ...current, view: next };
          boardRef.current = patch;
          setBoard(patch);
          persist(patch, false);
        },
        [persist, setViewNow],
      );

      const undo = useCallback(() => {
        const previous = undoStack.current.pop();
        const current = boardRef.current;
        if (previous === undefined || current === null) {
          flash('没有可撤销的操作');
          return;
        }
        redoStack.current.push(current);
        boardRef.current = previous;
        setBoard(previous);
        persist(previous, true);
      }, [flash, persist]);

      const redo = useCallback(() => {
        const next = redoStack.current.pop();
        const current = boardRef.current;
        if (next === undefined || current === null) {
          flash('没有可重做的操作');
          return;
        }
        undoStack.current.push(current);
        boardRef.current = next;
        setBoard(next);
        persist(next, true);
      }, [flash, persist]);

      const selectIds = useCallback((ids) => {
        const next = ids instanceof Set ? ids : new Set(ids);
        selRef.current = next;
        setSelection(next);
      }, []);

      const removeItem = useCallback(
        async (item) => {
          commit((current) => ({ ...current, items: current.items.filter((entry) => entry.id !== item.id) }), true);
          try {
            await requestJson('/remove', { method: 'POST', body: { path: item.path } });
          } catch {
            /* the board no longer references it */
          }
        },
        [commit],
      );

      /* ----------------------------- clipboard ---------------------------- */

      const copySelection = useCallback(() => {
        const ids = selRef.current;
        const picked = itemsOf().filter((item) => ids.has(item.id));
        if (picked.length === 0) {
          flash('先选点东西');
          return;
        }
        clipboard.current = picked.map((item) => ({ ...item }));
        flash(`已复制 ${picked.length} 个`);
      }, [flash, itemsOf]);

      const pasteClipboard = useCallback(() => {
        const source = clipboard.current;
        if (source.length === 0) return;
        const stamp = Date.now().toString(36);
        const fresh = source.map((item, index) => ({
          ...item,
          id: `${item.kind === 'text' ? 't' : 'i'}-${stamp}-${index}`,
          x: item.x + 26,
          y: item.y + 26,
          groupId: null,
        }));
        clipboard.current = fresh.map((item) => ({ ...item }));
        commit((current) => ({ ...current, items: [...current.items, ...fresh] }), true);
        selectIds(fresh.map((item) => item.id));
      }, [commit, selectIds]);

      const cutSelection = useCallback(() => {
        copySelection();
        const ids = selRef.current;
        if (ids.size === 0) return;
        for (const item of itemsOf()) if (ids.has(item.id)) removeItem(item);
        selectIds([]);
      }, [copySelection, itemsOf, removeItem, selectIds]);

      /* ------------------------------ objects ----------------------------- */

      const addText = useCallback(() => {
        const el = canvasRef.current;
        const v = viewRef.current;
        const cw = el?.clientWidth || 420;
        const ch = el?.clientHeight || 320;
        const item = {
          id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          kind: 'text',
          name: '文字',
          path: undefined,
          addedAt: Date.now(),
          x: Math.round((cw / 2 - v.x) / v.s - 100),
          y: Math.round((ch / 2 - v.y) / v.s - 30),
          w: 200,
          h: 60,
          rot: 0,
          groupId: null,
          text: '双击编辑文字',
          fontSize: 15,
          color: '',
        };
        commit((current) => ({ ...current, items: [...current.items, item] }), true);
        selectIds([item.id]);
        setEditor({ id: item.id, value: item.text, fontSize: item.fontSize ?? 15, color: item.color ?? '' });
      }, [commit, selectIds]);

      const editText = useCallback((item) => {
        setEditor({ id: item.id, value: item.text ?? '', fontSize: item.fontSize ?? 15, color: item.color ?? '' });
      }, []);

      const applyEdit = useCallback(() => {
        const draft = editor;
        if (draft === null) return;
        setEditor(null);
        const value = String(draft.value ?? '');
        commit((current) => ({
          ...current,
          items: current.items.map((item) => {
            if (item.id !== draft.id) return item;
            const text = value.trim().length > 0 ? value : item.text;
            const fontSize = Math.max(8, Math.round(draft.fontSize || item.fontSize || 15));
            const lines = text.split('\n').length || 1;
            const width = Math.max(CARD_MIN.w, item.w);
            return {
              ...item,
              text,
              fontSize,
              color: typeof draft.color === 'string' ? draft.color : item.color,
              w: width,
              h: Math.max(CARD_MIN.h, Math.round(lines * fontSize * 1.5)),
            };
          }),
        }), true);
      }, [commit, editor]);

      /* ------------------------------ groups ------------------------------ */

      const groupSelection = useCallback(() => {
        const ids = selRef.current;
        if (ids.size < 2) {
          flash('至少选两个再组合');
          return;
        }
        const gid = `g-${Date.now().toString(36)}`;
        commit((current) => ({
          ...current,
          items: current.items.map((item) => (ids.has(item.id) ? { ...item, groupId: gid } : item)),
        }), true);
        flash(`已组合 ${ids.size} 个`);
      }, [commit, flash]);

      const ungroupSelection = useCallback(() => {
        const ids = selRef.current;
        commit((current) => ({
          ...current,
          items: current.items.map((item) =>
            ids.size === 0 || ids.has(item.id) ? { ...item, groupId: null } : item,
          ),
        }), true);
      }, [commit]);

      /* ----------------------------- arrange ------------------------------ */

      const arrange = useCallback(
        (mode) => {
          const ids = selRef.current;
          const all = itemsOf();
          const scope = ids.size > 1 ? all.filter((item) => ids.has(item.id)) : all;
          if (scope.length < 2) {
            flash('多选几张，或者画布里多放几张');
            return;
          }
          const bounds = itemsBounds(scope);
          const minX = bounds.minX;
          const minY = bounds.minY;
          const gap = 16;
          const positions = new Map();
          if (mode === 'row') {
            let cursor = minX;
            for (const item of scope) {
              positions.set(item.id, { x: cursor, y: minY });
              cursor += item.w + gap;
            }
          } else if (mode === 'column') {
            let cursor = minY;
            for (const item of scope) {
              positions.set(item.id, { x: minX, y: cursor });
              cursor += item.h + gap;
            }
          } else if (mode === 'grid') {
            const columns = Math.max(1, Math.ceil(Math.sqrt(scope.length)));
            const cellW = Math.max(...scope.map((item) => item.w)) + gap;
            const cellH = Math.max(...scope.map((item) => item.h)) + gap;
            scope.forEach((item, index) => {
              positions.set(item.id, {
                x: minX + (index % columns) * cellW,
                y: minY + Math.floor(index / columns) * cellH,
              });
            });
          } else if (mode === 'left') {
            for (const item of scope) positions.set(item.id, { x: minX, y: item.y });
          } else if (mode === 'top') {
            for (const item of scope) positions.set(item.id, { x: item.x, y: minY });
          } else if (mode === 'centerH') {
            const mid = (bounds.minY + bounds.maxY) / 2;
            for (const item of scope) positions.set(item.id, { x: item.x, y: Math.round(mid - item.h / 2) });
          } else if (mode === 'centerV') {
            const mid = (bounds.minX + bounds.maxX) / 2;
            for (const item of scope) positions.set(item.id, { x: Math.round(mid - item.w / 2), y: item.y });
          } else if (mode === 'distributeH') {
            const sorted = [...scope].sort((a, b) => a.x - b.x);
            const span = bounds.maxX - bounds.minX;
            const total = sorted.reduce((sum, item) => sum + item.w, 0);
            const step = sorted.length > 1 ? (span - total) / (sorted.length - 1) : 0;
            let cursor = minX;
            for (const item of sorted) {
              positions.set(item.id, { x: Math.round(cursor), y: item.y });
              cursor += item.w + step;
            }
          } else if (mode === 'distributeV') {
            const sorted = [...scope].sort((a, b) => a.y - b.y);
            const span = bounds.maxY - bounds.minY;
            const total = sorted.reduce((sum, item) => sum + item.h, 0);
            const step = sorted.length > 1 ? (span - total) / (sorted.length - 1) : 0;
            let cursor = minY;
            for (const item of sorted) {
              positions.set(item.id, { x: item.x, y: Math.round(cursor) });
              cursor += item.h + step;
            }
          }
          commit((current) => ({
            ...current,
            items: current.items.map((item) => {
              const spot = positions.get(item.id);
              return spot === undefined ? item : { ...item, ...spot };
            }),
          }), true);
        },
        [commit, flash, itemsOf],
      );

      const fitView = useCallback(() => {
        const el = canvasRef.current;
        const items = itemsOf();
        const cw = el?.clientWidth || 480;
        const ch = el?.clientHeight || 360;
        const bounds = itemsBounds(items);
        if (bounds === null) {
          persistView({ x: 0, y: 0, s: 1 });
          return;
        }
        const pad = 26;
        const s = clampZoom(Math.min((cw - pad * 2) / bounds.w, (ch - pad * 2) / bounds.h));
        persistView({
          s,
          x: (cw - bounds.w * s) / 2 - bounds.minX * s,
          y: (ch - bounds.h * s) / 2 - bounds.minY * s,
        });
      }, [itemsOf, persistView]);


      const fitSelection = useCallback(() => {
        const ids = selRef.current;
        const scope = itemsOf().filter((item) => ids.has(item.id));
        if (scope.length === 0) {
          fitView();
          return;
        }
        const el = canvasRef.current;
        const cw = el?.clientWidth || 480;
        const ch = el?.clientHeight || 360;
        const bounds = itemsBounds(scope);
        const pad = 40;
        const s = clampZoom(Math.min((cw - pad * 2) / bounds.w, (ch - pad * 2) / bounds.h));
        persistView({
          s,
          x: (cw - bounds.w * s) / 2 - bounds.minX * s,
          y: (ch - bounds.h * s) / 2 - bounds.minY * s,
        });
      }, [fitView, itemsOf, persistView]);

      /* ------------------------------ export ------------------------------ */

      const exportPng = useCallback(async (mode = 'auto', options = {}) => {
        const mime = options.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
        const suffix = mime === 'image/jpeg' ? 'jpg' : 'png';
        const quality = mime === 'image/jpeg' ? 0.92 : undefined;
        const multiplier = options.mult && options.mult > 0 ? options.mult : 1;
        const items = itemsOf();
        const ids = selRef.current;
        const scope = mode === 'view' ? items : ids.size > 0 ? items.filter((item) => ids.has(item.id)) : items;
        if (scope.length === 0) {
          flash('画布是空的');
          return;
        }
        const bounds = mode === 'view'
          ? (() => {
            const element = canvasRef.current;
            const box = element ? element.getBoundingClientRect() : { width: 800, height: 600 };
            const view = viewRef.current;
            return {
              minX: -view.x / view.s,
              minY: -view.y / view.s,
              w: Math.max(1, box.width / view.s),
              h: Math.max(1, box.height / view.s),
            };
          })()
          : itemsBounds(scope);
        const pad = mode === 'view' ? 0 : 32;
        const span = Math.max(bounds.w + pad * 2, bounds.h + pad * 2);
        const scale = Math.min(2 * multiplier, (4096 * multiplier) / span);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((bounds.w + pad * 2) * scale));
        canvas.height = Math.max(1, Math.round((bounds.h + pad * 2) * scale));
        const context = canvas.getContext('2d');
        if (!context) {
          flash('这个环境画不了图');
          return;
        }
        context.fillStyle = boardRef.current?.bg || (mime === 'image/jpeg' ? '#ffffff' : '#202024');
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.scale(scale, scale);
        for (const item of scope) {
          context.save();
          context.translate(item.x - bounds.minX + pad + item.w / 2, item.y - bounds.minY + pad + item.h / 2);
          context.rotate(((item.rot || 0) * Math.PI) / 180);
          if (item.kind === 'text') {
            context.fillStyle = item.color || '#ededf0';
            context.font = `${item.fontSize || 15}px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;
            context.textBaseline = 'top';
            String(item.text ?? '').split('\n').forEach((line, index) => {
              context.fillText(line, -item.w / 2, -item.h / 2 + index * (item.fontSize || 15) * 1.4);
            });
          } else {
            try {
              const image = new Image();
              image.src = fileSrc(item.path);
              await image.decode();
              context.drawImage(image, -item.w / 2, -item.h / 2, item.w, item.h);
            } catch {
              /* skip an image that refuses to decode */
            }
          }
          context.restore();
        }
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
        if (!blob) {
          flash('导出失败');
          return;
        }
        try {
          const response = await fetch(url('/export', { session: sessionId, name: `board-${Date.now().toString(36)}.${suffix}` }), {
            method: 'POST',
            headers: { 'content-type': mime },
            body: blob,
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data?.error || 'export failed');
          flash(`已导出 ${data.path}`);
          requestJson('/reveal', { method: 'POST', body: { path: data.path } }).catch(() => {});
        } catch {
          flash('导出没写成文件');
        }
      }, [flash, itemsOf, sessionId]);

      /* ------------------------------ intake ------------------------------ */

      /** Where a freshly added image lands: the drop point, else the centre of the view. */
      const placeNew = useCallback((size, index, spot) => {
        const el = canvasRef.current;
        const v = viewRef.current;
        const cw = el?.clientWidth || 420;
        const ch = el?.clientHeight || 320;
        const natural = Math.max(1, size?.w || 0, size?.h || 0);
        const factor = Math.min(1, CARD_DEFAULT_MAX / natural);
        const w = Math.max(CARD_MIN.w, Math.round((size?.w || CARD_DEFAULT_MAX) * factor));
        const height = Math.max(CARD_MIN.h, Math.round((size?.h || CARD_DEFAULT_MAX * 0.75) * factor));
        const cx = spot ? spot.x : (cw / 2 - v.x) / v.s;
        const cy = spot ? spot.y : (ch / 2 - v.y) / v.s;
        const step = spot ? 0 : (index % 7) * 22;
        return { x: Math.round(cx - w / 2 + step), y: Math.round(cy - height / 2 + step), w, h: height };
      }, []);

      const ingest = useCallback(
        async (sources, spot) => {
          if (!sessionId) return [];
          const jobs = sources.map(async (source) => {
            const blob = source.blob ?? (await fetchAsBlob(source.src));
            const name = source.name || nameFromSrc(source.src ?? '', blob);
            if (!isImageLike(blob, name)) return null;
            const size = await measureBlob(blob);
            const item = await uploadBlob(sessionId, blob, name);
            return { ...item, w: size.w, h: size.h };
          });
          setBusy((value) => value + 1);
          let added = [];
          try {
            const results = await Promise.allSettled(jobs);
            added = results.filter((entry) => entry.status === 'fulfilled' && entry.value).map((entry) => entry.value);
            const failed = results.length - added.length;
            if (added.length > 0) {
              commit((current) => {
                let index = current.items.length;
                const placed = added.map((entry) => {
                  const point = spot === undefined ? undefined : { x: spot.x + index - current.items.length, y: spot.y };
                  const where = placeNew(entry, index, point);
                  index += 1;
                  return { ...entry, ...where };
                });
                return { ...current, items: [...current.items, ...placed] };
              });
            }
            if (failed > 0) flash(failed === results.length ? '这些图放不进来' : `${failed} 张图没放进来`);
          } finally {
            setBusy((value) => Math.max(0, value - 1));
          }
          return added;
        },
        [commit, flash, placeNew, sessionId],
      );

      const ingestFiles = useCallback(
        (files, spot) => {
          const list = Array.from(files ?? []).filter((file) => isImageLike(file, file?.name));
          if (list.length === 0) {
            flash('只收图片');
            return Promise.resolve([]);
          }
          return ingest(list.map((file) => ({ blob: file, name: file.name })), spot);
        },
        [flash, ingest],
      );

      const ingestSrcs = useCallback(
        (srcs, spot) => {
          if (srcs.length === 0) {
            flash('没认出这是图片');
            return Promise.resolve([]);
          }
          return ingest(srcs.map((src) => ({ src })), spot);
        },
        [flash, ingest],
      );

      /* ------------------------ composer integration ---------------------- */

      const toFiles = useCallback(async (items) => {
        const files = [];
        for (const item of items) {
          const blob = await fetchAsBlob(fileSrc(item.path));
          const type = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/png';
          files.push(new File([blob], item.name || 'image.png', { type }));
        }
        return files;
      }, []);

      const pushToComposer = useCallback(
        async (items, options) => {
          const live = readActive();
          const id = forcedSession || live.id;
          const inputActions = forcedActions || live.inputActions;
          if (!id) {
            flash('先打开一个对话');
            return;
          }
          if (!inputActions) {
            flash('这个对话还没准备好输入框');
            return;
          }
          let files;
          try {
            files = await toFiles(items);
          } catch {
            flash('读图片失败');
            return;
          }
          const conversation = (() => {
            try {
              return ctxRef?.get('conversation') ?? null;
            } catch {
              return null;
            }
          })();
          if (!conversation || typeof conversation.createDrafts !== 'function') {
            flash('输入框接口不可用');
            return;
          }
          const drafts = conversation.createDrafts(id, files);
          inputActions.addAttachments(drafts.map((draft) => draft.id));
          if (options?.ask) {
            const span = inputActions.captureInsertion();
            inputActions.insertText('关于这张图：', span);
          }
          focusComposer();
        },
        [flash, forcedActions, forcedSession, toFiles],
      );

      const revealItem = useCallback(
        async (item) => {
          try {
            await requestJson('/reveal', { method: 'POST', body: { path: item.path } });
          } catch {
            flash('打不开文件位置');
          }
        },
        [flash],
      );

      const copyPath = useCallback(
        async (item) => {
          try {
            await navigator.clipboard.writeText(item.path);
            flash('路径已复制');
          } catch {
            flash('复制失败');
          }
        },
        [flash],
      );

      /* --------------------------- external hook -------------------------- */

      useEffect(() => {
        bridge.openExternal = (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return false;
          if (target.closest('.dsh-rb-root')) return false;
          const img = target.closest('img');
          if (!(img instanceof HTMLImageElement)) return false;
          const src = img.currentSrc || img.src;
          if (!src) return false;
          if (img.width < 48 && img.height < 48) return false;
          event.preventDefault();
          event.stopPropagation();
          setMenuBox({ left: event.clientX, top: event.clientY, ready: false });
          setMenu({ x: event.clientX, y: event.clientY, kind: 'external', src });
          return true;
        };
        return () => {
          bridge.openExternal = null;
        };
      }, []);

      /* ------------------------------ window ------------------------------ */

      useEffect(() => {
        if (menu === null) return undefined;
        // A capture-phase pointerdown lands before the menu button's own click, so an
        // unguarded close() would remove the button mid-gesture and every item would look dead.
        const close = (event) => {
          const node = event?.target;
          if (node !== null && typeof node?.closest === 'function' && node.closest('.dsh-rb-menu') !== null) return;
          setMenu(null);
        };
        window.addEventListener('pointerdown', close, true);
        window.addEventListener('blur', close);
        return () => {
          window.removeEventListener('pointerdown', close, true);
          window.removeEventListener('blur', close);
        };
      }, [menu]);

      useEffect(() => {
        const onResize = () => setRect((current) => clampRect(current));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      const startWindowDrag = useCallback(
        (event) => {
          if (event.button !== 0) return;
          const box = rootRef.current?.getBoundingClientRect();
          if (!box) return;
          dragState.current = { mode: 'move', startX: event.clientX, startY: event.clientY, rect: { ...rectRef.current } };
          event.preventDefault();
        },
        [],
      );

      const startWindowResize = useCallback((event) => {
        if (event.button !== 0) return;
        dragState.current = { mode: 'resize', startX: event.clientX, startY: event.clientY, rect: { ...rectRef.current } };
        event.preventDefault();
        event.stopPropagation();
      }, []);

      useEffect(() => {
        const onMove = (event) => {
          const state = dragState.current;
          if (state === null) return;
          const dx = event.clientX - state.startX;
          const dy = event.clientY - state.startY;
          const next =
            state.mode === 'move'
              ? clampRect({ ...state.rect, x: state.rect.x + dx, y: state.rect.y + dy })
              : clampRect({ ...state.rect, w: state.rect.w + dx, h: state.rect.h + dy });
          setRect(next);
        };
        const onUp = () => {
          if (dragState.current === null) return;
          dragState.current = null;
          commit((current) => ({ ...current, rect: rectRef.current }), false);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
        };
      }, [commit]);

      /* ------------------------------- drop ------------------------------- */

      /** Screen point -> world point, so a drop lands under the cursor. */
      const worldFromEvent = useCallback((event) => {
        const el = canvasRef.current;
        const box = el?.getBoundingClientRect();
        if (!box) return undefined;
        const v = viewRef.current;
        return { x: (event.clientX - box.left - v.x) / v.s, y: (event.clientY - box.top - v.y) / v.s };
      }, []);

      const onDrop = useCallback(
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragOver(false);
          const dataTransfer = event.dataTransfer;
          if (!dataTransfer) return;
          if (Array.from(dataTransfer.types ?? []).includes(INTERNAL_DRAG)) return;
          const spot = worldFromEvent(event);
          const files = Array.from(dataTransfer.files ?? []);
          if (files.length > 0) {
            ingestFiles(files, spot);
            return;
          }
          ingestSrcs(readDraggedSources(dataTransfer), spot);
        },
        [ingestFiles, ingestSrcs, worldFromEvent],
      );

      const onDragOver = useCallback((event) => {
        const dataTransfer = event.dataTransfer;
        if (!dataTransfer) return;
        if (Array.from(dataTransfer.types ?? []).includes(INTERNAL_DRAG)) return;
        event.preventDefault();
        event.stopPropagation();
        dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }, []);

      /** Let the app-level drop guard route file drops that land on the board. */
      useEffect(() => {
        const region = () => (canvasRef.current ? canvasRef.current.getBoundingClientRect() : null);
        const acceptDrop = (files, point) => {
          const spot = point ? worldFromEvent(point) : undefined;
          ingestFiles(files, spot);
        };
        bridge.region = region;
        bridge.acceptDrop = acceptDrop;
        return () => {
          // Two boards can be mounted (floating panel + tab): only drop our own handles.
          if (bridge.region === region) bridge.region = null;
          if (bridge.acceptDrop === acceptDrop) bridge.acceptDrop = null;
        };
      }, [ingestFiles, worldFromEvent]);

      const onPaste = useCallback(
        (event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length > 0) {
            event.preventDefault();
            ingestFiles(files);
            return;
          }
          if (clipboard.current.length > 0) {
            event.preventDefault();
            pasteClipboard();
          }
        },
        [ingestFiles, pasteClipboard],
      );

      /* ------------------------------ canvas ------------------------------ */

      const setCanvasEl = useCallback(
        (el) => {
          if (canvasRef.current === el) return;
          if (typeof wheelCleanup.current === 'function') {
            wheelCleanup.current();
            wheelCleanup.current = null;
          }
          canvasRef.current = el;
          if (!el) return;
          const onWheel = (event) => {
            event.preventDefault();
            const box = el.getBoundingClientRect();
            const v = viewRef.current;
            const factor = Math.pow(1.0018, -event.deltaY);
            const next = zoomWindow(v, clampZoom(v.s * factor), event.clientX - box.left, event.clientY - box.top);
            persistView(next);
          };
          el.addEventListener('wheel', onWheel, { passive: false });
          wheelCleanup.current = () => el.removeEventListener('wheel', onWheel);
        },
        [persist, setViewNow],
      );

      useEffect(
        () => () => {
          if (typeof wheelCleanup.current === 'function') wheelCleanup.current();
        },
        [],
      );

      useEffect(() => {
        if (board === null || !autoFit.current) return undefined;
        autoFit.current = false;
        const id = window.setTimeout(fitView, 80);
        return () => window.clearTimeout(id);
      }, [board, fitView]);

      const startPan = useCallback(
        (event) => {
          const v0 = { ...viewRef.current };
          const start = { x: event.clientX, y: event.clientY };
          setPanning(true);
          trackPointer(
            event,
            (move) => {
              setViewNow({ ...v0, x: v0.x + (move.clientX - start.x), y: v0.y + (move.clientY - start.y) });
            },
            () => {
              setPanning(false);
              persistView(viewRef.current);
            },
          );
        },
        [persistView, setViewNow],
      );

      const onCanvasPointerDown = useCallback(
        (event) => {
          if (spaceDown.current || event.button === 1 || (event.button === 0 && (event.altKey || event.metaKey))) {
            startPan(event);
            return;
          }
          if (event.button !== 0) return;
          const el = canvasRef.current;
          const box = el?.getBoundingClientRect();
          if (!box) return;
          const additive = event.shiftKey;
          if (!additive) {
            const empty = new Set();
            setSelection(empty);
            selRef.current = empty;
          }
          const start = { x: event.clientX - box.left, y: event.clientY - box.top };
          setMarquee({ x0: start.x, y0: start.y, x1: start.x, y1: start.y });
          trackPointer(
            event,
            (move) => {
              const x = move.clientX - box.left;
              const y = move.clientY - box.top;
              setMarquee({ x0: start.x, y0: start.y, x1: x, y1: y });
              const v = viewRef.current;
              const wx0 = (Math.min(start.x, x) - v.x) / v.s;
              const wx1 = (Math.max(start.x, x) - v.x) / v.s;
              const wy0 = (Math.min(start.y, y) - v.y) / v.s;
              const wy1 = (Math.max(start.y, y) - v.y) / v.s;
              const hit = new Set();
              for (const item of itemsOf()) {
                if (item.x < wx1 && item.x + item.w > wx0 && item.y < wy1 && item.y + item.h > wy0) hit.add(item.id);
                else if (additive && selRef.current.has(item.id)) hit.add(item.id);
              }
              setSelection(hit);
              selRef.current = hit;
            },
            () => setMarquee(null),
          );
        },
        [itemsOf, startPan],
      );

      const onCardPointerDown = useCallback(
        (event, item) => {
          if (event.button === 1 || (event.button === 0 && (event.altKey || event.metaKey))) {
            startPan(event);
            return;
          }
          if (event.button !== 0) return;
          event.stopPropagation();
          const additive = event.shiftKey || event.ctrlKey;
          let nextSel = new Set(selRef.current);
          if (additive) {
            if (nextSel.has(item.id)) nextSel.delete(item.id);
            else nextSel.add(item.id);
          } else if (!nextSel.has(item.id)) {
            nextSel = new Set([item.id]);
          }
          if (item.groupId && !additive) {
            for (const entry of itemsOf()) if (entry.groupId === item.groupId) nextSel.add(entry.id);
          }
          setSelection(nextSel);
          selRef.current = nextSel;
          const ids = nextSel;
          const start = { x: event.clientX, y: event.clientY };
          const origin = new Map(
            itemsOf()
              .filter((entry) => ids.has(entry.id))
              .map((entry) => [entry.id, { x: entry.x, y: entry.y }]),
          );
          let moved = false;
          trackPointer(
            event,
            (move) => {
              const scale = viewRef.current.s;
              const dx = (move.clientX - start.x) / scale;
              const dy = (move.clientY - start.y) / scale;
              if (!moved && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
              if (!moved) pushHistory();
              moved = true;
              updateLocal((current) => ({
                ...current,
                items: current.items.map((entry) => {
                  const base = origin.get(entry.id);
                  return base === undefined ? entry : { ...entry, x: Math.round(base.x + dx), y: Math.round(base.y + dy) };
                }),
              }));
            },
            () => {
              if (moved) flush();
            },
            (end) => {
              if (!moved) return;
              const box = canvasRef.current ? canvasRef.current.getBoundingClientRect() : null;
              const outside = box !== null
                && (end.clientX < box.left - 6 || end.clientX > box.right + 6 || end.clientY < box.top - 6 || end.clientY > box.bottom + 6)
                && end.clientX > 0 && end.clientY > 0;
              if (!outside) return;
              const picked = itemsOf().filter((entry) => ids.has(entry.id) && entry.kind !== 'text');
              // Dragged out of the canvas: put the cards back where they were and hand them to the composer.
              commit(
                (current) => ({
                  ...current,
                  items: current.items.map((entry) => {
                    const base = origin.get(entry.id);
                    return base === undefined ? entry : { ...entry, x: base.x, y: base.y };
                  }),
                }),
                true,
                { history: false },
              );
              if (picked.length > 0) pushToComposer(picked);
            },
          );
        },
        [commit, flush, itemsOf, pushHistory, pushToComposer, startPan, updateLocal],
      );

      const startResize = useCallback(
        (event, item) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          const start = { x: event.clientX, y: event.clientY };
          const scale = viewRef.current.s;
          const ratio = item.h > 0 ? item.w / item.h : 1;
          const w0 = item.w;
          const h0 = item.h;
          pushHistory();
          trackPointer(
            event,
            (move) => {
              const dx = (move.clientX - start.x) / scale;
              const dy = (move.clientY - start.y) / scale;
              let w = Math.max(CARD_MIN.w, w0 + dx);
              let height = Math.max(CARD_MIN.h, w / ratio);
              if (move.altKey) height = Math.max(CARD_MIN.h, h0 + dy);
              const nextW = Math.round(w);
              const nextH = Math.round(height);
              updateLocal((current) => ({
                ...current,
                items: current.items.map((entry) =>
                  entry.id === item.id ? { ...entry, w: nextW, h: nextH } : entry,
                ),
              }));
            },
            () => flush(),
          );
        },
        [flush, pushHistory, updateLocal],
      );

      const startRotate = useCallback(
        (event, item) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          const el = canvasRef.current;
          const box = el?.getBoundingClientRect();
          if (!box) return;
          const v = viewRef.current;
          const cx = item.x + item.w / 2;
          const cy = item.y + item.h / 2;
          const angleAt = (point) => {
            const wx = (point.clientX - box.left - v.x) / v.s;
            const wy = (point.clientY - box.top - v.y) / v.s;
            return Math.round((Math.atan2(wy - cy, wx - cx) * 180) / Math.PI) + 90;
          };
          pushHistory();
          trackPointer(
            event,
            (move) => {
              const rot = ((angleAt(move) % 360) + 360) % 360;
              updateLocal((current) => ({
                ...current,
                items: current.items.map((entry) => (entry.id === item.id ? { ...entry, rot } : entry)),
              }));
            },
            () => flush(),
          );
        },
        [flush, pushHistory, updateLocal],
      );

      const rotateBy = useCallback(
        (item, delta) => {
          commit((current) => ({
            ...current,
            items: current.items.map((entry) =>
              entry.id === item.id ? { ...entry, rot: ((((entry.rot || 0) + delta) % 360) + 360) % 360 } : entry,
            ),
          }), true);
        },
        [commit],
      );

      const layerItem = useCallback(
        (item, toBack) => {
          commit((current) => {
            const target = current.items.find((entry) => entry.id === item.id);
            if (!target) return current;
            const rest = current.items.filter((entry) => entry.id !== item.id);
            return { ...current, items: toBack ? [target, ...rest] : [...rest, target] };
          });
        },
        [commit],
      );

      /** Move one card a single step up (+1) or down (-1) in paint order. */
      const nudgeLayer = useCallback(
        (item, delta) => {
          commit((current) => {
            const list = current.items.slice();
            const from = list.findIndex((entry) => entry.id === item.id);
            if (from < 0) return current;
            const to = Math.min(list.length - 1, Math.max(0, from + delta));
            if (to === from) return current;
            const [moved] = list.splice(from, 1);
            list.splice(to, 0, moved);
            return { ...current, items: list };
          });
        },
        [commit],
      );

      const exportArea = useCallback((options) => {
        const ids = selRef.current;
        if (ids.size > 0) return exportPng('select', options);
        return exportPng('auto', options);
      }, [exportPng]);

      /** Dump the whole board document next to the images, so it can travel. */
      const exportProject = useCallback(async () => {
        const payload = JSON.stringify({ ...(boardRef.current ?? {}), view: viewRef.current }, null, 2);
        try {
          const response = await fetch(url('/export', { session: sessionId, name: `board-${Date.now().toString(36)}.json` }), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: new Blob([payload], { type: 'application/json' }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data?.error || 'export failed');
          flash(`项目已导出 ${data.path}`);
          requestJson('/reveal', { method: 'POST', body: { path: data.path } }).catch(() => {});
        } catch {
          flash('导出没写成文件');
        }
      }, [flash, sessionId]);

      const importProject = useCallback(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        input.addEventListener('change', async () => {
          const file = input.files && input.files[0];
          input.remove();
          if (!file) return;
          try {
            const parsed = JSON.parse(await file.text());
            const next = normalizeBoard({ ...parsed, open: true });
            boardRef.current = next;
            setBoard(next);
            const target = next.view ?? { x: 0, y: 0, s: 1 };
            viewRef.current = target;
            setView(target);
            selectIds([]);
            persist(next, true);
            flash(`已载入 ${next.items.length} 个对象`);
            requestAnimationFrame(() => fitView());
          } catch {
            flash('项目文件读不了');
          }
        }, { once: true });
        document.body.appendChild(input);
        input.click();
      }, [fitView, flash, persist, selectIds]);

      const selectAll = useCallback(() => {
        const all = new Set(itemsOf().map((item) => item.id));
        setSelection(all);
        selRef.current = all;
      }, [itemsOf]);

      const onKeyDown = useCallback(
        (event) => {
          const mod = event.ctrlKey || event.metaKey;
          const key = event.key.toLowerCase();
          if (key === 'escape') {
            setMenu(null);
            setEditor(null);
            selectIds([]);
            return;
          }
          if (mod && key === 'z') {
            event.preventDefault();
            if (event.shiftKey) redo();
            else undo();
            return;
          }
          if (mod && key === 'y') {
            event.preventDefault();
            redo();
            return;
          }
          if (mod && key === 'c') {
            event.preventDefault();
            copySelection();
            return;
          }
          if (mod && key === 'x') {
            event.preventDefault();
            cutSelection();
            return;
          }
          if (mod && key === 'v') {
            event.preventDefault();
            pasteClipboard();
            return;
          }
          if (mod && key === 'a') {
            event.preventDefault();
            selectAll();
            return;
          }
          if (mod && key === 's') {
            event.preventDefault();
            flush();
            flash('已保存');
            return;
          }
          if (key === 'delete' || key === 'backspace') {
            const ids = selRef.current;
            if (ids.size === 0) return;
            event.preventDefault();
            for (const item of itemsOf()) if (ids.has(item.id)) removeItem(item);
            selectIds([]);
            return;
          }
          if (key === 'f') {
            event.preventDefault();
            if (event.shiftKey) fitSelection();
            else fitView();
            return;
          }
          if (key === 't' && !mod) {
            event.preventDefault();
            addText();
            return;
          }
          if (key === 'g' && !mod) {
            event.preventDefault();
            if (event.shiftKey) ungroupSelection();
            else groupSelection();
          }
        },
        [
          addText,
          copySelection,
          cutSelection,
          fitSelection,
          fitView,
          flash,
          flush,
          groupSelection,
          itemsOf,
          pasteClipboard,
          redo,
          removeItem,
          selectAll,
          selectIds,
          undo,
          ungroupSelection,
        ],
      );

      /** Shortcuts must work without first clicking the canvas, but never steal keys from a text field. */
      const isEditableTarget = (node) => {
        if (node === null || typeof node !== 'object') return false;
        const tag = String(node.tagName ?? '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        return node.isContentEditable === true;
      };

      useEffect(() => {
        const onWindowKeyDown = (event) => {
          if (isEditableTarget(event.target)) return;
          onKeyDown(event);
        };
        const onWindowPaste = (event) => {
          if (isEditableTarget(event.target)) return;
          onPaste(event);
        };
        window.addEventListener('keydown', onWindowKeyDown);
        window.addEventListener('paste', onWindowPaste);
        return () => {
          window.removeEventListener('keydown', onWindowKeyDown);
          window.removeEventListener('paste', onWindowPaste);
        };
      }, [onKeyDown, onPaste]);

      useEffect(() => {
        const down = (event) => {
          if (event.code === 'Space' && !event.repeat && !isEditableTarget(event.target)) spaceDown.current = true;
        };
        const up = (event) => {
          if (event.code === 'Space') spaceDown.current = false;
        };
        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        return () => {
          window.removeEventListener('keydown', down);
          window.removeEventListener('keyup', up);
        };
      }, []);

      /* ------------------------------- menu ------------------------------- */

      const placeMenu = useCallback((x, y) => {
        setMenuBox({ left: x, top: y, ready: false });
      }, []);

      const openItemMenu = useCallback((event, item) => {
        event.preventDefault();
        event.stopPropagation();
        placeMenu(event.clientX, event.clientY);
        setMenu({ x: event.clientX, y: event.clientY, kind: 'item', item });
      }, [placeMenu]);

      const openPanelMenu = useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        placeMenu(event.clientX, event.clientY);
        setMenu({ x: event.clientX, y: event.clientY, kind: 'panel' });
      }, [placeMenu]);

      /**
       * The menu is measured after it renders, then flipped back inside the
       * viewport. Guessing from an item count pushed tall menus off the top edge.
       */
      useLayoutEffect(() => {
        if (menu === null) return;
        const node = menuRef.current;
        if (node === null) return;
        const margin = 10;
        const width = node.offsetWidth || 200;
        const height = node.offsetHeight || 220;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = menu.x;
        let top = menu.y;
        if (left + width + margin > vw) left = Math.max(margin, vw - width - margin);
        if (left < margin) left = margin;
        if (top + height + margin > vh) top = Math.max(margin, vh - height - margin);
        if (top < margin) top = margin;
        setMenuBox((box) => (
          box.left === left && box.top === top && box.ready ? box : { left, top, ready: true }
        ));
      }, [menu]);

      const menuActions = useMemo(() => {
        if (menu === null) return [];
        if (menu.kind === 'external') {
          const src = menu.src;
          return [
            {
              label: '加入输入框',
              run: async () => {
                const added = await ingestSrcs([src]);
                if (added.length > 0) await pushToComposer([added[0]]);
              },
            },
            {
              label: '对其提问',
              run: async () => {
                const added = await ingestSrcs([src]);
                if (added.length > 0) await pushToComposer([added[0]], { ask: true });
              },
            },
            { label: '加入图片集', run: () => ingestSrcs([src]) },
            { separator: true },
            { label: '复制图片地址', run: () => copyText(src, flash) },
          ];
        }
        if (menu.kind === 'item') {
          const item = menu.item;
          const head = item.kind === 'text'
            ? [{ label: '编辑文字', run: () => editText(item) }, { separator: true }]
            : [
              { label: '加入输入框', run: () => pushToComposer([item]) },
              { label: '对其提问', run: () => pushToComposer([item], { ask: true }) },
              { separator: true },
              { label: '打开文件位置', run: () => revealItem(item) },
              { label: '复制文件路径', run: () => copyPath(item) },
              { separator: true },
            ];
          return [
            ...head,
            { label: '顺时针旋转 90°', run: () => rotateBy(item, 90) },
            { label: '逆时针旋转 90°', run: () => rotateBy(item, -90) },
            { label: '角度归零', run: () => commit((current) => ({ ...current, items: current.items.map((entry) => (entry.id === item.id ? { ...entry, rot: 0 } : entry)) }), true) },
            { separator: true },
            { label: '与选中项组合 (G)', run: () => groupSelection() },
            { label: '取消组合', run: () => ungroupSelection() },
            { separator: true },
            { label: '上移一层', run: () => nudgeLayer(item, 1) },
            { label: '下移一层', run: () => nudgeLayer(item, -1) },
            { label: '移到最前', run: () => layerItem(item, false) },
            { label: '移到最后', run: () => layerItem(item, true) },
            { separator: true },
            { label: '从画布移除', run: () => removeItem(item) },
          ];
        }
        return [
          { label: '选择图片…', run: () => fileInputRef.current?.click() },
          { label: '添加文字 (T)', run: () => addText() },
          { label: '粘贴剪贴板图片 / 对象', run: () => pasteFromClipboard(ingestFiles, flash) },
          { separator: true },
          {
            label: '全部加入输入框',
            run: () => {
              const source = (board?.items ?? []).filter((item) => item.kind !== 'text');
              if (source.length === 0) flash('画布上没有图片');
              else pushToComposer(source);
            },
          },
          { separator: true },
          { label: '网格整理', run: () => arrange('grid') },
          { label: '横向排列', run: () => arrange('row') },
          { label: '纵向排列', run: () => arrange('column') },
          { label: '左对齐', run: () => arrange('left') },
          { label: '上对齐', run: () => arrange('top') },
          { label: '水平居中', run: () => arrange('centerH') },
          { label: '垂直居中', run: () => arrange('centerV') },
          { label: '水平等距', run: () => arrange('distributeH') },
          { label: '垂直等距', run: () => arrange('distributeV') },
          { separator: true },
          { label: '组合 (G)', run: () => groupSelection() },
          { label: '取消组合', run: () => ungroupSelection() },
          { separator: true },
          { label: '适应全部 (F)', run: () => fitView() },
          { label: '适应选中 (Shift+F)', run: () => fitSelection() },
          { label: '回到原点 100%', run: () => persistView({ x: 0, y: 0, s: 1 }) },
          { separator: true },
          { label: '导出画布 PNG…', run: () => exportArea() },
          { label: '导出可见区域 PNG…', run: () => exportPng('view') },
          { label: '导出 2 倍图 PNG…', run: () => exportArea({ mult: 2 }) },
          { label: '导出 JPG…', run: () => exportArea({ type: 'image/jpeg' }) },
          { label: '导出项目 JSON…', run: () => exportProject() },
          { label: '导入项目 JSON…', run: () => importProject() },
          { label: '背景：深灰', run: () => commit((current) => ({ ...current, bg: '#26262b' }), true) },
          { label: '背景：中性灰', run: () => commit((current) => ({ ...current, bg: '#5a5a60' }), true) },
          { label: '背景：浅色', run: () => commit((current) => ({ ...current, bg: '#e9e9ec' }), true) },
          { label: '背景：跟随主题', run: () => commit((current) => ({ ...current, bg: '' }), true) },
          { separator: true },
          { label: '撤销 (Ctrl+Z)', run: () => undo() },
          { label: '重做 (Ctrl+Shift+Z)', run: () => redo() },
          { separator: true },
          {
            label: '清空画布',
            run: () => {
              for (const item of board?.items ?? []) {
                if (item.kind !== 'text') requestJson('/remove', { method: 'POST', body: { path: item.path } }).catch(() => {});
              }
              selectIds([]);
              commit((current) => ({ ...current, items: [] }), true);
            },
          },
          ...(mode === 'view'
            ? []
            : [
                { separator: true },
                { label: '隐藏面板', run: () => commit((current) => ({ ...current, open: false }), true) },
              ]),
        ];
      }, [
        addText,
        arrange,
        board,
        commit,
        copyPath,
        editText,
        exportArea,
        exportPng,
        exportProject,
        fitSelection,
        fitView,
        flash,
        groupSelection,
        importProject,
        ingestFiles,
        ingestSrcs,
        layerItem,
        menu,
        mode,
        nudgeLayer,
        persistView,
        pushToComposer,
        redo,
        removeItem,
        revealItem,
        rotateBy,
        selectIds,
        undo,
        ungroupSelection,
      ]);

      /* ------------------------------ render ------------------------------ */

      if (!sessionId) return null;
      if (board === null) return null;

      const items = board.items ?? [];
      const isView = mode === 'view';

      /* The floating entry pill is gone on purpose: the board is reached from its Conversation tab. */
      if (!isView && !board.open) return null;

      const style = isView ? undefined : { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
      const rootClass = isView ? 'dsh-rb-root dsh-rb-root-view' : 'dsh-rb-root';
      const panelClass = `dsh-rb-panel${isView ? ' dsh-rb-panel-inline' : ''}${dragOver ? ' is-drop' : ''}${focusRing ? ' is-focus' : ''}`;

      return h(
        'div',
        { className: rootClass },
        h(
          'div',
          {
            ref: rootRef,
            className: panelClass,
            style,
            tabIndex: 0,
            onFocus: () => setFocusRing(true),
            onBlur: () => setFocusRing(false),
            onDragOver,
            onDragEnter: onDragOver,
            onDragLeave: (event) => {
              if (event.currentTarget.contains(event.relatedTarget)) return;
              setDragOver(false);
            },
            onDrop,
            onContextMenu: (event) => {
              if (event.target instanceof HTMLElement && event.target.closest('.dsh-rb-card')) return;
              openPanelMenu(event);
            },
          },
          h(
            'div',
            { className: 'dsh-rb-head', onPointerDown: isView ? undefined : startWindowDrag, title: isView ? undefined : '拖动移动' },
            isView ? null : h('span', { className: 'dsh-rb-grip', 'aria-hidden': 'true' }),
            h('span', { className: 'dsh-rb-title' }, '图片集'),
            h('span', { className: 'dsh-rb-count' }, items.length > 0 ? String(items.length) : '空'),
            busy > 0 ? h('span', { className: 'dsh-rb-busy' }, '放入中…') : null,
            h('span', { className: 'dsh-rb-head-spacer' }),
            h('button', {
              type: 'button',
              className: 'dsh-rb-icon-btn',
              title: '选择图片',
              onPointerDown: (event) => event.stopPropagation(),
              onClick: () => fileInputRef.current?.click(),
            }, '+'),
            h('button', {
              type: 'button',
              className: 'dsh-rb-icon-btn',
              title: '适应窗口 (F)',
              onPointerDown: (event) => event.stopPropagation(),
              onClick: () => fitView(),
            }, '⤢'),
            h('button', {
              type: 'button',
              className: 'dsh-rb-icon-btn',
              title: '添加文字 (T)',
              onPointerDown: (event) => event.stopPropagation(),
              onClick: () => addText(),
            }, 'T'),
            h('button', {
              type: 'button',
              className: 'dsh-rb-icon-btn',
              title: '撤销 (Ctrl+Z)',
              onPointerDown: (event) => event.stopPropagation(),
              onClick: () => undo(),
            }, '↶'),
            h('button', {
              type: 'button',
              className: 'dsh-rb-icon-btn',
              title: '重做 (Ctrl+Shift+Z)',
              onPointerDown: (event) => event.stopPropagation(),
              onClick: () => redo(),
            }, '↷'),
            isView
              ? null
              : h('button', {
                type: 'button',
                className: 'dsh-rb-icon-btn',
                title: '隐藏（右键可再打开）',
                onPointerDown: (event) => event.stopPropagation(),
                onClick: toggle,
            }, '—'),
          ),
          h(
            'div',
            {
              ref: setCanvasEl,
              className: `dsh-rb-body dsh-rb-canvas${panning ? ' is-panning' : ''}`,
              style: board.bg ? { backgroundColor: board.bg } : undefined,
              onPointerDown: onCanvasPointerDown,
            },
            h(
              'div',
              {
                className: 'dsh-rb-stage',
                style: { transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.s})` },
              },
              items.map((item) =>
                h(
                  'div',
                  {
                    key: item.id,
                    className: `dsh-rb-card${selection.has(item.id) ? ' is-sel' : ''}${item.kind === 'text' ? ' is-text' : ''}`,
                    style: {
                      left: `${item.x}px`,
                      top: `${item.y}px`,
                      width: `${item.w}px`,
                      height: `${item.h}px`,
                      transform: item.rot ? `rotate(${item.rot}deg)` : undefined,
                    },
                    title: item.kind === 'text'
                      ? '双击编辑 · 右键更多'
                      : `${item.name}\n拖动摆位 · 双击加入输入框`,
                    onPointerDown: (event) => onCardPointerDown(event, item),
                    onContextMenu: (event) => openItemMenu(event, item),
                    onDoubleClick: () => {
                      if (item.kind === 'text') editText(item);
                      else pushToComposer([item]);
                    },
                  },
                  item.kind === 'text'
                    ? h('div', {
                      className: 'dsh-rb-text',
                      style: { fontSize: `${item.fontSize || 15}px`, color: item.color || undefined },
                    }, String(item.text ?? ''))
                    : h('img', {
                      src: fileSrc(item.path),
                      alt: item.name,
                      draggable: false,
                      loading: 'lazy',
                    }),
                  selection.has(item.id)
                    ? h('span', {
                      className: 'dsh-rb-handle',
                      onPointerDown: (event) => startResize(event, item),
                    })
                    : null,
                  selection.has(item.id) && selection.size === 1
                    ? h('span', {
                      className: 'dsh-rb-rotate',
                      onPointerDown: (event) => startRotate(event, item),
                    })
                    : null,
                ),
              ),
            ),
            marquee === null
              ? null
              : h('div', {
                className: 'dsh-rb-marquee',
                style: {
                  left: `${Math.min(marquee.x0, marquee.x1)}px`,
                  top: `${Math.min(marquee.y0, marquee.y1)}px`,
                  width: `${Math.abs(marquee.x1 - marquee.x0)}px`,
                  height: `${Math.abs(marquee.y1 - marquee.y0)}px`,
                },
              }),
            items.length === 0
              ? h(
                'div',
                { className: 'dsh-rb-empty' },
                h('div', { className: 'dsh-rb-empty-title' }, '把图拖进来'),
                h('div', { className: 'dsh-rb-empty-hint' }, '从资源管理器拖文件'),
                h('div', { className: 'dsh-rb-empty-hint' }, '从对话里拖图片，或右键图片'),
                h('div', { className: 'dsh-rb-empty-hint' }, '聚焦面板后 Ctrl+V 粘贴'),
              )
              : null,
            h(
              'div',
              { className: 'dsh-rb-hud' },
              `${Math.round(view.s * 100)}%${selection.size > 0 ? ` · 选中 ${selection.size}` : ''}`,
            ),
          ),
          isView
            ? (notice ? h('div', { className: 'dsh-rb-toast' }, notice) : null)
            : h('div', { className: 'dsh-rb-foot' }, notice || '拖动摆位 · 滚轮缩放 · 按住 Alt/中键平移 · 双击入框'),
          isView ? null : h('div', { className: 'dsh-rb-resize', onPointerDown: startWindowResize, title: '拖动调整大小' }),
        ),
        h('input', {
          ref: fileInputRef,
          type: 'file',
          accept: 'image/*',
          multiple: true,
          style: { display: 'none' },
          onChange: (event) => {
            ingestFiles(event.target.files);
            event.target.value = '';
          },
        }),
        editor === null
          ? null
          : h(
            'div',
            {
              className: 'dsh-rb-dialog',
              onPointerDown: (event) => event.stopPropagation(),
              onContextMenu: (event) => event.preventDefault(),
            },
            h('div', { className: 'dsh-rb-dialog-title' }, '文字'),
            h('textarea', {
              className: 'dsh-rb-dialog-input',
              value: editor.value,
              autoFocus: true,
              spellCheck: false,
              onChange: (event) => setEditor({ ...editor, value: event.target.value }),
              onKeyDown: (event) => {
                event.stopPropagation();
                if (event.key === 'Escape') setEditor(null);
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) applyEdit();
              },
            }),
            h(
              'div',
              { className: 'dsh-rb-dialog-fields' },
              h('label', { className: 'dsh-rb-field' }, '字号',
                h('input', {
                  className: 'dsh-rb-field-input',
                  type: 'number',
                  min: 8,
                  max: 96,
                  value: editor.fontSize,
                  onChange: (event) => setEditor({ ...editor, fontSize: Number(event.target.value) || 15 }),
                })),
              h('label', { className: 'dsh-rb-field' }, '颜色',
                h('input', {
                  className: 'dsh-rb-field-swatch',
                  type: 'color',
                  value: /^#[0-9a-f]{6}$/i.test(String(editor.color ?? '')) ? editor.color : '#ededf0',
                  onChange: (event) => setEditor({ ...editor, color: event.target.value }),
                }),
                h('button', {
                  type: 'button',
                  className: 'dsh-rb-btn is-tiny',
                  onClick: () => setEditor({ ...editor, color: '' }),
                }, '跟随主题')),
            ),
            h(
              'div',
              { className: 'dsh-rb-dialog-row' },
              h('button', { type: 'button', className: 'dsh-rb-btn', onClick: () => setEditor(null) }, '取消'),
              h('button', { type: 'button', className: 'dsh-rb-btn is-primary', onClick: () => applyEdit() }, '确定'),
            ),
          ),
        menu === null
          ? null
          : h(
            'div',
            {
              ref: menuRef,
              className: 'dsh-rb-menu',
              style: {
                left: menuBox.left,
                top: menuBox.top,
                visibility: menuBox.ready ? 'visible' : 'hidden',
                maxHeight: Math.max(160, window.innerHeight - 24),
              },
              onPointerDown: (event) => event.stopPropagation(),
              onContextMenu: (event) => event.preventDefault(),
            },
            menuActions.map((action, index) =>
              action.separator
                ? h('div', { key: `s${index}`, className: 'dsh-rb-menu-sep' })
                : h(
                  'button',
                  {
                    key: action.label,
                    type: 'button',
                    className: 'dsh-rb-menu-item',
                    onClick: () => {
                      setMenu(null);
                      Promise.resolve(action.run()).catch(() => {});
                    },
                  },
                  action.label,
                ),
            ),
          ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* helpers that need the module scope                                  */
    /* ------------------------------------------------------------------ */

    /** Keep a board failure from taking the whole overlay layer down with it. */
    class BoardBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error, info) {
        trace('render-crash', {
          message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          stack: error instanceof Error ? String(error.stack).slice(0, 1200) : '',
          component: String(info?.componentStack ?? '').slice(0, 1200),
        });
        try {
          console.error('[session-ref-board]', error);
        } catch {
          /* console may be gone */
        }
      }

      render() {
        if (this.state.failed) return null;
        return this.props.children;
      }
    }


    /** The same board rendered as a Conversation tab instead of a floating window. */
    function BoardViewSlot(props) {
      return h(
        BoardBoundary,
        null,
        h(RefBoard, {
          mode: 'view',
          sessionId: props?.sessionId,
          inputActions: props?.inputActions,
        }),
      );
    }

    async function copyText(text, flash) {
      try {
        await navigator.clipboard.writeText(text);
        flash('已复制');
      } catch {
        flash('复制失败');
      }
    }

    async function pasteFromClipboard(ingestFiles, flash) {
      try {
        if (!navigator.clipboard?.read) {
          flash('请聚焦面板后按 Ctrl+V');
          return;
        }
        const entries = await navigator.clipboard.read();
        const files = [];
        for (const entry of entries) {
          const type = entry.types.find((value) => value.startsWith('image/'));
          if (!type) continue;
          const blob = await entry.getType(type);
          const ext = type.split('/')[1] || 'png';
          files.push(new File([blob], `clipboard-${Date.now().toString(36)}.${ext}`, { type }));
        }
        if (files.length === 0) {
          flash('剪贴板里没有图片');
          return;
        }
        ingestFiles(files);
      } catch {
        flash('读剪贴板失败，试试 Ctrl+V');
      }
    }

    /* ------------------------------------------------------------------ */
    /* styles                                                              */
    /* ------------------------------------------------------------------ */

    const CSS = `
.dsh-rb-root { position: fixed; inset: 0; pointer-events: none; z-index: 70; }
.dsh-rb-root-view {
  position: relative; inset: auto; z-index: 0; display: flex;
  height: 100%; max-height: 100%; min-height: 0; overflow: hidden;
  pointer-events: auto;
}
.dsh-rb-panel.dsh-rb-panel-inline {
  position: relative; inset: auto; left: auto; top: auto;
  width: 100%; height: 100%; min-height: 0; border-radius: 0;
  border: 0 !important; outline: 0;
  box-shadow: none !important; background: transparent; overflow: hidden;
  /* backdrop-filter would turn this panel into the containing block of the fixed menu
     and then clip it; the inline view has no surface to blur anyway. */
  backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
}
.dsh-rb-panel.dsh-rb-panel-inline.is-focus,
.dsh-rb-panel.dsh-rb-panel-inline.is-drop { border: 0 !important; box-shadow: none !important; }
.dsh-rb-panel-inline .dsh-rb-head {
  cursor: default; background: transparent;
  border-bottom: 0; padding: 14px 24px 8px;
}
.dsh-rb-panel-inline .dsh-rb-title {
  font-size: 11.5px; font-weight: 500; letter-spacing: .04em;
  color: var(--dsw-alias-label-caption, #9a9aa1);
}
.dsh-rb-panel-inline .dsh-rb-count {
  background: transparent; padding: 0 0 0 2px;
  color: var(--dsw-alias-label-dimmed, #85858c);
}
.dsh-rb-panel-inline .dsh-rb-body { padding: 0; }
.dsh-rb-panel-inline .dsh-rb-empty { max-width: 320px; }
.dsh-rb-panel-inline .dsh-rb-empty-title { font-size: 13px; }
.dsh-rb-panel-inline .dsh-rb-empty-hint { font-size: 11.5px; }
.dsh-rb-toast {
  position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%);
  padding: 5px 12px; border-radius: 99px; font-size: 11px; line-height: 1.4;
  color: var(--dsw-alias-label-primary, #ececef); pointer-events: none; z-index: 5;
  background: color-mix(in srgb, var(--we-chat-surface-tint, var(--dsw-alias-bg-overlay, #232327)) 92%, transparent);
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.13));
}

.dsh-rb-panel {
  position: fixed; display: flex; flex-direction: column; pointer-events: auto;
  border-radius: 14px; overflow: hidden; outline: none;
  color: var(--dsw-alias-label-primary, #ececef);
  background: color-mix(in srgb, var(--we-chat-surface-tint, var(--dsw-alias-bg-layer-2, #1b1b1f)) 88%, transparent);
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.13));
  box-shadow: 0 20px 52px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.05);
  backdrop-filter: blur(var(--we-sidebar-blur, 20px)) saturate(var(--we-sidebar-saturate, 1.32));
}
.dsh-rb-panel.is-focus { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 55%, var(--dsw-alias-border-l1, rgba(255,255,255,.13))); }
.dsh-rb-panel.is-drop {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 40%, transparent), 0 20px 52px rgba(0,0,0,.34);
}

.dsh-rb-head {
  display: flex; align-items: center; gap: 7px; padding: 7px 8px 7px 9px;
  cursor: grab; user-select: none; touch-action: none;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #17171a) 55%, transparent);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.09));
}
.dsh-rb-head:active { cursor: grabbing; }
.dsh-rb-grip {
  width: 12px; height: 12px; flex: none; opacity: .5;
  background-image: radial-gradient(currentColor 1px, transparent 1px);
  background-size: 4px 4px; border-radius: 2px;
}
.dsh-rb-title { font-size: 12px; font-weight: 600; letter-spacing: .2px; }
.dsh-rb-count {
  font-size: 10.5px; line-height: 1; padding: 2px 6px; border-radius: 99px;
  color: var(--dsw-alias-label-caption, #9a9aa1);
  background: color-mix(in srgb, var(--dsw-alias-label-caption, #9a9aa1) 16%, transparent);
}
.dsh-rb-busy { font-size: 10.5px; color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dsh-rb-head-spacer { flex: 1 1 auto; }
.dsh-rb-icon-btn {
  width: 22px; height: 22px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 6px; border: 1px solid transparent; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary, #b4b4ba); font: inherit; font-size: 13px; line-height: 1;
}
.dsh-rb-icon-btn:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #ececef) 10%, transparent);
  color: var(--dsw-alias-label-primary, #ececef);
}

.dsh-rb-body { flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 0; position: relative; }
.dsh-rb-canvas {
  touch-action: none; cursor: default;
  background-image: radial-gradient(
    color-mix(in srgb, var(--dsw-alias-label-caption, #888) 20%, transparent) 1px,
    transparent 1px
  );
  background-size: 22px 22px;
}
.dsh-rb-canvas.is-panning { cursor: grabbing; }
.dsh-rb-stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
.dsh-rb-card {
  position: absolute; margin: 0; padding: 0; line-height: 0; overflow: hidden;
  border-radius: 6px; cursor: move; background: transparent; outline: 0;
  box-shadow: 0 3px 12px rgba(0, 0, 0, .28);
}
.dsh-rb-card img {
  display: block; width: 100%; height: 100%; object-fit: contain;
  pointer-events: none; user-select: none; -webkit-user-drag: none;
}
.dsh-rb-card.is-sel {
  box-shadow: 0 0 0 1.5px var(--dsw-alias-brand-primary, #4d6bfe), 0 6px 18px rgba(0, 0, 0, .3);
}
.dsh-rb-handle {
  position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  clip-path: polygon(100% 0, 100% 100%, 0 100%);
}
.dsh-rb-card.is-text { background: transparent; box-shadow: none; }
.dsh-rb-text {
  width: 100%; height: 100%; overflow: hidden; white-space: pre-wrap; box-sizing: border-box;
  padding: 2px 4px; line-height: 1.4; cursor: move;
  color: var(--dsw-alias-label-primary, #ececef);
  font-family: inherit;
}
.dsh-rb-card.is-sel.is-text .dsh-rb-text { outline: none; }
.dsh-rb-rotate {
  position: absolute; left: 50%; top: -20px; width: 11px; height: 11px; margin-left: -5.5px;
  border-radius: 50%; cursor: grab;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  border: 1.5px solid var(--dsw-alias-bg-base, #101013);
}
.dsh-rb-dialog {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 90;
  display: flex; flex-direction: column; gap: 8px; width: 300px; padding: 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--we-chat-surface-tint, var(--dsw-alias-bg-overlay, #232327)) 96%, transparent);
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16));
  box-shadow: 0 18px 44px rgba(0,0,0,.42);
  backdrop-filter: blur(var(--we-sidebar-blur, 20px)) saturate(var(--we-sidebar-saturate, 1.3));
}
.dsh-rb-dialog-title { font-size: 11.5px; color: var(--dsw-alias-label-caption, #9a9aa1); }
.dsh-rb-dialog-fields { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dsh-rb-field {
  display: flex; align-items: center; gap: 6px;
  font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b6b73);
}
.dsh-rb-field-input {
  width: 58px; padding: 3px 6px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
  background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1b1b1f);
  font: inherit; font-size: 11.5px;
}
.dsh-rb-field-swatch {
  width: 26px; height: 22px; padding: 0; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); background: transparent;
}
.dsh-rb-btn.is-tiny { padding: 2px 8px; font-size: 11px; }
.dsh-rb-dialog-input {
  width: 100%; min-height: 84px; resize: vertical; box-sizing: border-box;
  padding: 7px 8px; border-radius: 8px; font: inherit; font-size: 12.5px; line-height: 1.5;
  color: var(--dsw-alias-label-primary, #ececef);
  background: var(--dsw-alias-bg-layer-1, #17171a);
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16));
}
.dsh-rb-dialog-row { display: flex; justify-content: flex-end; gap: 8px; }
.dsh-rb-btn {
  padding: 5px 11px; border-radius: 7px; cursor: pointer; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-secondary, #b9b9bd);
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12));
}
.dsh-rb-btn:hover { color: var(--dsw-alias-label-primary, #ececef); }
.dsh-rb-btn.is-primary {
  color: #fff; border-color: transparent;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
}
.dsh-rb-marquee {
  position: absolute; z-index: 3; pointer-events: none;
  border: 1px solid var(--dsw-alias-brand-primary, #4d6bfe);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 14%, transparent);
}
.dsh-rb-hud {
  position: absolute; right: 8px; bottom: 6px; z-index: 4; pointer-events: none;
  font-size: 10.5px; line-height: 1; padding: 3px 6px; border-radius: 6px;
  color: var(--dsw-alias-label-dimmed, #85858c);
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #101013) 40%, transparent);
}

.dsh-rb-empty {
  position: absolute; left: 50%; top: 44%; transform: translate(-50%, -50%);
  z-index: 2; pointer-events: none; display: flex; flex-direction: column; align-items: center;
  gap: 4px; text-align: center; padding: 22px 20px; max-width: 300px;
  border: 1px dashed color-mix(in srgb, var(--dsw-alias-label-caption, #888) 42%, transparent);
  border-radius: 12px; color: var(--dsw-alias-label-caption, #96969d);
  background: color-mix(in srgb, var(--we-chat-surface-tint, var(--dsw-alias-bg-layer-1, #1b1b1f)) 55%, transparent);
}
.dsh-rb-empty-title { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-secondary, #b9b9bf); }
.dsh-rb-empty-hint { font-size: 11px; line-height: 1.5; }

.dsh-rb-foot {
  flex: none; padding: 5px 10px 7px; font-size: 10.5px; line-height: 1.4;
  color: var(--dsw-alias-label-dimmed, #85858c);
  border-top: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(255,255,255,.09)) 70%, transparent);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dsh-rb-resize {
  position: absolute; right: 2px; bottom: 2px; width: 14px; height: 14px; cursor: nwse-resize;
  background-image: linear-gradient(135deg, transparent 45%, color-mix(in srgb, var(--dsw-alias-label-caption, #888) 70%, transparent) 45%, color-mix(in srgb, var(--dsw-alias-label-caption, #888) 70%, transparent) 55%, transparent 55%);
  touch-action: none;
}

/* The app-wide drop invitation is a full-window blur mask owned by ui-attachment; while this
   board owns file drops it only hides the target, so keep it from painting. Hashed class on
   purpose: if that package renames it, this rule simply stops matching. */
.mwbuSa_mask { display: none !important; }

.dsh-rb-menu {
  position: fixed; pointer-events: auto; min-width: 178px; padding: 5px; box-sizing: border-box;
  border-radius: 10px; z-index: 140; max-height: min(68vh, 520px); overflow: auto;
  overscroll-behavior: contain;
  background: color-mix(in srgb, var(--we-chat-surface-tint, var(--dsw-alias-bg-overlay, #232327)) 94%, transparent);
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16));
  box-shadow: 0 16px 40px rgba(0,0,0,.4);
  backdrop-filter: blur(var(--we-sidebar-blur, 20px)) saturate(var(--we-sidebar-saturate, 1.3));
}
.dsh-rb-menu-item {
  display: block; width: 100%; text-align: left; padding: 6px 9px; border-radius: 6px;
  border: none; background: transparent; cursor: pointer; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-primary, #ececef);
}
.dsh-rb-menu-item:hover {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 22%, transparent);
}
.dsh-rb-menu-sep {
  height: 1px; margin: 4px 6px;
  background: color-mix(in srgb, var(--dsw-alias-border-l1, rgba(255,255,255,.1)) 90%, transparent);
}
`;

    return {
      inject: ['slots'],
      apply(ctx) {
        ctxRef = ctx;
        ctx.effect(() => {
          // Cordis rejects direct reads of services absent from inject.
          const styles = ctx.get('styles');
          if (typeof styles?.insert === 'function') {
            const dispose = styles.insert(CSS);
            return () => {
              if (typeof dispose === 'function') dispose();
            };
          }
          const tag = document.createElement('style');
          tag.setAttribute('data-plugin-css', SLOT_ID);
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => {
            if (tag.parentNode) tag.parentNode.removeChild(tag);
          };
        }, 'session-ref-board styles');
        ctx.effect(() => {
          // While a file drag hovers the board, keep the app-wide "drop files here" invitation out of it:
          // the board owns that drop, so the foreign overlay would only cover the target.
          const boardRegion = () => {
            if (typeof bridge.region === 'function') {
              const own = bridge.region();
              if (own) return own;
            }
            if (typeof document === 'undefined') return null;
            const canvas = document.querySelector('.dsh-rb-canvas') ?? document.querySelector('.dsh-rb-root');
            return canvas ? canvas.getBoundingClientRect() : null;
          };
          const describe = (event) => {
            const target = event.target;
            const region = boardRegion();
            return {
              target: typeof Element !== 'undefined' && target instanceof Element
                ? `<${target.tagName.toLowerCase()} class="${target.getAttribute('class') ?? ''}">`
                : String(target),
              inside: typeof Element !== 'undefined' && target instanceof Element && target.closest('.dsh-rb-root') !== null,
              point: [Math.round(event.clientX), Math.round(event.clientY)],
              region: region && [Math.round(region.left), Math.round(region.top), Math.round(region.right), Math.round(region.bottom)],
              types: Array.from(event.dataTransfer?.types ?? []),
              files: event.dataTransfer?.files?.length ?? 0,
              accept: typeof bridge.acceptDrop === 'function',
            };
          };
          const overBoard = (event) => {
            const target = event.target;
            if (typeof Element !== 'undefined' && target instanceof Element && target.closest('.dsh-rb-root') !== null) return true;
            // A foreign drop overlay can sit on top: fall back to the board's own rectangle.
            const region = boardRegion();
            if (!region) return false;
            return event.clientX >= region.left && event.clientX <= region.right
              && event.clientY >= region.top && event.clientY <= region.bottom;
          };
          const guard = (event) => {
            const types = Array.from(event.dataTransfer?.types ?? []);
            if (!types.includes('Files')) return;
            // Stop the app-wide "drop files here" invitation from activating at all: it blurs the
            // whole window and hides the target the user is aiming at. The drop still lands,
            // because allowing it (preventDefault here) is what keeps drop events firing.
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
          };
          const onDrop = (event) => {
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (files.length === 0) return;
            const mine = overBoard(event);
            trace('capture-drop', { ...describe(event), mine });
            if (!mine) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (typeof bridge.acceptDrop === 'function') bridge.acceptDrop(files, { clientX: event.clientX, clientY: event.clientY });
            else trace('capture-drop-no-accept', describe(event));
          };
          document.addEventListener('dragenter', guard, true);
          document.addEventListener('dragover', guard, true);
          document.addEventListener('drop', onDrop, true);
          return () => {
            document.removeEventListener('dragenter', guard, true);
            document.removeEventListener('dragover', guard, true);
            document.removeEventListener('drop', onDrop, true);
          };
        }, 'session-ref-board drop guard');
        ctx.effect(() => {
          const onContextMenu = (event) => {
            if (typeof bridge.openExternal !== 'function') return;
            bridge.openExternal(event);
          };
          document.addEventListener('contextmenu', onContextMenu, true);
          return () => document.removeEventListener('contextmenu', onContextMenu, true);
        }, 'session-ref-board external context menu');

        ctx.effect(
          () =>
            ctx.slots.inject(VIEW_SLOT, () =>
              ctx.slots.register(
                {
                  name: VIEW_SLOT,
                  id: VIEW_ID,
                  order: 40,
                  label: '图片集',
                },
                BoardViewSlot,
              ),
            ),
          'session-ref-board view tab',
        );
      },
    };
  },
});
