import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function harness({ standalone = true, finePointer = false, unsupported = false, silent = false, printError = false, modalError = false } = {}) {
  const elements = [], events = [], timers = new Map();
  const windowHandlers = {};
  let timerId = 0;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.handlers = {}; this.attributes = {}; this.isConnected = true; elements.push(this); }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...children) { this.children.push(...children); for (const child of children) child.parent = this; }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    emit(name) { this.handlers[name]?.({ preventDefault() {} }); }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    focus() { events.push(this.tag === "original" ? "original-focus" : "focus"); }
    showModal() { if (modalError) throw Error("unsupported"); this.open = true; }
    close() { this.open = false; }
  }
  const frameHandlers = {};
  const frameWindow = {
    addEventListener(name, fn) { frameHandlers[name] = fn; },
    removeEventListener(name) { delete frameHandlers[name]; },
    focus() { events.push("frame-focus"); },
    ...(!unsupported ? { print() { if (printError) throw Error("not allowed"); events.push("print"); if (!silent) frameHandlers.beforeprint?.(); } } : {}),
  };
  const body = new Element("body"); body.style.overflow = "auto";
  const original = new Element("original");
  const document = { body, activeElement: original, createElement(tag) { const element = new Element(tag); if (tag === "iframe") element.contentWindow = frameWindow; return element; } };
  const window = {
    document, location: { href: "https://keepsake.example/#/export" },
    open() { throw Error("Installed website must not depend on popup tabs"); },
    matchMedia(query) { return { matches: query.includes("pointer") ? finePointer : standalone }; },
    addEventListener(name, fn) { windowHandlers[name] = fn; }, removeEventListener(name) { delete windowHandlers[name]; },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
  };
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL("../app/print-preview.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, window });
  return { open: exports.openPrintPreview, body, events, elements, windowHandlers, frameHandlers, timers,
    element(tag) { return elements.filter(element => element.tag === tag).at(-1); },
    button(text) { return elements.find(element => element.tag === "button" && element.textContent.includes(text)); },
    load() { this.element("iframe").emit("load"); },
    runTimers() { for (const fn of timers.values()) fn(); timers.clear(); },
  };
}
const html = '<!doctype html><html><head><title>Stories</title></head><body><h1>Stories</h1><p>A memory</p></body></html>';
test("installed website opens an in-app preview without a popup and prints only after a ready button tap", () => {
  const h = harness();
  assert.equal(h.open(html, true), true);
  assert.equal(h.element("dialog").open, true);
  assert.equal(h.button("Print").disabled, true);
  assert.equal(h.element("iframe").attributes.sandbox, "allow-same-origin allow-modals");
  assert.ok(h.element("iframe").srcdoc.includes("A memory"));
  assert.equal(h.element("iframe").srcdoc.includes("Back to Keepsake"), false);
  h.load();
  assert.equal(h.events.includes("print"), false);
  h.button("Print").emit("click");
  assert.equal(h.events.filter(event => event === "print").length, 1);
  h.frameHandlers.afterprint();
  assert.equal(h.button("Print").disabled, false);
  assert.equal(h.element("a").hidden, true);
});
test("Back and route navigation restore scrolling and focus without resetting export state", () => {
  for (const navigation of [false, true]) {
    const h = harness(); h.open(html); h.load();
    assert.equal(h.body.style.overflow, "hidden");
    if (navigation) h.windowHandlers.hashchange(); else h.button("Back").emit("click");
    assert.equal(h.element("dialog").isConnected, false);
    assert.equal(h.body.style.overflow, "auto");
    assert.ok(h.events.includes("original-focus"));
    assert.equal(h.windowHandlers.hashchange, undefined);
  }
});
test("unsupported, throwing and silently ignored printing provide a visible browser fallback", () => {
  for (const options of [{ unsupported: true }, { printError: true }, { silent: true }]) {
    const h = harness(options); h.open(html); h.load();
    h.button("Print").emit("click"); h.runTimers();
    assert.equal(h.element("a").hidden, false);
    assert.equal(h.element("a").href, "https://keepsake.example/#/export");
    assert.match(h.element("p").textContent, /Safari or Chrome/);
    assert.equal(h.button("Print").disabled, false);
  }
});
test("desktop story printing can auto-print after loading while mobile never auto-prints", () => {
  const desktop = harness({ standalone: false, finePointer: true }); desktop.open(html, true); desktop.load();
  assert.ok(desktop.events.includes("print"));
  const mobile = harness({ standalone: false }); mobile.open(html, true); mobile.load();
  assert.equal(mobile.events.includes("print"), false);
});
test("closing a preview cancels delayed feedback and reopening replaces the old dialog", () => {
  const h = harness(); h.open(html); h.load(); h.button("Print").emit("click");
  assert.equal(h.timers.size, 1);
  h.button("Back").emit("click");
  assert.equal(h.timers.size, 0);
  h.open(html); const first = h.element("dialog"); h.open(html);
  assert.equal(first.isConnected, false);
  assert.equal(h.body.children.filter(element => element.tag === "dialog").length, 1);
});
test("unavailable modal support reports failure without blocking the page", () => {
  const h = harness({ modalError: true });
  assert.equal(h.open(html), false);
  assert.equal(h.body.style.overflow, "auto");
  assert.equal(h.body.children.length, 0);
});
