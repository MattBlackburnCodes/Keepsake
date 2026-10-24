import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function load(file, mocks, globals = {}, suffix = "") {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8") + suffix, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => mocks[name] ?? {}, console, ...globals });
  return exports;
}
function find(node, predicate) {
  if (!node || typeof node !== "object") return;
  if (predicate(node)) return node;
  for (const value of Object.values(node)) { const match = find(value, predicate); if (match) return match; }
}
function all(node, predicate) {
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []), ...Object.values(node).flatMap(value => all(value, predicate))];
}
const files = [
  { id: "photo", personId: 1, type: "photo", name: "Small photo", size: 1024, url: "blob:photo" },
  { id: "video", personId: 2, type: "video", name: "Large video", size: 4096, url: "blob:video" },
  { id: "voice", personId: 0, type: "voice", name: "Quick voice", size: 2048, url: "blob:voice" },
];
function harness(deleteFile = async () => null, confirm = () => true) {
  const state = []; let cursor = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = value; }]; },
    useRef(initial) { const i = cursor++; return state[i] ??= { current: initial }; },
  };
  const jsx = (type, props) => ({ type, props });
  const api = load("../app/page.tsx", { react, "react/jsx-runtime": { jsx, jsxs: jsx } }, { window: { confirm } }, "\nexports.StorageManager = StorageManager; exports.formatFileSize = formatFileSize;");
  return { api, render() { cursor = 0; return api.StorageManager({ media: files, people: [{ id: 1, name: "Alex" }, { id: 2, name: "Sam" }], plan: "free", go() {}, deleteFile }); } };
}
test("storage lists largest files first and filters by person and type", () => {
  const h = harness();
  const rows = tree => all(tree, node => node.props?.className === "storage-file").map(node => node.props.children[0].props.children[1].props.children[0].props.children);
  assert.deepEqual(rows(h.render()), ["Large video", "Quick voice", "Small photo"]);
  all(h.render(), node => node.type === "select")[1].props.onChange({ target: { value: "1" } });
  assert.deepEqual(rows(h.render()), ["Small photo"]);
  all(h.render(), node => node.type === "select")[0].props.onChange({ target: { value: "video" } });
  assert.deepEqual(rows(h.render()), []);
  assert.ok(find(h.render(), node => node.type === "h2" && node.props.children === "No files match these filters"));
  assert.equal(h.api.formatFileSize(1024), "1.0 KB");
});
test("cleanup requires confirmation and reports failure without claiming freed storage", async () => {
  let deletes = 0;
  const cancelled = harness(async () => { deletes++; return null; }, () => false);
  await find(cancelled.render(), node => node.props?.["aria-label"] === "Delete Large video").props.onClick();
  assert.equal(deletes, 0);
  const failed = harness(async () => "Upload service offline");
  await find(failed.render(), node => node.props?.["aria-label"] === "Delete Large video").props.onClick();
  assert.equal(find(failed.render(), node => node.props?.role === "alert").props.children, "Upload service offline");
  const success = harness(async id => { assert.equal(id, "video"); return null; });
  await find(success.render(), node => node.props?.["aria-label"] === "Delete Large video").props.onClick();
  assert.match(find(success.render(), node => node.props?.role === "status").props.children, /4.0 KB freed/);
});
test("cloud cleanup preserves metadata on deletion failure, tolerates missing objects, and clears cache after success", async () => {
  for (const code of ["storage/unauthorized", "storage/object-not-found", null]) {
    let metadataDeleted = false, cacheDeleted = false;
    const api = load("../app/firebase-data.ts", {
      "./firebase": { db: {}, storage: {} },
      "firebase/firestore": { doc: () => ({}), getDoc: async () => ({ exists: () => true, data: () => ({ storagePath: "image.e2ee" }) }), deleteDoc: async () => { metadataDeleted = true; } },
      "firebase/storage": { ref: () => ({}), deleteObject: async () => { if (code) throw { code }; } },
      "./media-cache": { removeCachedMedia: async () => { cacheDeleted = true; } },
    });
    if (code === "storage/unauthorized") {
      await assert.rejects(api.deleteCloudMedia("owner", "photo"), error => error.code === code);
      assert.equal(metadataDeleted, false); assert.equal(cacheDeleted, false);
    } else {
      await api.deleteCloudMedia("owner", "photo");
      assert.equal(metadataDeleted, true); assert.equal(cacheDeleted, true);
    }
  }
});