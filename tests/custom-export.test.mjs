import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function load(file, mocks = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => mocks[name] ?? {}, console, ...globals });
  return exports;
}
const api = load("../app/export-data.ts");
const source = {
  people: [
    { id: 1, name: "Alex", relationship: "Friend", birthday: "1990-01-01", color: "Blue", about: "PRIVATE BIO", favorites: [{ id: "gift", label: "Gift idea", value: "A telescope" }, { id: "size", label: "Clothing size", value: "Medium" }], milestones: [{ id: "anniversary", kind: "Special date", title: "Our trip", date: "2020-01-02", details: "PRIVATE TRIP" }] },
    { id: 2, name: "Sam", relationship: "Sibling", birthday: "1980-01-01", color: "Red", favorites: [{ id: "gift", label: "Gift idea", value: "PRIVATE OTHER PERSON" }] },
  ],
  notes: [{ id: "private", personId: 1, title: "Private note", body: "PRIVATE STORY", createdAt: "Today" }, { id: "other", personId: 2, title: "Other note", body: "OTHER STORY", createdAt: "Today" }],
  media: [
    { id: "photo", personId: 1, type: "photo", name: "photo.jpg", caption: "Our day", size: 1024, url: "blob:private-image" },
    { id: "voice", personId: 0, type: "voice", name: "PRIVATE QUICK NOTE", size: 10, url: "blob:voice" },
  ],
};
test("custom exports include only chosen people and individual details in every format", () => {
  const result = api.buildCustomExport(source, [1], ["1:favorite:gift", "2:favorite:gift"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].entries.length, 1);
  assert.equal(result[0].entries[0].value, "A telescope");
  for (const output of [api.customExportJson(result), api.customExportCsv(result), api.customExportHtml(result)]) {
    assert.ok(output.includes("A telescope"));
    for (const hidden of ["PRIVATE", "1990-01-01", "Blue", "Medium", "OTHER STORY", "blob:"]) assert.equal(output.includes(hidden), false, hidden);
  }
  assert.equal(api.buildCustomExport(source, [], ["1:favorite:gift"]).length, 0);
});
test("all supported detail groups can be selected without account data or media links in JSON/CSV", () => {
  const choices = api.exportChoices(source.people[0], source);
  const result = api.buildCustomExport(source, [1], Array.from(choices, entry => entry.key));
  assert.equal(result[0].entries.length, choices.length);
  const json = JSON.parse(api.customExportJson(result, "2026-10-26"));
  assert.equal(json.people[0].details.some(entry => entry.category === "Photos"), true);
  assert.equal(json.people[0].details.some(entry => entry.category === "Notes & stories"), true);
  assert.equal(json.account, undefined);
  assert.equal(api.customExportJson(result).includes("blob:"), false);
  assert.equal(api.customExportCsv(result).includes("blob:"), false);
  assert.equal(api.customExportHtml(result).includes('src="blob:private-image"'), true);
});
test("HTML escapes saved content and CSV neutralizes formulas in every text column", () => {
  const malicious = [{ name: '=HYPERLINK("bad")', entries: [{ key: "x", group: "notes", label: "+SUM(1,2)", value: '<script>alert("x")</script>\n=not a formula', date: "\t=1+1", imageUrl: 'javascript:alert(1)' }] }];
  const html = api.customExportHtml(malicious);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("javascript:"), false);
  assert.ok(html.includes("&lt;script&gt;"));
  const csv = api.customExportCsv(malicious);
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes("'+SUM"));
  assert.ok(csv.includes("'\t=1+1"));
  assert.equal(api.safeExportImage("data:image/svg+xml,<svg>"), undefined);
});

function find(node, predicate) {
  if (!node || typeof node !== "object") return;
  if (node.props && predicate(node)) return node;
  for (const child of Object.values(node)) { const match = find(child, predicate); if (match) return match; }
}
function checkbox(tree, text) {
  const label = find(tree, node => node.type === "label" && find(node.props?.children, child => (child.type === "span" || child.type === "strong") && (child.props.children === text || child.props.children?.[0] === text)));
  assert.ok(label, text);
  return find(label, node => node.type === "input");
}
function harness() {
  let cursor = 0; const states = [], downloads = [];
  const react = { useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; } };
  const jsx = (type, props) => ({ type, props });
  const component = load("../app/custom-export.tsx", { "./print-preview": { openPrintPreview: () => false }, react, "./export-data": api, "react/jsx-runtime": { jsx, jsxs: jsx } }, {
    Blob, URL: { createObjectURL: blob => { downloads.push(blob); return "blob:download"; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } }, window: { setTimeout() {}, open: () => null },
  });
  return { downloads, render() { cursor = 0; return component.default(source); } };
}
test("gift guide excludes notes and supports removing a single favorite before download", async () => {
  const h = harness(); const render = () => h.render();
  assert.equal(find(render(), node => node.props?.className === "custom-export-download").props.children.at(-1).props.disabled, true);
  checkbox(render(), "Alex").props.onChange({ target: { checked: true } });
  find(render(), node => node.type === "button" && node.props.children === "Gift guide").props.onClick();
  checkbox(render(), "Clothing size").props.onChange({ target: { checked: false } });
  const preview = JSON.stringify(find(render(), node => node.props?.className === "custom-export-preview"));
  assert.ok(preview.includes("A telescope"));
  assert.equal(preview.includes("Medium"), false);
  assert.equal(preview.includes("PRIVATE STORY"), false);
  find(render(), node => node.type === "select").props.onChange({ target: { value: "csv" } });
  find(render(), node => node.type === "button" && node.props.children === "Download selected CSV").props.onClick();
  assert.equal(h.downloads.length, 1);
  const contents = await h.downloads[0].text();
  assert.ok(contents.includes("A telescope"));
  assert.equal(contents.includes("Medium"), false);
  assert.equal(contents.includes("PRIVATE"), false);
  checkbox(render(), "Alex").props.onChange({ target: { checked: false } });
  checkbox(render(), "Alex").props.onChange({ target: { checked: true } });
  assert.equal(checkbox(render(), "Gift idea").props.checked, false);
});
test("blocked PDF popups give an actionable error and retain the selection", () => {
  const h = harness(); const render = () => h.render();
  checkbox(render(), "Alex").props.onChange({ target: { checked: true } });
  find(render(), node => node.type === "button" && node.props.children === "Gift guide").props.onClick();
  find(render(), node => node.type === "button" && node.props.children === "Open print / PDF preview").props.onClick();
  assert.match(find(render(), node => node.props?.role === "alert").props.children, /Allow pop-ups/);
  assert.equal(checkbox(render(), "Gift idea").props.checked, true);
});
