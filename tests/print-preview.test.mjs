import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function harness({ blocked = false, closeAllowed = true, sourceClosed = false } = {}) {
  const handlers = {}, events = [], timers = [];
  let html = "";
  const popup = {
    closed: false,
    document: {
      write(value) { html = value; }, close() {},
      getElementById(id) { return html.includes(`id="${id}"`) ? { addEventListener(event, callback) { handlers[id] = callback; } } : null; },
    },
    location: { replace(url) { events.push(["navigate", url]); } },
    focus() { events.push(["preview-focus"]); }, close() { events.push(["close"]); this.closed = closeAllowed; }, print() { events.push(["print"]); },
  };
  const window = { closed: sourceClosed, location: { href: "https://keepsake.example/#/export" }, open: () => blocked ? null : popup, focus() { events.push(["source-focus"]); }, setTimeout(fn) { timers.push(fn); } };
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL("../app/print-preview.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, window });
  return { open: exports.openPrintPreview, popup, events, timers, handlers, html: () => html };
}
const document = '<!doctype html><html><head><title>Stories</title></head><body><h1>Stories</h1><p>A memory</p></body></html>';
test("print preview provides working Back and Print buttons and excludes controls from print", () => {
  const h = harness();
  assert.equal(h.open(document), true);
  assert.ok(h.html().includes("Back to Keepsake"));
  assert.ok(h.html().includes("@media print{.keepsake-print-controls,.print-help{display:none!important}"));
  assert.equal(h.popup.opener, null);
  h.handlers["keepsake-print-now"]();
  assert.ok(h.events.some(([event]) => event === "print"));
  h.handlers["keepsake-print-back"]();
  assert.equal(h.popup.closed, true);
  assert.ok(h.events.some(([event]) => event === "source-focus"));
  assert.equal(h.events.some(([event]) => event === "navigate"), false);
});
test("Back falls back to the export route when a mobile browser cannot close the tab", () => {
  for (const options of [{ closeAllowed: false }, { sourceClosed: true }]) {
    const h = harness(options);
    h.open(document);
    h.handlers["keepsake-print-back"]();
    assert.deepEqual(h.events.at(-1), ["navigate", "https://keepsake.example/#/export"]);
  }
});
test("story printing retains auto-print while custom preview waits for the Print button", () => {
  const h = harness();
  h.open(document, true);
  assert.equal(h.timers.length, 1);
  h.timers[0]();
  assert.ok(h.events.some(([event]) => event === "print"));
  const custom = harness(); custom.open(document);
  assert.equal(custom.timers.length, 0);
  const blocked = harness({ blocked: true });
  assert.equal(blocked.open(document), false);
});
