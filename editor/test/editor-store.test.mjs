import assert from "node:assert/strict";
import test from "node:test";
import {
  DECORATED_INITIAL_CATEGORY,
  DECORATED_INITIAL_COMPONENT,
  PROJECT_SCHEMA,
  READER_PUBLICATION_SCHEMA
} from "@whl/facsimile-engine";
import { createDemoProject } from "../src/model/demo-project.js";
import { createEditorStore, selectActiveLocation } from "../src/model/editor-store.js";

function setup() {
  return createEditorStore({ project: createDemoProject() });
}

function publishedRegion(store, regionId = "p0236-r002") {
  return store.compilePublication({ activeEdition: "modern" })
    .books["fuchs-1542"].pages["236"].regions.find((region) => region.id === regionId);
}

test("store is a projection over the canonical shared engine", () => {
  const store = setup();
  const state = store.getSnapshot();
  assert.equal(state.project.schema, PROJECT_SCHEMA);
  assert.equal(state.view.schema, PROJECT_SCHEMA);
  assert.equal(state.adapterId, "facsimile-engine-operators");
  assert.equal(state.context.mode, "OBJECT");
  assert.equal(state.context.activeEdition, "modern");
  assert.equal(state.context.activeScope.kind, "region");
  assert.deepEqual(store.engine.project, state.project);
  assert.equal(selectActiveLocation(state).region.id, "p0236-r002");
});

test("UI dispatch changes canonical annotations, publication, and authoritative history", () => {
  const store = setup();
  assert.equal(store.dispatch("region.set-display-name", { value: "Opening peony initial" }), true);

  let evaluated = store.engine.evaluateRegion("fuchs-1542", 236, "p0236-r002");
  assert.equal(evaluated.annotations.displayName, "Opening peony initial");
  assert.equal(publishedRegion(store).annotations.displayName, "Opening peony initial");
  assert.equal(store.engine.history.snapshot().undoLabel, "region.setDisplayName");
  assert.equal(store.getSnapshot().history.undoLabel, "region.setDisplayName");

  assert.equal(store.dispatch("history.undo"), true);
  evaluated = store.engine.evaluateRegion("fuchs-1542", 236, "p0236-r002");
  assert.equal(evaluated.annotations.displayName, "Decorated P opening");
  assert.equal(publishedRegion(store).annotations.displayName, "Decorated P opening");
  assert.equal(store.getSnapshot().history.canRedo, true);

  assert.equal(store.dispatch("history.redo"), true);
  assert.equal(store.engine.evaluateRegion("fuchs-1542", 236, "p0236-r002").annotations.displayName, "Opening peony initial");
  store.destroy();
});

test("classification, labels, and classes delegate to registered engine operators", () => {
  const store = setup();
  assert.equal(store.dispatch("region.assign-category", { categoryId: "text.header" }), true);
  assert.equal(store.engine.evaluateRegion("fuchs-1542", 236, "p0236-r002").categoryId, "text.header");
  assert.equal(publishedRegion(store).annotations.categoryId, "text.header");
  assert.equal(store.dispatch("history.undo"), true);
  assert.equal(store.engine.evaluateRegion("fuchs-1542", 236, "p0236-r002").categoryId, DECORATED_INITIAL_CATEGORY);

  assert.equal(store.dispatch("region.add-label", { label: "iconographic review" }), true);
  let project = store.engine.project;
  assert.equal(project.taxonomy.labels["label.iconographic-review"].displayName, "iconographic review");
  assert.ok(store.engine.evaluateRegion("fuchs-1542", 236, "p0236-r002").labelIds.includes("label.iconographic-review"));

  assert.equal(store.dispatch("region.create-class", { label: "Hand-colored Initial" }), true);
  project = store.engine.project;
  assert.equal(project.taxonomy.classes["custom.hand-colored-initial"].displayName, "Hand-colored Initial");
  assert.ok(store.engine.evaluateRegion("fuchs-1542", 236, "p0236-r002").classIds.includes("custom.hand-colored-initial"));

  assert.equal(store.dispatch("region.toggle-class", { classId: "layout.wide-header" }), true);
  assert.ok(store.engine.evaluateRegion("fuchs-1542", 236, "p0236-r002").classIds.includes("layout.wide-header"));
  assert.equal(store.engine.operationLog().at(-1).operatorId, "region.addClass");
  store.destroy();
});

test("decorated-initial overrides use canonical representations and cascade scopes", () => {
  const store = setup();
  const evaluate = () => store.engine.evaluateRegion("fuchs-1542", 236, "p0236-r002")
    .components[DECORATED_INITIAL_COMPONENT].representation;
  assert.equal(evaluate(), "original");

  store.dispatch("context.set-render-scope", { scope: "page" });
  assert.equal(store.dispatch("render.set-illuminated-capital", { mode: "modern" }), true);
  assert.equal(evaluate(), "modern");
  assert.equal(publishedRegion(store).renderer.representation, "modern");

  store.dispatch("context.set-render-scope", { scope: "region" });
  assert.equal(store.dispatch("render.set-illuminated-capital", { mode: "diplomatic" }), true);
  assert.equal(evaluate(), "diplomatic");
  assert.equal(publishedRegion(store).renderer.representation, "diplomatic");

  assert.equal(store.dispatch("render.clear-illuminated-capital", { scope: "region" }), true);
  assert.equal(evaluate(), "modern");
  assert.equal(store.dispatch("history.undo"), true);
  assert.equal(evaluate(), "diplomatic");
  store.destroy();
});

test("text and geometry dispatch reach canonical workspace and compiled publication", () => {
  const store = setup();
  const originalBox = [...selectActiveLocation(store.getSnapshot()).region.box];
  assert.equal(store.dispatch("region.update-text", { layer: "modern", value: "Modern peony P" }), true);
  assert.equal(publishedRegion(store).components["core.content"].modern, "Modern peony P");
  assert.equal(
    store.engine.project.workspace.books["fuchs-1542"].pages["236"].regions["p0236-r002"].components["core.content"].modern,
    "Modern peony P"
  );

  assert.equal(store.dispatch("region.update-box", { box: [0.1, 0.2, 0.3, 0.4] }), true);
  assert.deepEqual(selectActiveLocation(store.getSnapshot()).region.box, [0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(publishedRegion(store).components["core.transform"].box, [0.1, 0.2, 0.3, 0.4]);
  assert.equal(store.engine.history.snapshot().undoLabel, "region.transform");

  assert.equal(store.dispatch("history.undo"), true);
  assert.deepEqual(selectActiveLocation(store.getSnapshot()).region.box, originalBox);
  assert.equal(store.dispatch("navigation.set-page", { pageId: "237" }), true);
  assert.equal(store.getSnapshot().context.page, 237);
  assert.equal(selectActiveLocation(store.getSnapshot()).region.id, "p0237-r001");

  const publication = store.compilePublication();
  assert.equal(publication.schema, READER_PUBLICATION_SCHEMA);
  assert.equal("workspace" in publication, false);
  store.destroy();
});
