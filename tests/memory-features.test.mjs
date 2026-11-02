import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function load(file, mocks = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => mocks[name] ?? {} });
  return exports;
}
const api = load("../app/memory-features.ts", { "./export-data": load("../app/export-data.ts") });
const source = {
  people: [{ id: 1, name: "Alex", about: "A <wonderful> person", milestones: [{ id: "trip", title: "First trip", date: "2020-11-02", details: "Our adventure" }] }, { id: 2, name: "Sam" }],
  notes: [
    { id: "old", personId: 1, title: "A story", body: "A <script>memory</script>", createdAt: "2022-11-02" },
    { id: "today", personId: 1, title: "New", body: "Today", createdAt: "2026-11-02" },
    { id: "legacy", personId: 1, title: "Undated", body: "Legacy", createdAt: "Today" },
    { id: "other", personId: 2, title: "PRIVATE OTHER PERSON", body: "PRIVATE", createdAt: "2021-11-03" },
  ],
  media: [{ id: "photo", personId: 1, type: "photo", name: "photo.jpg", takenAt: "2021-11-02", createdAt: "2026-01-01", url: "blob:photo" }, { id: "cover", personId: 1, type: "cover", name: "cover", takenAt: "2021-11-02", url: "blob:cover" }],
};
test("On this day uses historical calendar anniversaries and the photo's taken date", () => {
  const memories = api.memoriesOnThisDay(source, new Date(2026, 10, 2));
  assert.deepEqual(Array.from(memories, item => item.key), ["note:old", "media:photo", "milestone:1:trip"]);
  assert.deepEqual(Array.from(memories, item => item.yearsAgo), [4, 5, 6]);
  assert.equal(api.memoryDate("Today"), null);
  assert.equal(api.memoryDate("2025-02-29"), null);
  assert.equal(api.memoriesOnThisDay(source, new Date(2026, 10, 4)).length, 0);
});
test("leap day memories appear only on leap day and date-only values retain their day", () => {
  const leap = { people: [{ id: 1, name: "Alex" }], notes: [{ id: "leap", personId: 1, title: "Leap", body: "Day", createdAt: "2020-02-29" }], media: [] };
  assert.equal(api.memoriesOnThisDay(leap, new Date(2024, 1, 29)).length, 1);
  assert.equal(api.memoriesOnThisDay(leap, new Date(2025, 1, 28)).length, 0);
  assert.equal(api.memoryDate("2020-11-02").getDate(), 2);
});
test("book orders memories, escapes text, excludes other people and honors photos", () => {
  const html = api.keepsakeBookHtml(source, 1, "For <Alex>", "Love & memories", true);
  assert.ok(html.includes("For &lt;Alex&gt;"));
  assert.ok(html.includes("Love &amp; memories"));
  assert.ok(html.includes("&lt;script&gt;memory&lt;/script&gt;"));
  assert.ok(html.includes('src="blob:photo"'));
  assert.ok(html.includes("Date not recorded"));
  assert.equal(html.includes("PRIVATE"), false);
  assert.equal(html.includes("blob:cover"), false);
  assert.ok(html.indexOf("First trip") < html.indexOf("A story"));
  assert.equal(api.keepsakeBookHtml(source, 1, "", "", false).includes("blob:photo"), false);
  assert.throws(() => api.keepsakeBookHtml(source, 999, "", "", true));
});
test("story prompt answers save to the person's story and reject blanks", () => {
  const state = []; let cursor = 0;
  const jsx = (type, props) => ({ type, props });
  const react = { useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = value; }]; } };
  const ui = load("../app/memory-discovery.tsx", { react, "react/jsx-runtime": { jsx, jsxs: jsx } });
  const saved = [];
  function find(node, predicate) { if (!node || typeof node !== "object") return; if (predicate(node)) return node; for (const value of Object.values(node)) { const match = find(value, predicate); if (match) return match; } }
  const render = () => { cursor = 0; return ui.StoryPrompts({ name: "Alex", save: (...args) => saved.push(args) }); };
  find(render(), node => node.type === "button" && node.props.children === "Capture the answer").props.onClick();
  find(render(), node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(saved.length, 0);
  find(render(), node => node.type === "textarea").props.onChange({ target: { value: "  A warm kitchen  " } });
  find(render(), node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(saved, [["What did your childhood home feel like?", "A warm kitchen"]]);
  assert.ok(find(render(), node => node.props?.role === "status"));
});
