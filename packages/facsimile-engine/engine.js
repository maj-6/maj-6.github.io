import { createDefaultComponentRegistry, createDefaultRendererRegistry } from "./builtins.js";
import { evaluateRegion } from "./cascade.js";
import { activateRegion, createContext, deriveContext, validateContextLocation } from "./context.js";
import { History, createChangeSet } from "./history.js";
import { migrateRegionSettingsV1 } from "./migration.js";
import { createDefaultOperatorRegistry, executeRegisteredOperator } from "./operators.js";
import { compileReaderPublication } from "./publication.js";
import { normalizeProject } from "./project.js";
import { clone, immutableClone, sameValue, stableStringify } from "./utils.js";

export function createFacsimileEngine(options) {
  if (!options?.project) throw new TypeError("createFacsimileEngine requires a project");
  const components = options.components || createDefaultComponentRegistry();
  const renderers = options.renderers || createDefaultRendererRegistry();
  const registry = options.operators || createDefaultOperatorRegistry(components);
  const history = new History({ limit: options.historyLimit || 200 });
  const listeners = new Set();
  const operationLog = [];
  let project = normalizeProject(options.project, components);
  let sequence = 0;
  let modal = null;

  const notify = (event) => listeners.forEach((listener) => listener(immutableClone(event)));
  const compile = (compileOptions = {}) => compileReaderPublication(project, components, renderers, compileOptions);

  function environment(id, contextValue, args = {}, projectValue = project) {
    const context = createContext(contextValue);
    validateContextLocation(projectValue, context);
    return {
      operatorId: id,
      project: projectValue,
      context,
      args: clone(args),
      components,
      renderers,
      publicationAdapter: options.publicationAdapter || null,
      compile: (compileOptions) => compileReaderPublication(projectValue, components, renderers, compileOptions)
    };
  }

  function commitResult(id, args, before, result, { record = true } = {}) {
    if (!result.changed) return result.output === undefined ? false : result.output;
    const normalized = normalizeProject({ ...result.project, revision: before.revision }, components);
    const changeSet = createChangeSet(before, normalized, {
      id: `operation:${++sequence}`,
      sequence,
      operatorId: id,
      arguments: args,
      dirtyTags: result.dirtyTags
    });
    if (!changeSet.operations.length) return false;
    project = normalizeProject({ ...normalized, revision: before.revision + 1 }, components);
    if (record) {
      history.push(changeSet);
      operationLog.push(changeSet);
    }
    notify({ type: "commit", operatorId: id, changeSet, revision: project.revision, dirtyTags: changeSet.dirtyTags });
    return immutableClone({ changed: true, revision: project.revision, changeSet });
  }

  function execute(id, contextValue, args = {}) {
    if (modal) throw new TypeError("Confirm or cancel the active modal operation first");
    const before = project;
    const result = executeRegisteredOperator(registry, id, environment(id, contextValue, args));
    return commitResult(id, clone(args), before, result);
  }

  function poll(id, contextValue, args = {}) {
    try {
      return registry.poll(id, environment(id, contextValue, args));
    } catch (error) {
      return Object.freeze({ allowed: false, reason: error.message });
    }
  }

  function undo() {
    if (modal) throw new TypeError("Confirm or cancel the active modal operation first");
    const result = history.undo(project);
    if (!result) return false;
    project = normalizeProject({ ...result.document, revision: project.revision + 1 }, components);
    notify({ type: "undo", changeSet: result.changeSet, revision: project.revision, dirtyTags: result.changeSet.dirtyTags });
    return immutableClone({ changed: true, revision: project.revision, changeSet: result.changeSet });
  }

  function redo() {
    if (modal) throw new TypeError("Confirm or cancel the active modal operation first");
    const result = history.redo(project);
    if (!result) return false;
    project = normalizeProject({ ...result.document, revision: project.revision + 1 }, components);
    notify({ type: "redo", changeSet: result.changeSet, revision: project.revision, dirtyTags: result.changeSet.dirtyTags });
    return immutableClone({ changed: true, revision: project.revision, changeSet: result.changeSet });
  }

  function beginModal(id, contextValue) {
    if (modal) throw new TypeError("A modal operation is already active");
    const context = createContext(contextValue);
    validateContextLocation(project, context);
    const pollResult = registry.poll(id, environment(id, context, {}));
    if (!pollResult.allowed) throw new TypeError(pollResult.reason);
    modal = { id, context, before: project, preview: project, args: null };
    notify({ type: "modal-begin", operatorId: id });
    return Object.freeze({ operatorId: id });
  }

  function previewModal(args = {}) {
    if (!modal) throw new TypeError("No modal operation is active");
    // Every preview is evaluated against the operation's initial state, so
    // pointer deltas remain absolute and never accumulate rounding error.
    const result = executeRegisteredOperator(registry, modal.id, environment(modal.id, modal.context, args, modal.before));
    modal.preview = result.changed
      ? normalizeProject({ ...result.project, revision: modal.before.revision }, components)
      : modal.before;
    modal.args = clone(args);
    project = modal.preview;
    notify({ type: "modal-preview", operatorId: modal.id, dirtyTags: result.dirtyTags || [] });
    return immutableClone(project);
  }

  function confirmModal(args = undefined) {
    if (!modal) throw new TypeError("No modal operation is active");
    if (args !== undefined) previewModal(args);
    const active = modal;
    modal = null;
    project = active.before;
    if (sameValue(active.before, active.preview)) {
      notify({ type: "modal-cancel", operatorId: active.id });
      return false;
    }
    return commitResult(active.id, active.args || {}, active.before, {
      project: active.preview,
      changed: true,
      dirtyTags: registry.get(active.id).dirtyTags || ["geometry", "layout", "paint", "publication"]
    });
  }

  function cancelModal() {
    if (!modal) return false;
    const id = modal.id;
    project = modal.before;
    modal = null;
    notify({ type: "modal-cancel", operatorId: id });
    return true;
  }

  const facade = {
    get project() { return immutableClone(project); },
    get revision() { return project.revision; },
    components,
    renderers,
    operatorRegistry: registry,
    operators: Object.freeze({ poll, execute }),
    history: Object.freeze({ undo, redo, snapshot: () => history.snapshot() }),
    modal: Object.freeze({ begin: beginModal, preview: previewModal, confirm: confirmModal, cancel: cancelModal }),
    context: Object.freeze({ create: createContext, derive: deriveContext, activateRegion }),
    evaluateRegion(bookId, page, regionId) { return evaluateRegion(project, components, bookId, page, regionId); },
    compilePublication: compile,
    migrateV1(document) {
      const migrated = normalizeProject(migrateRegionSettingsV1(document, project), components);
      return immutableClone(migrated);
    },
    importProject(document, contextValue) {
      return execute("project.import", contextValue, { project: document });
    },
    exportProject({ pretty = true } = {}) { return stableStringify(project, pretty); },
    operationLog() { return immutableClone(operationLog); },
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  return Object.freeze(facade);
}
