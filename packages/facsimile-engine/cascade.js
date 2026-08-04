import { categoryAncestry, findRegion } from "./project.js";
import { clone, deletePath, getPath, immutableClone, isPlainObject, leafPaths, normalizePage, setPath } from "./utils.js";

function componentPaths(patch) {
  return Object.entries(patch || {}).flatMap(([componentId, value]) =>
    leafPaths(value).map((path) => ({ componentId, path }))
  );
}

function keyFor(componentId, path) {
  return [componentId, ...path].join(".");
}

function splitTombstones(value) {
  const tombstones = [];
  const walk = (item, path = []) => {
    if (item === null) {
      tombstones.push(path);
      return undefined;
    }
    if (!isPlainObject(item)) return clone(item);
    const result = {};
    for (const [key, child] of Object.entries(item)) {
      const next = walk(child, [...path, key]);
      if (next !== undefined) result[key] = next;
    }
    return result;
  };
  return { value: walk(value), tombstones };
}

function componentApplies(registry, componentId, targetKind) {
  return registry.has(componentId) && registry.get(componentId).targetKinds.includes(targetKind);
}

function applyPatch(state, registry, patch, source, targetKind) {
  for (const [componentId, value] of Object.entries(patch || {})) {
    if (!componentApplies(registry, componentId, targetKind)) continue;
    state.components[componentId] = registry.merge(componentId, state.components[componentId] || {}, value);
    for (const { path } of componentPaths({ [componentId]: value })) {
      state.provenance[keyFor(componentId, path)] = { ...source, componentId, path: path.join(".") };
    }
  }
}

function applyBucket(state, registry, published, workspace, source, targetKind) {
  const beforeComponents = clone(state.components);
  const beforeProvenance = clone(state.provenance);
  applyPatch(state, registry, published, { ...source, layer: "published" }, targetKind);
  const cleanWorkspace = {};
  for (const [componentId, patch] of Object.entries(workspace || {})) {
    if (!componentApplies(registry, componentId, targetKind)) continue;
    const { value, tombstones } = splitTombstones(patch);
    if (Object.keys(value).length) cleanWorkspace[componentId] = value;
    for (const path of tombstones) {
      const previous = getPath(beforeComponents[componentId] || {}, path);
      if (previous.exists) setPath(state.components[componentId], path, previous.value);
      else deletePath(state.components[componentId], path);
      const provenanceKey = keyFor(componentId, path);
      const isProvenanceBranch = (key) => key === provenanceKey || key.startsWith(`${provenanceKey}.`);
      for (const key of Object.keys(state.provenance)) {
        if (isProvenanceBranch(key)) delete state.provenance[key];
      }
      for (const [key, provenance] of Object.entries(beforeProvenance)) {
        if (isProvenanceBranch(key)) state.provenance[key] = clone(provenance);
      }
    }
  }
  applyPatch(state, registry, cleanWorkspace, { ...source, layer: "workspace" }, targetKind);
}

function createTargetState(componentRegistry, targetKind) {
  const state = { components: {}, provenance: {} };
  for (const definition of componentRegistry.entries()) {
    if (!definition.targetKinds.includes(targetKind)) continue;
    state.components[definition.id] = clone(definition.defaults || {});
    for (const path of leafPaths(definition.defaults || {})) {
      if (!path.length) continue;
      state.provenance[keyFor(definition.id, path)] = {
        layer: "default", scope: "componentDefault", ownerId: definition.id,
        componentId: definition.id, path: path.join(".")
      };
    }
  }
  return state;
}

function ruleComponents(owner, kind, selectorId) {
  return owner?.rules?.[kind]?.[selectorId]?.components || {};
}

function categoryCapabilities(taxonomy, ancestry) {
  return [...new Set(ancestry.flatMap((id) => taxonomy.categories[id]?.capabilities || []))];
}

function effectiveAnnotations(region, workspaceRegion) {
  const result = clone(region.annotations || {});
  for (const [key, value] of Object.entries(workspaceRegion?.annotations || {})) {
    if (value === null) delete result[key];
    else result[key] = clone(value);
  }
  result.classIds ||= [];
  result.labelIds ||= [];
  return result;
}

function sortedClasses(project, classIds) {
  return [...classIds]
    .filter((id) => project.taxonomy.classes[id])
    .sort((first, second) => {
      const priority = project.taxonomy.classes[first].priority - project.taxonomy.classes[second].priority;
      return priority || first.localeCompare(second);
    });
}

/** Resolve a region using specificity first and published/workspace layer second.
 * The returned object and provenance are immutable snapshots. */
export function evaluateRegion(project, componentRegistry, bookId, page, regionId) {
  const location = findRegion(project, bookId, page, regionId);
  if (!location.region) throw new TypeError(`Unknown region ${bookId}/${page}/${regionId}`);
  const pageKey = String(location.page.page);
  const workspaceBook = project.workspace.books[bookId] || {};
  const workspacePage = workspaceBook.pages?.[pageKey] || {};
  const workspaceRegion = workspacePage.regions?.[regionId] || {};
  const annotations = effectiveAnnotations(location.region, workspaceRegion);
  const ancestry = categoryAncestry(project.taxonomy, annotations.categoryId);
  const classIds = sortedClasses(project, annotations.classIds);
  const state = createTargetState(componentRegistry, "region");

  applyBucket(state, componentRegistry, project.components, project.workspace.components, {
    scope: "project", ownerId: project.projectId
  }, "region");

  // Taxonomy component bundles are project-level reusable profiles. Category
  // ancestry is root-to-leaf; class priority is low-to-high then stable ID.
  for (const categoryId of ancestry) {
    applyBucket(state, componentRegistry, project.taxonomy.categories[categoryId].components, {}, {
      scope: "taxonomyCategory", ownerId: categoryId, selectorId: categoryId
    }, "region");
  }
  for (const classId of classIds) {
    applyBucket(state, componentRegistry, project.taxonomy.classes[classId].components, {}, {
      scope: "taxonomyClass", ownerId: classId, selectorId: classId
    }, "region");
  }

  const applyRules = (publishedOwner, workspaceOwner, ownerScope, ownerId) => {
    const sourceRole = location.sourceRegion?.sourceRole;
    if (sourceRole) applyBucket(
      state,
      componentRegistry,
      ruleComponents(publishedOwner, "sourceRoles", sourceRole),
      ruleComponents(workspaceOwner, "sourceRoles", sourceRole),
      { scope: `${ownerScope}SourceRole`, ownerId, selectorId: sourceRole },
      "region"
    );
    for (const categoryId of ancestry) applyBucket(
      state,
      componentRegistry,
      ruleComponents(publishedOwner, "categories", categoryId),
      ruleComponents(workspaceOwner, "categories", categoryId),
      { scope: `${ownerScope}Category`, ownerId, selectorId: categoryId },
      "region"
    );
    for (const classId of classIds) applyBucket(
      state,
      componentRegistry,
      ruleComponents(publishedOwner, "classes", classId),
      ruleComponents(workspaceOwner, "classes", classId),
      { scope: `${ownerScope}Class`, ownerId, selectorId: classId },
      "region"
    );
  };

  // Project rules are less specific than every book scope but more specific
  // than project/taxonomy defaults. They use the same selector ordering as
  // book and page rules and participate in field-level provenance.
  applyRules(project, project.workspace, "project", project.projectId);

  const applyOwner = (publishedOwner, workspaceOwner, ownerScope, ownerId) => {
    applyBucket(state, componentRegistry, publishedOwner?.components || {}, workspaceOwner?.components || {}, {
      scope: ownerScope, ownerId
    }, "region");
    applyRules(publishedOwner, workspaceOwner, ownerScope, ownerId);
  };

  applyOwner(location.book, workspaceBook, "book", bookId);
  applyOwner(location.page, workspacePage, "page", `${bookId}:${pageKey}`);

  // Immutable object data is exact-region input; authored exact-region
  // components then override it without changing the source block.
  const sourceComponents = {};
  if (location.sourceRegion?.box) sourceComponents["core.transform"] = { box: location.sourceRegion.box };
  if (location.sourceRegion?.content) sourceComponents["core.content"] = location.sourceRegion.content;
  applyPatch(state, componentRegistry, sourceComponents, {
    layer: "source", scope: "sourceRegion", ownerId: `${bookId}:${pageKey}:${regionId}`
  }, "region");
  applyBucket(state, componentRegistry, location.region.components, workspaceRegion.components, {
    scope: "region", ownerId: regionId
  }, "region");

  const result = {
    id: regionId,
    bookId,
    page: Number(pageKey),
    sourceRef: clone(location.region.sourceRef),
    sourceRegion: clone(location.sourceRegion),
    origin: location.region.origin,
    annotations,
    categoryId: annotations.categoryId || null,
    categoryAncestry: ancestry,
    categoryCapabilities: categoryCapabilities(project.taxonomy, ancestry),
    classIds,
    labelIds: [...annotations.labelIds],
    components: state.components,
    provenance: state.provenance
  };
  return immutableClone(result);
}

/** Resolve components that paint a page rather than any individual region.
 * Page components deliberately skip taxonomy and selector rules: their
 * cascade is project -> book -> page, with workspace overlays at each scope. */
export function evaluatePage(project, componentRegistry, bookId, page) {
  const pageKey = String(normalizePage(page));
  const book = project.books[bookId];
  const pageBlock = book?.pages[pageKey];
  if (!pageBlock) throw new TypeError(`Unknown page ${bookId}/${pageKey}`);
  const workspaceBook = project.workspace.books[bookId] || {};
  const workspacePage = workspaceBook.pages?.[pageKey] || {};
  const state = createTargetState(componentRegistry, "page");

  applyBucket(state, componentRegistry, project.components, project.workspace.components, {
    scope: "project", ownerId: project.projectId
  }, "page");
  applyBucket(state, componentRegistry, book.components, workspaceBook.components, {
    scope: "book", ownerId: bookId
  }, "page");
  applyBucket(state, componentRegistry, pageBlock.components, workspacePage.components, {
    scope: "page", ownerId: `${bookId}:${pageKey}`
  }, "page");

  return immutableClone({
    bookId,
    page: Number(pageKey),
    ...(pageBlock.displayName ? { displayName: pageBlock.displayName } : {}),
    components: state.components,
    provenance: state.provenance
  });
}

export function provenanceFor(evaluatedRegion, componentId, path) {
  const normalizedPath = Array.isArray(path) ? path.join(".") : path;
  return evaluatedRegion.provenance[`${componentId}.${normalizedPath}`] || null;
}
