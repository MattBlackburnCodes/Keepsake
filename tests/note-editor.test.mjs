import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function editorHarness() {
  const state = []; let cursor = 0;
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  const react = { useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = value; }]; } };
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8") + "\nexports.Notes = Notes; exports.StoryNote = StoryNote;";
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : {} });
  return { render(name, props) { cursor = 0; return exports[name](props); } };
}
function find(node, predicate) {
  if (!node || typeof node !== "object") return;
  if (predicate(node)) return node;
  for (const value of Object.values(node)) { const match = find(value, predicate); if (match) return match; }
}
test("Add Note editor starts open, rejects blank notes, saves trimmed text, and returns to the person", () => {
  const h = editorHarness(), saved = [], routes = [];
  const props = { person: { id: 123, name: "Alex" }, notes: [], go: route => routes.push(route), addNote: (...args) => saved.push(args), updateNote() {}, removeNote() {} };
  const render = () => h.render("Notes", props);
  assert.ok(find(render(), node => node.type === "form"));
  find(render(), node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(saved.length, 0);
  find(render(), node => node.type === "input").props.onChange({ target: { value: "  A memory  " } });
  find(render(), node => node.type === "textarea").props.onChange({ target: { value: "  Some details  " } });
  find(render(), node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(saved, [["A memory", "Some details"]]);
  assert.equal(find(render(), node => node.type === "form"), undefined);
  find(render(), node => node.props?.className === "back-btn").props.onClick();
  assert.deepEqual(routes, ["profile"]);
});
test("notes list shows only the selected person's notes and keeps editing and deletion connected", () => {
  const h = editorHarness();
  const updates = [], deletes = [];
  const note = { id: "one", personId: 123, title: "Original", body: "Details", createdAt: "Today" };
  const props = { person: { id: 123, name: "Alex" }, notes: [note, { ...note, id: "other", personId: 456 }], go() {}, addNote() {}, updateNote: (...args) => updates.push(args), removeNote: id => deletes.push(id) };
  const tree = h.render("Notes", props);
  const list = find(tree, node => node.props?.className === "story-notes");
  assert.equal(list.props.children.length, 1);
  const storyProps = list.props.children[0].props;
  const card = editorHarness();
  const render = () => card.render("StoryNote", storyProps);
  find(render(), node => node.type === "button" && node.props.children === "Edit").props.onClick();
  find(render(), node => node.type === "input").props.onChange({ target: { value: "Updated" } });
  find(render(), node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(updates, [["one", "Updated", "Details"]]);
  find(render(), node => node.props?.["aria-label"] === "Delete Original").props.onClick();
  assert.deepEqual(deletes, ["one"]);
});