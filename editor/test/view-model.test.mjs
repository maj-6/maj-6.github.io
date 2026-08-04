import assert from "node:assert/strict";
import test from "node:test";
import { createFacsimileEngine } from "@whl/facsimile-engine";
import { createDemoProject } from "../src/model/demo-project.js";
import { createEditorStore } from "../src/model/editor-store.js";
import {
  adjacentPageId,
  authoredCapitalSetting,
  authoredPageAppearance,
  capitalPreview,
  clampContextMenuPosition,
  createEditorViewModel,
  effectiveCapitalSetting,
  isIlluminatedRegion,
  regionDisplayName
} from "../src/model/view-model.js";

test("view model is derived from canonical engine evaluation", () => {
  const engine = createFacsimileEngine({ project: createDemoProject() });
  const view = createEditorViewModel(engine);
  const book = view.books["fuchs-1542"];
  const region = book.pages["236"].regions["p0236-r002"];
  assert.equal(regionDisplayName(region), "Decorated P opening");
  assert.equal(isIlluminatedRegion(view, region), true);
  assert.equal(region.categoryId, "visual.ornament.decorated-initial");
  assert.equal(region.style.fontSize, 2.5);
  assert.equal(region.style.textAlign, "start");
  assert.deepEqual(region.transform, {
    box: [0.12, 0.25, 0.25, 0.43],
    translateX: 0,
    translateY: 0,
    scaleX: 1,
    scaleY: 1
  });
  assert.deepEqual(book.pages["236"].appearance, {
    mode: "matched",
    color: "#d7bea7",
    texture: { kind: "paper", strength: 0.32, scale: 1 }
  });
  assert.equal(book.pages["236"].scanPaper, "#d7bea7");
  assert.equal(effectiveCapitalSetting(region).representation, "original");
  assert.equal(adjacentPageId(book, "236", 1), "237");
  assert.equal(adjacentPageId(book, "236", -1), null);
});

test("page appearance view follows evaluated book/page cascade and exposes authored scope", () => {
  const store = createEditorStore({ project: createDemoProject() });
  store.dispatch("selection.clear");
  store.dispatch("page.update-appearance", {
    scope: "page",
    path: ["texture", "kind"],
    value: "fibers"
  });
  const state = store.getSnapshot();
  const appearance = state.view.books["fuchs-1542"].pages["236"].appearance;
  assert.equal(appearance.color, "#d7bea7", "book color remains inherited");
  assert.equal(appearance.texture.kind, "fibers", "page texture overrides the book");
  assert.deepEqual(authoredPageAppearance(state.project, "page", "fuchs-1542", "236"), {
    texture: { kind: "fibers" }
  });
  assert.equal(state.view.books["fuchs-1542"].pages["236"].appearanceSource, "page");
  store.destroy();
});

test("capital preview uses canonical renderer output while preserving source view", () => {
  const store = createEditorStore({ project: createDemoProject() });
  let state = store.getSnapshot();
  let region = state.view.books["fuchs-1542"].pages["236"].regions["p0236-r002"];
  assert.deepEqual(capitalPreview(state.view, "fuchs-1542", "236", region, "scan"), {
    text: "P",
    representation: "original"
  });

  store.dispatch("render.set-illuminated-capital", { mode: "modern", scope: "region" });
  state = store.getSnapshot();
  region = state.view.books["fuchs-1542"].pages["236"].regions["p0236-r002"];
  assert.deepEqual(capitalPreview(state.view, "fuchs-1542", "236", region, "facsimile", "modern"), {
    text: "P",
    representation: "modern"
  });
  assert.deepEqual(authoredCapitalSetting(state.project, "region", "fuchs-1542", "236", region.id), {
    representation: "modern"
  });
  store.destroy();
});

test("context menus are clamped to the visible editor window", () => {
  assert.deepEqual(clampContextMenuPosition(10, 20, 1200, 800), { x: 10, y: 20 });
  assert.deepEqual(clampContextMenuPosition(1190, 790, 1200, 800), { x: 922, y: 382 });
  assert.deepEqual(clampContextMenuPosition(-20, -40, 1200, 800), { x: 8, y: 8 });
});
