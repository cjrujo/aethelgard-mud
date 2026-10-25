/** Real classic-script game modules in an isolated VM.
 * DOM, storage, timers, and omitted external services are test doubles.
 * Combat, campaign, movement, economy, saves, and rewards are never mocked.
 * This harness is not a browser or a model-inference quality test.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createHarness(options = {}) {
  const elements = new Map(), timers = new Map(), listeners = new Map();
  let nextTimer = 1;
  const storageData = options.storage instanceof Map ? options.storage : new Map(Object.entries(options.stored || {}));
  const storage = {
    data: storageData, failWrites: false,
    get length() { return storageData.size; },
    key(index) { return [...storageData.keys()][index] ?? null; },
    getItem(key) { return storageData.has(String(key)) ? storageData.get(String(key)) : null; },
    setItem(key, value) {
      if (storage.failWrites === true || (typeof storage.failWrites === 'function' && storage.failWrites(String(key), String(value)))) throw new Error('QuotaExceededError: test storage rejected write');
      storageData.set(String(key), String(value));
    },
    removeItem(key) { storageData.delete(String(key)); }, clear() { storageData.clear(); }
  };
  let document;
  function element(tag = 'div', id = '') {
    const classes = new Set(), attrs = new Map(), ownListeners = new Map();
    const node = {
      id, tagName: tag.toUpperCase(), nodeType: 1, style: {}, dataset: {}, children: [],
      value: '', checked: false, disabled: false, hidden: false, innerHTML: '', textContent: '',
      className: '', title: '', scrollTop: 0, scrollHeight: 0, clientHeight: 600,
      parentElement: null, isConnected: true,
      classList: {
        add: (...items) => items.forEach(item => classes.add(item)),
        remove: (...items) => items.forEach(item => classes.delete(item)),
        contains: item => classes.has(item),
        toggle(item, force) { const yes = force ?? !classes.has(item); if (yes) classes.add(item); else classes.delete(item); return yes; }
      },
      appendChild(child) { child.parentElement = node; node.children.push(child); if (child.id) elements.set(child.id, child); return child; },
      append(...children) { children.forEach(child => node.appendChild(child)); },
      prepend(child) { child.parentElement = node; node.children.unshift(child); if (child.id) elements.set(child.id, child); },
      remove() { node.isConnected = false; if (node.id) elements.delete(node.id); },
      replaceChildren(...children) { node.children = []; node.append(...children); },
      insertAdjacentHTML(_where, html) { node.innerHTML += html; },
      setAttribute(name, value) { attrs.set(name, String(value)); if (name === 'id') { node.id = String(value); elements.set(node.id, node); } },
      getAttribute: name => attrs.get(name) ?? null,
      removeAttribute: name => attrs.delete(name),
      querySelector(selector) { if (selector.startsWith('#')) return document.getElementById(selector.slice(1)); return null; },
      querySelectorAll() { return []; },
      addEventListener(name, fn) { if (!ownListeners.has(name)) ownListeners.set(name, []); ownListeners.get(name).push(fn); },
      removeEventListener(name, fn) { ownListeners.set(name, (ownListeners.get(name) || []).filter(x => x !== fn)); },
      dispatchEvent(event) { for (const fn of ownListeners.get(event.type) || []) fn.call(node, event); return true; },
      focus() { document.activeElement = node; }, blur() { if (document.activeElement === node) document.activeElement = null; },
      click() { if (!node.disabled && typeof node.onclick === 'function') node.onclick({ target: node }); },
      scrollIntoView() {}, scrollTo() {}, select() {},
      getBoundingClientRect() { return { x: 0, y: 0, width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600 }; }
    };
    return node;
  }
  const eventApi = {
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter(x => x !== fn)); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); return true; }
  };
  document = {
    ...eventApi, activeElement: null, hidden: false, baseURI: 'http://localhost:8000/index.html',
    documentElement: element('html'), head: element('head'), body: element('body'),
    getElementById(id) { if (!elements.has(id)) elements.set(id, element('div', id)); return elements.get(id); },
    createElement: tag => element(tag), createElementNS: (_namespace, tag) => element(tag),
    querySelector(selector) { return selector.startsWith('#') && !selector.includes(' ') ? document.getElementById(selector.slice(1)) : null; },
    querySelectorAll() { return []; }
  };
  const omittedAI = { resetSession() {}, mount() {}, render() {}, ensureState() {}, getStatus: () => ({ state: 'idle', backend: 'rules' }), isBusy: () => false };
  const omittedOnline = { disconnect() {}, ensureState() {}, isBusy: () => false, render() {}, open() {} };
  const setTimer = (fn, delay, repeat, args) => { const id = nextTimer++; timers.set(id, { fn, delay, repeat, args }); return id; };
  const globals = {
    console, document, navigator: { language: options.lang || 'en', onLine: true },
    location: { protocol: 'http:', origin: 'http://localhost:8000', href: 'http://localhost:8000/index.html', hostname: 'localhost' },
    localStorage: storage, sessionStorage: storage, crypto: webcrypto,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, Blob, Headers, Response, Request,
    Uint8Array, Uint32Array, ArrayBuffer, performance, structuredClone,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    setTimeout: (fn, delay, ...args) => setTimer(fn, delay, false, args),
    setInterval: (fn, delay, ...args) => setTimer(fn, delay, true, args),
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    requestAnimationFrame: fn => setTimer(fn, 0, false, [0]), cancelAnimationFrame: id => timers.delete(id),
    queueMicrotask, ...eventApi,
    CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    fetch: async () => { throw new Error('Unexpected network request in game logic test'); },
    AethelgardAI: omittedAI, OnlineRealm: omittedOnline,
    renderAiPanel() {}, renderOnlineHubUI() {},
    ...options.globals
  };
  globals.window = globals;
  globals.self = globals;
  const context = vm.createContext(globals);
  const run = (code, timeout = 10000) => vm.runInContext(code, context, { timeout });
  const modules = options.modules || ['core', 'gameplay', 'combat', 'auto-gather', 'map-controls', 'bootstrap'];
  for (const name of modules) {
    const file = name.endsWith('.js') ? name : `src/${name}.js`;
    const sourcePath = path.isAbsolute(file) ? file : path.join(projectRoot, file);
    new vm.Script(fs.readFileSync(sourcePath, 'utf8'), { filename: sourcePath, importModuleDynamically: options.importModuleDynamically }).runInContext(context, { timeout: 10000 });
  }
  if (modules.some(name => name === 'core' || name.endsWith('/core.js'))) {
    run(`state.lang = ${JSON.stringify(options.lang || 'en')};`);
    if (options.classId && options.classId !== 'vanguard') run(`selectedClassOption = ${JSON.stringify(options.classId)}; applyCharacterConfig();`);
    run(`if (typeof GameDirector !== 'undefined') { GameDirector.ensureState().seed = ${Number(options.seed ?? 1234) >>> 0}; }
      if (typeof CombatDirector !== 'undefined') CombatDirector.setSeedForTests(${Number(options.seed ?? 1234) >>> 0});
      computeDerivedStats();`);
  }
  if (options.boot) run('window.onload()');
  return {
    context, run, elements, document, storage: globals.localStorage, timers,
    json(code) { return JSON.parse(run(`JSON.stringify(${code})`)); },
    get state() { return run('state'); },
    flushTimers({ includeIntervals = false, limit = 50 } = {}) {
      let count = 0;
      for (const [id, timer] of [...timers]) {
        if (count >= limit) break;
        if (timer.repeat && !includeIntervals) continue;
        if (!timer.repeat) timers.delete(id);
        timer.fn(...timer.args); count++;
      }
      return count;
    },
    dispose() { timers.clear(); listeners.clear(); }
  };
}
