import { CORE_EXTENSION, DECORATED_INITIAL_COMPONENT, createEmptyOperatorRegistry } from "./builtins.js";
import { normalizeContextScope } from "./context.js";
import { OperatorPollError } from "./errors.js";
import { findRegion } from "./project.js";
import {
  assertFiniteNumber, assertSafeId, clone, deletePath, getPath, normalizeLabel, normalizePage,
  pruneEmpty, sameValue, setPath
} from "./utils.js";

function selectedLocations(project, context) {
  const page = project.books[context.bookId]?.pages[String(context.page)];
  return (context.selectedRegionIds || []).map((regionId) => ({ regionId, region: page?.regions[regionId] })).filter((item) => item.region);
}

function regionObjectExists(project, regionId) {
  return Object.values(project.books).some((book) =>
    Object.values(book.pages).some((page) => Object.hasOwn(page.regions, regionId))
  );
}

function authoredFingerprint(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("arguments.fingerprint: must be an explicit printable source fingerprint no longer than 256 characters");
  }
  return value;
}

function selectionPoll({ project, context }) {
  if (!project.books[context.bookId]?.pages[String(context.page)]) return "The active page is unavailable.";
  if (!selectedLocations(project, context).length) return "Select at least one region.";
  return true;
}

function ensureWorkspaceRegion(project, context, regionId) {
  const workspaceBook = project.workspace.books[context.bookId] ||= { components: {}, rules: { sourceRoles: {}, categories: {}, classes: {} }, pages: {} };
  const pageKey = String(context.page);
  const workspacePage = workspaceBook.pages[pageKey] ||= { components: {}, rules: { sourceRoles: {}, categories: {}, classes: {} }, regions: {} };
  return workspacePage.regions[regionId] ||= {};
}

function editSelection(environment, update) {
  const project = clone(environment.project);
  for (const { regionId } of selectedLocations(project, environment.context)) update(ensureWorkspaceRegion(project, environment.context, regionId), regionId, project);
  return project;
}

function result(before, project, dirtyTags) {
  return { project, changed: !sameValue(before, project), dirtyTags };
}

function scopeTarget(project, context, scope = context.activeScope) {
  const workspaceBook = () => project.workspace.books[context.bookId] ||= { components: {}, rules: { sourceRoles: {}, categories: {}, classes: {} }, pages: {} };
  const workspacePage = () => {
    const book = workspaceBook();
    return book.pages[String(context.page)] ||= { components: {}, rules: { sourceRoles: {}, categories: {}, classes: {} }, regions: {} };
  };
  switch (scope.kind) {
    case "project": return project.workspace;
    case "book": return workspaceBook();
    case "bookSourceRole": return (workspaceBook().rules.sourceRoles[scope.sourceRole] ||= { components: {} });
    case "bookCategory": return (workspaceBook().rules.categories[scope.categoryId] ||= { components: {} });
    case "bookClass": return (workspaceBook().rules.classes[scope.classId] ||= { components: {} });
    case "page": return workspacePage();
    case "pageSourceRole": return (workspacePage().rules.sourceRoles[scope.sourceRole] ||= { components: {} });
    case "pageCategory": return (workspacePage().rules.categories[scope.categoryId] ||= { components: {} });
    case "pageClass": return (workspacePage().rules.classes[scope.classId] ||= { components: {} });
    case "region": return ensureWorkspaceRegion(project, context, scope.regionId);
    default: throw new TypeError(`Unsupported scope ${scope.kind}`);
  }
}

function propertyExecute(environment, reset = false) {
  const { args, components, context } = environment;
  const before = environment.project;
  const project = clone(before);
  const componentId = assertSafeId(args.componentId, "arguments.componentId");
  const definition = components.get(componentId);
  const path = Array.isArray(args.path) ? args.path.map((item, index) => assertSafeId(item, `arguments.path[${index}]`)) : String(args.path || "").split(".").filter(Boolean);
  if (!path.length) throw new TypeError("arguments.path must address a component field");
  const scope = normalizeContextScope(args.scope || context.activeScope, "arguments.scope");
  if (!definition.supportedScopes.includes(scope.kind)) {
    throw new TypeError(`component ${componentId} does not support scope ${scope.kind}`);
  }
  if (scope.kind === "region"
    && !environment.project.books[context.bookId]?.pages[String(context.page)]?.regions[scope.regionId]) {
    throw new TypeError(`arguments.scope.regionId: unknown region ${scope.regionId}`);
  }
  if (["bookCategory", "pageCategory"].includes(scope.kind)
    && !environment.project.taxonomy.categories[scope.categoryId]) {
    throw new TypeError(`arguments.scope.categoryId: unknown category ${scope.categoryId}`);
  }
  if (["bookClass", "pageClass"].includes(scope.kind)
    && !environment.project.taxonomy.classes[scope.classId]) {
    throw new TypeError(`arguments.scope.classId: unknown class ${scope.classId}`);
  }
  const target = scopeTarget(project, context, scope);
  target.components ||= {};
  target.components[componentId] ||= {};
  if (reset) deletePath(target.components[componentId], path);
  else setPath(target.components[componentId], path, args.value);
  pruneEmpty(project.workspace);
  project.workspace ||= { components: {}, rules: { sourceRoles: {}, categories: {}, classes: {} }, books: {} };
  return result(before, project, definition.dirtyTags || ["layout", "paint", "publication"]);
}

function annotationSet(environment, field, transform) {
  const before = environment.project;
  const project = editSelection(environment, (regionOverlay, regionId, nextProject) => {
    regionOverlay.annotations ||= {};
    const base = findRegion(nextProject, environment.context.bookId, environment.context.page, regionId).region.annotations[field];
    const current = Object.hasOwn(regionOverlay.annotations, field) ? regionOverlay.annotations[field] : clone(base);
    regionOverlay.annotations[field] = transform(current, nextProject, regionId);
  });
  return result(before, project, ["classification", "layout", "paint", "accessibility", "publication"]);
}

function register(registry, id, execute, poll = () => true, dirtyTags = []) {
  registry.register({ id, version: 1, extensionId: CORE_EXTENSION, poll, execute, dirtyTags });
}

export function createDefaultOperatorRegistry(componentRegistry) {
  const registry = createEmptyOperatorRegistry();

  register(registry, "region.setDisplayName", (environment) => {
    const name = normalizeLabel(environment.args.displayName, "arguments.displayName");
    return annotationSet(environment, "displayName", () => name);
  }, selectionPoll);

  register(registry, "region.assignCategory", (environment) => {
    const categoryId = environment.args.categoryId === null ? null : assertSafeId(environment.args.categoryId, "arguments.categoryId");
    if (categoryId && !environment.project.taxonomy.categories[categoryId]) throw new TypeError("arguments.categoryId: unknown category");
    return annotationSet(environment, "categoryId", () => categoryId);
  }, selectionPoll);

  for (const [id, field, table, add] of [
    ["region.addClass", "classIds", "classes", true],
    ["region.removeClass", "classIds", "classes", false],
    ["region.addLabel", "labelIds", "labels", true],
    ["region.removeLabel", "labelIds", "labels", false]
  ]) {
    register(registry, id, (environment) => {
      const argumentName = table === "classes" ? "classId" : "labelId";
      const value = assertSafeId(environment.args[argumentName], `arguments.${argumentName}`);
      if (!environment.project.taxonomy[table][value]) throw new TypeError(`arguments.${argumentName}: unknown ${table.slice(0, -2)}`);
      return annotationSet(environment, field, (current = []) => {
        const values = Array.isArray(current) ? current : [];
        return add ? [...new Set([...values, value])] : values.filter((item) => item !== value);
      });
    }, selectionPoll);
  }

  register(registry, "content.setText", (environment) => {
    const edition = environment.args.edition || environment.context.activeEdition;
    if (!["modern", "diplomatic"].includes(edition)) throw new TypeError("arguments.edition: must be modern or diplomatic");
    if (typeof environment.args.text !== "string") throw new TypeError("arguments.text: must be a string");
    const scoped = { ...environment, args: { componentId: "core.content", path: [edition], value: environment.args.text } };
    return propertyExecute(scoped);
  }, selectionPoll);

  register(registry, "property.set", (environment) => propertyExecute(environment), () => true);
  register(registry, "property.reset", (environment) => propertyExecute(environment, true), () => true);

  register(registry, "region.transform", (environment) => {
    const allowed = new Set(["box", "translateX", "translateY", "scaleX", "scaleY"]);
    const patch = {};
    for (const [key, value] of Object.entries(environment.args.transform || {})) {
      if (!allowed.has(key)) throw new TypeError(`arguments.transform.${key}: unknown property`);
      patch[key] = clone(value);
    }
    if (!Object.keys(patch).length) return { project: environment.project, changed: false, dirtyTags: [] };
    const before = environment.project;
    const project = editSelection(environment, (regionOverlay) => {
      regionOverlay.components ||= {};
      regionOverlay.components["core.transform"] = { ...(regionOverlay.components["core.transform"] || {}), ...patch };
    });
    return result(before, project, ["geometry", "layout", "paint", "publication"]);
  }, selectionPoll);

  register(registry, "render.setRepresentation", (environment) => {
    const representation = environment.args.representation;
    if (!["auto", "original", "modern", "diplomatic", "hidden"].includes(representation)) throw new TypeError("arguments.representation: invalid representation");
    return propertyExecute({
      ...environment,
      args: { componentId: DECORATED_INITIAL_COMPONENT, path: ["representation"], value: representation, scope: environment.args.scope }
    });
  }, selectionPoll);

  register(registry, "taxonomy.createCategory", (environment) => {
    const before = environment.project;
    const project = clone(before);
    const id = assertSafeId(environment.args.id, "arguments.id");
    if (project.taxonomy.categories[id]) throw new TypeError("arguments.id: category already exists");
    const parentId = environment.args.parentId == null ? undefined : assertSafeId(environment.args.parentId, "arguments.parentId");
    if (parentId && !project.taxonomy.categories[parentId]) throw new TypeError("arguments.parentId: unknown category");
    project.taxonomy.categories[id] = {
      id,
      displayName: normalizeLabel(environment.args.displayName, "arguments.displayName"),
      ...(parentId ? { parentId } : {}),
      capabilities: [...new Set(environment.args.capabilities || [])],
      components: {}
    };
    return result(before, project, ["classification", "publication"]);
  });

  register(registry, "taxonomy.createClass", (environment) => {
    const before = environment.project;
    const project = clone(before);
    const id = assertSafeId(environment.args.id, "arguments.id");
    if (project.taxonomy.classes[id]) throw new TypeError("arguments.id: class already exists");
    project.taxonomy.classes[id] = {
      id,
      displayName: normalizeLabel(environment.args.displayName, "arguments.displayName"),
      priority: assertFiniteNumber(environment.args.priority ?? 0, -1_000_000, 1_000_000, "arguments.priority", { integer: true }),
      components: clone(environment.args.components || {})
    };
    return result(before, project, ["classification", "layout", "paint", "publication"]);
  });

  register(registry, "taxonomy.createLabel", (environment) => {
    const before = environment.project;
    const project = clone(before);
    const id = assertSafeId(environment.args.id, "arguments.id");
    if (project.taxonomy.labels[id]) throw new TypeError("arguments.id: label already exists");
    project.taxonomy.labels[id] = { id, displayName: normalizeLabel(environment.args.displayName, "arguments.displayName") };
    return result(before, project, ["classification"]);
  });

  register(registry, "collection.link", (environment) => {
    const collectionId = assertSafeId(environment.args.collectionId, "arguments.collectionId");
    if (!environment.project.collections[collectionId]) throw new TypeError("arguments.collectionId: unknown collection");
    const before = environment.project;
    const project = clone(before);
    const ids = selectedLocations(project, environment.context).map(({ regionId }) => regionId);
    project.collections[collectionId].regionIds = [...new Set([...project.collections[collectionId].regionIds, ...ids])];
    return result(before, project, ["classification"]);
  }, selectionPoll);

  register(registry, "collection.unlink", (environment) => {
    const collectionId = assertSafeId(environment.args.collectionId, "arguments.collectionId");
    if (!environment.project.collections[collectionId]) throw new TypeError("arguments.collectionId: unknown collection");
    const before = environment.project;
    const project = clone(before);
    const ids = new Set(selectedLocations(project, environment.context).map(({ regionId }) => regionId));
    project.collections[collectionId].regionIds = project.collections[collectionId].regionIds.filter((id) => !ids.has(id));
    return result(before, project, ["classification"]);
  }, selectionPoll);

  register(registry, "region.create", (environment) => {
    const before = environment.project;
    const project = clone(before);
    const page = project.books[environment.context.bookId]?.pages[String(environment.context.page)];
    if (!page) throw new TypeError("context page is unavailable");
    const id = assertSafeId(environment.args.id, "arguments.id");
    if (regionObjectExists(project, id)) throw new TypeError("arguments.id: region object ID already exists in this project");
    const sourceRegionId = environment.args.sourceRegionId === undefined
      ? id
      : assertSafeId(environment.args.sourceRegionId, "arguments.sourceRegionId");
    const fingerprint = authoredFingerprint(environment.args.fingerprint);
    page.regions[id] = {
      id,
      sourceRef: {
        bookId: environment.context.bookId,
        page: environment.context.page,
        regionId: sourceRegionId,
        fingerprint
      },
      origin: "authored",
      annotations: clone(environment.args.annotations || {}),
      components: clone(environment.args.components || {})
    };
    return result(before, project, ["classification", "geometry", "layout", "publication"]);
  });

  register(registry, "region.deleteAuthored", (environment) => {
    const before = environment.project;
    const project = clone(before);
    const page = project.books[environment.context.bookId]?.pages[String(environment.context.page)];
    for (const { regionId, region } of selectedLocations(project, environment.context)) {
      if (region.origin !== "authored") throw new OperatorPollError("region.deleteAuthored", `Source-backed region ${regionId} cannot be deleted.`);
      delete page.regions[regionId];
      delete project.workspace.books[environment.context.bookId]?.pages?.[String(environment.context.page)]?.regions?.[regionId];
    }
    return result(before, project, ["classification", "geometry", "layout", "publication"]);
  }, ({ project, context }) => {
    const selected = selectedLocations(project, context);
    if (!selected.length) return "Select at least one region.";
    return selected.every(({ region }) => region.origin === "authored") || "Only authored regions can be deleted.";
  });

  register(registry, "project.import", (environment) => {
    if (!environment.args.project || typeof environment.args.project !== "object") throw new TypeError("arguments.project: must be a project document");
    return result(environment.project, clone(environment.args.project), ["classification", "content", "geometry", "layout", "paint", "publication"]);
  });

  register(registry, "publication.compile", (environment) => ({
    project: environment.project,
    changed: false,
    dirtyTags: [],
    output: environment.compile(environment.args.options || {})
  }));

  register(
    registry,
    "publication.submit",
    () => { throw new TypeError("publication.submit requires a host publication adapter"); },
    ({ publicationAdapter }) => publicationAdapter ? true : "No publication adapter is configured."
  );

  return registry;
}

export function executeRegisteredOperator(registry, id, environment) {
  const poll = registry.poll(id, environment);
  if (!poll.allowed) throw new OperatorPollError(id, poll.reason);
  return registry.get(id).execute(environment);
}
