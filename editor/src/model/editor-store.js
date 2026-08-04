import { createFacsimileEngine } from "@whl/facsimile-engine";
import { createEngineOperatorAdapter } from "./operator-adapter.js";
import { createEditorViewModel } from "./view-model.js";

function initialContext(engine) {
  const project = engine.project;
  const bookId = Object.keys(project.books)[0];
  const pageKey = Object.keys(project.books[bookId].pages).sort((a, b) => Number(a) - Number(b))[0];
  const activeRegionId = Object.keys(project.books[bookId].pages[pageKey].regions)[1]
    || Object.keys(project.books[bookId].pages[pageKey].regions)[0]
    || null;
  return engine.context.create({
    projectId: project.projectId,
    workspaceId: "classification",
    mode: "OBJECT",
    area: "viewport",
    bookId,
    page: Number(pageKey),
    activeRegionId,
    selectedRegionIds: activeRegionId ? [activeRegionId] : [],
    activeScope: activeRegionId ? { kind: "region", regionId: activeRegionId } : { kind: "page" },
    activeEdition: "modern",
    activeToolId: "select",
    previewIntent: "editor"
  });
}

/**
 * React external store backed by the canonical facsimile engine. `view` is a
 * disposable projection; `project`, history, mutations, and publication all
 * come directly from the shared engine instance.
 */
export function createEditorStore({ project, engine: suppliedEngine, historyLimit = 100 }) {
  const engine = suppliedEngine || createFacsimileEngine({ project, historyLimit });
  const adapter = createEngineOperatorAdapter(engine);
  const listeners = new Set();
  let context = initialContext(engine);
  let status = { message: "Ready. Changes are held in this demo session only.", tone: "neutral" };
  let snapshot;

  function buildSnapshot() {
    const projectDocument = engine.project;
    return Object.freeze({
      project: projectDocument,
      view: createEditorViewModel(engine),
      revision: engine.revision,
      context,
      status,
      history: engine.history.snapshot(),
      adapterId: adapter.id
    });
  }

  function publish() {
    snapshot = buildSnapshot();
    listeners.forEach((listener) => listener());
  }

  snapshot = buildSnapshot();
  const unsubscribeEngine = engine.subscribe((event) => {
    if (event.type === "commit") status = { message: `Committed ${event.operatorId}.`, tone: "neutral" };
    if (event.type === "undo") status = { message: "Undid the last authored change.", tone: "neutral" };
    if (event.type === "redo") status = { message: "Redid the authored change.", tone: "neutral" };
    publish();
  });

  function dispatch(actionId, payload = {}) {
    const result = adapter.execute(actionId, context, payload);
    context = result.context || context;
    if (result.status) status = result.status;
    publish();
    return result.changed === true;
  }

  return Object.freeze({
    engine,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    compilePublication(options = {}) {
      return engine.compilePublication(options);
    },
    destroy() {
      unsubscribeEngine();
      listeners.clear();
    }
  });
}

export function selectActiveLocation(state) {
  const book = state.view.books[state.context.bookId];
  const page = book?.pages[String(state.context.page)];
  const region = page?.regions[state.context.activeRegionId] || null;
  return { book, page, region };
}
