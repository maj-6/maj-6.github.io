import { assertAllowedKeys, assertSafeId, immutableClone, normalizePage, normalizeStringArray } from "./utils.js";

export const CONTEXT_MODES = Object.freeze(["OBJECT", "TRANSFORM", "TEXT"]);
export const CONTEXT_AREAS = Object.freeze(["viewport", "outliner", "properties", "command-search", "automation"]);
export const CONTEXT_SCOPES = Object.freeze([
  "project", "book", "bookSourceRole", "bookCategory", "bookClass",
  "page", "pageSourceRole", "pageCategory", "pageClass", "region"
]);

function normalizeScope(scope, path = "context.activeScope") {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new TypeError(`${path}: must be an object`);
  const kind = scope.kind;
  if (!CONTEXT_SCOPES.includes(kind)) throw new TypeError(`${path}.kind: unsupported scope`);
  const result = { kind };
  const required = {
    bookSourceRole: "sourceRole",
    bookCategory: "categoryId",
    bookClass: "classId",
    pageSourceRole: "sourceRole",
    pageCategory: "categoryId",
    pageClass: "classId",
    region: "regionId"
  }[kind];
  if (required) result[required] = assertSafeId(scope[required], `${path}.${required}`);
  const allowed = new Set(["kind", ...(required ? [required] : [])]);
  assertAllowedKeys(scope, allowed, path);
  return result;
}

export function createContext(value) {
  assertAllowedKeys(value, new Set([
    "projectId", "workspaceId", "mode", "area", "bookId", "page", "activeRegionId", "selectedRegionIds",
    "activeScope", "activeEdition", "activeToolId", "previewIntent"
  ]), "context");
  const mode = value.mode ?? "OBJECT";
  if (!CONTEXT_MODES.includes(mode)) throw new TypeError("context.mode: unsupported mode");
  const area = value.area ?? "viewport";
  if (!CONTEXT_AREAS.includes(area)) throw new TypeError("context.area: unsupported area");
  const activeEdition = value.activeEdition ?? "modern";
  if (!["modern", "diplomatic", "qa", "publication"].includes(activeEdition)) throw new TypeError("context.activeEdition: unsupported edition");
  const activeRegionId = value.activeRegionId === null || value.activeRegionId === undefined
    ? null
    : assertSafeId(value.activeRegionId, "context.activeRegionId");
  const selectedRegionIds = normalizeStringArray(value.selectedRegionIds ?? [], "context.selectedRegionIds");
  if (activeRegionId && !selectedRegionIds.includes(activeRegionId)) throw new TypeError("context.activeRegionId: active region must be selected");
  return immutableClone({
    projectId: assertSafeId(value.projectId, "context.projectId"),
    workspaceId: assertSafeId(value.workspaceId ?? "layout", "context.workspaceId"),
    mode,
    area,
    bookId: assertSafeId(value.bookId, "context.bookId"),
    page: normalizePage(value.page, "context.page"),
    activeRegionId,
    selectedRegionIds,
    activeScope: normalizeScope(value.activeScope ?? (activeRegionId ? { kind: "region", regionId: activeRegionId } : { kind: "page" })),
    activeEdition,
    activeToolId: assertSafeId(value.activeToolId ?? "select", "context.activeToolId"),
    previewIntent: value.previewIntent === "reader" ? "reader" : "editor"
  });
}

export function deriveContext(context, patch) {
  return createContext({ ...context, ...patch });
}

/** Blender-like right-click selection: preserve an intentional multi-selection
 * when its member is activated; otherwise select only the clicked region. */
export function activateRegion(context, regionId) {
  const id = assertSafeId(regionId, "regionId");
  const selectedRegionIds = context.selectedRegionIds.includes(id) ? [...context.selectedRegionIds] : [id];
  return deriveContext(context, {
    activeRegionId: id,
    selectedRegionIds,
    activeScope: { kind: "region", regionId: id }
  });
}

export function validateContextLocation(project, context) {
  if (context.projectId !== project.projectId) throw new TypeError("context.projectId: does not match the project");
  const page = project.books[context.bookId]?.pages[String(context.page)];
  if (!page) throw new TypeError("context: book/page does not exist");
  for (const regionId of context.selectedRegionIds) {
    if (!page.regions[regionId]) throw new TypeError(`context.selectedRegionIds: unknown region ${regionId}`);
  }
  return true;
}
