import { clone, deepMerge } from "./utils.js";

export const REGION_SETTINGS_V1_SCHEMA = "whl-region-settings/1";

function mappedComponents(patch = {}) {
  const components = {};
  if (patch.style && Object.keys(patch.style).length) components["core.typography"] = clone(patch.style);
  if (patch.geometry && Object.keys(patch.geometry).length) components["core.transform"] = clone(patch.geometry);
  if (patch.fit && Object.keys(patch.fit).length) components["core.textLayout"] = clone(patch.fit);
  if (patch.text && Object.keys(patch.text).length) components["core.content"] = clone(patch.text);
  return components;
}

function ensureBook(workspace, bookId) {
  const book = workspace.books[bookId] ||= {};
  book.components ||= {};
  book.rules ||= {};
  book.rules.sourceRoles ||= {};
  book.rules.categories ||= {};
  book.rules.classes ||= {};
  book.pages ||= {};
  return book;
}

function ensurePage(book, page) {
  const pageBlock = book.pages[String(page)] ||= {};
  pageBlock.components ||= {};
  pageBlock.rules ||= {};
  pageBlock.rules.sourceRoles ||= {};
  pageBlock.rules.categories ||= {};
  pageBlock.rules.classes ||= {};
  pageBlock.regions ||= {};
  return pageBlock;
}

function mergeComponents(target, patch) {
  for (const [componentId, componentPatch] of Object.entries(patch)) {
    target[componentId] = deepMerge(target[componentId] || {}, componentPatch);
  }
  return target;
}

function mergeRule(target, selectorId, patch) {
  const rule = target[selectorId] ||= { components: {} };
  rule.components ||= {};
  mergeComponents(rule.components, mappedComponents(patch));
}

/** Map the browser-era sparse settings document into a project workspace.
 * A target v2 project supplies immutable source/address data; migration never
 * fabricates or rewrites those references. */
export function migrateRegionSettingsV1(document, targetProject) {
  if (!document || document.schema !== REGION_SETTINGS_V1_SCHEMA || document.schemaVersion !== 1) {
    throw new TypeError(`document must use ${REGION_SETTINGS_V1_SCHEMA} schema version 1`);
  }
  if (!targetProject || targetProject.projectId !== document.projectId) throw new TypeError("target project ID must match the v1 document");
  const project = clone(targetProject);
  project.workspace ||= { components: {}, rules: { sourceRoles: {}, categories: {}, classes: {} }, books: {} };
  project.workspace.books ||= {};
  for (const [bookId, override] of Object.entries(document.overrides || {})) {
    if (!project.books[bookId]) throw new TypeError(`v1 override references unknown book ${bookId}`);
    const book = ensureBook(project.workspace, bookId);
    mergeComponents(book.components, mappedComponents(override.book));
    for (const [sourceRole, patch] of Object.entries(override.regionTypes || {})) {
      mergeRule(book.rules.sourceRoles, sourceRole, patch);
    }
    for (const [pageKey, pageOverride] of Object.entries(override.pages || {})) {
      if (!project.books[bookId].pages[pageKey]) throw new TypeError(`v1 override references unknown page ${bookId}/${pageKey}`);
      const page = ensurePage(book, pageKey);
      mergeComponents(page.components, mappedComponents(pageOverride));
      for (const [sourceRole, patch] of Object.entries(pageOverride.regionTypes || {})) {
        mergeRule(page.rules.sourceRoles, sourceRole, patch);
      }
      for (const [regionId, patch] of Object.entries(pageOverride.regions || {})) {
        if (!project.books[bookId].pages[pageKey].regions[regionId]) throw new TypeError(`v1 override references unknown region ${bookId}/${pageKey}/${regionId}`);
        const region = page.regions[regionId] ||= {};
        region.components ||= {};
        mergeComponents(region.components, mappedComponents(patch));
      }
    }
  }
  return project;
}
