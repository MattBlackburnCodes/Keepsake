import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function mockedModule(file, mocks, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => mocks[name] ?? {}, URL, URLSearchParams, console, ...globals });
  return exports;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const person = { id: 123, name: 'Person', image: '', cover: '', birthday: '', relationship: 'Friend', favorites: [] };
const profile = { id: 'profile-123', personId: 123, type: 'profile', url: 'blob:decrypted-profile', size: 10 };
const cover = { id: 'cover-123', personId: 123, type: 'cover', url: 'blob:decrypted-cover', size: 10 };

function harness(loadMedia, loadState = async () => ({ people: [person], notes: [], inbox: [], reminders: { enabled: false }, darkMode: false })) {
  const states = [], deps = [], cleanups = [], listeners = {};
  let cursor = 0, effects = [], authCallback, loads = 0, saves = 0;
  const jsx = (type, props) => ({ type, props });
  const firebaseUser = { uid: 'owner', email: 'owner@example.com', emailVerified: true, displayName: 'Owner' };
  const react = {
    useState: initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef: initial => { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useEffect: (fn, next) => { const i = cursor++; if (!deps[i] || next.some((v, j) => v !== deps[i][j])) { deps[i] = next; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const app = mockedModule('../app/page.tsx', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'firebase/auth': { onAuthStateChanged: (_auth, cb) => { authCallback = cb; return () => {}; }, getIdTokenResult: async () => ({ claims: {} }) },
    './firebase': { auth: { currentUser: firebaseUser }, initializeAnalytics: async () => null },
    './e2ee': { E2EE_ENABLED: false },
    './subscriptions': {},
    './firebase-data': { ensureUserProfile: async () => {}, loadCloudState: loadState, loadCloudMedia: async (_uid, onError) => { loads++; return loadMedia(onError); }, saveCloudState: async () => { saves++; } },
  }, { localStorage: { getItem: () => null, setItem() {} }, document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, documentElement: { dataset: {} } }, window: { location: { hash: '/people/123', search: '' }, addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener() {}, setTimeout: () => 1, clearTimeout() {} } });
  return {
    render() { cursor = 0; return app.default(); },
    flush() { const pending = effects; effects = []; pending.forEach(fn => fn()); },
    async login() { authCallback(firebaseUser); await tick(); },
    counts: () => ({ loads, saves }),
    people: () => states[6], media: () => states[7],
    retry() { const node = this.render(); const find = value => { if (!value || typeof value !== 'object') return; if (value.type === 'button' && value.props.children === 'Retry media') return value; for (const child of Object.values(value)) { if (typeof child === 'function') continue; const match = find(child); if (match) return match; } }; const button = find(node); assert.ok(button); button.props.onClick(); },
  };
}
async function start(h) { h.render(); h.flush(); await h.login(); h.render(); h.flush(); await tick(); h.render(); h.flush(); await tick(); }

test('replacing the same signed-in user does not reload or clear profile and cover images', async () => {
  const h = harness(async () => [profile, cover]); await start(h);
  assert.equal(h.people()[0].image, profile.url); assert.equal(h.people()[0].cover, cover.url);
  await h.login(); h.render(); h.flush(); await tick();
  assert.equal(h.counts().loads, 1); assert.equal(h.people()[0].image, profile.url); assert.equal(h.people()[0].cover, cover.url);
});
test('retry preserves available photos if the encrypted download fails', async () => {
  let attempt = 0;
  const h = harness(async onError => { attempt++; if (attempt === 1) { onError(cover.id, Error('offline')); return [profile]; } onError(profile.id, Error('offline')); return [cover]; });
  await start(h); assert.equal(h.people()[0].image, profile.url);
  h.retry(); h.render(); h.flush(); await tick(); h.render(); h.flush(); await tick();
  assert.equal(h.people()[0].image, profile.url); assert.equal(h.people()[0].cover, cover.url);
  assert.match(JSON.stringify(h.render()), /Some media could not be loaded/);
});
test('failed initial account load keeps edits blocked and never saves empty state', async () => {
  const h = harness(async () => [], async () => { throw Error('offline'); }); await start(h);
  assert.match(JSON.stringify(h.render()), /Your saved memories could not be loaded/);
  assert.equal(h.counts().saves, 0);
});
test('encrypted media loader reports a failed file and continues decrypting other media', async () => {
  const errors = [];
  const api = mockedModule('../app/firebase-data.ts', {
    './firebase': { db: {}, storage: {} },
    'firebase/firestore': { collection: () => ({}), getDocs: async () => ({ docs: [profile, cover].map(item => ({ id: item.id, data: () => ({ cryptoVersion: 1, metadata: item, storagePath: item.id }) })) }) },
    'firebase/storage': { ref: (_storage, path) => path, getBlob: async path => { if (path === profile.id) throw Error('download failed'); return path; } },
    './e2ee': { E2EE_ENABLED: true, getSessionKey: () => ({}), decryptPayload: async (_key, item) => item, decryptMediaBlob: async () => new Blob(['photo'], { type: 'image/jpeg' }) },
  });
  const loaded = await api.loadCloudMedia('owner', (id, error) => errors.push({ id, error }));
  assert.equal(errors[0].id, profile.id); assert.equal(errors[0].error.message, 'download failed');
  assert.equal(loaded.length, 1); assert.equal(loaded[0].id, cover.id); assert.match(loaded[0].url, /^blob:/);
  URL.revokeObjectURL(loaded[0].url);
});
