import { normalizeExtensionDescriptor } from "./builtins.js";
import {
  assertAllowedKeys,
  assertFiniteNumber,
  assertObject,
  assertSafeId,
  clone,
  EXTENSION_ID_PATTERN,
  isPlainObject,
  normalizeLabel,
  normalizePage,
  normalizeStringArray,
  ROLE_PATTERN
} from "./utils.js";

export const PROJECT_SCHEMA = "whl-facsimile-project/2";
export const PROJECT_SCHEMA_VERSION = 2;

const COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function optionalLabel(value, path) {
  return value === undefined ? undefined : normalizeLabel(value, path);
}

function optionalFingerprint(value, path) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${path}: must be a non-empty printable string no longer than 256 characters`);
  }
  return value;
}

function normalizeComponentPatch(registry, value, path, scope, { overlay = false } = {}) {
  assertObject(value, path);
  const result = {};
  for (const [componentId, patch] of Object.entries(value)) {
    assertSafeId(componentId, `${path}.${componentId}`);
    if (!registry.has(componentId)) {
      // Unknown component data is retained only as inert extension data. Required
      // extension checks decide whether it may be evaluated or published.
      result[componentId] = clone(patch);
      continue;
    }
    if (!overlay) {
      result[componentId] = registry.normalize(componentId, patch, { path: `${path}.${componentId}`, scope });
      continue;
    }
    const tombstones = [];
    const stripNulls = (item, segments = []) => {
      if (item === null) {
        tombstones.push(segments);
        return undefined;
      }
      if (!isPlainObject(item)) return clone(item);
      const next = {};
      for (const [key, child] of Object.entries(item)) {
        const normalized = stripNulls(child, [...segments, key]);
        if (normalized !== undefined) next[key] = normalized;
      }
      return next;
    };
    const nonNull = stripNulls(patch);
    const normalized = Object.keys(nonNull).length
      ? registry.normalize(componentId, nonNull, { path: `${path}.${componentId}`, scope })
      : {};
    for (const segments of tombstones) {
      let target = normalized;
      for (const segment of segments.slice(0, -1)) target = target[segment] ||= {};
      target[segments.at(-1)] = null;
    }
    result[componentId] = normalized;
  }
  return result;
}

function normalizeRules(registry, value = {}, path, scope, options) {
  assertAllowedKeys(value, new Set(["sourceRoles", "categories", "classes"]), path);
  const result = { sourceRoles: {}, categories: {}, classes: {} };
  const scopeSuffix = { sourceRoles: "SourceRole", categories: "Category", classes: "Class" };
  for (const kind of Object.keys(result)) {
    const rules = value[kind] ?? {};
    assertObject(rules, `${path}.${kind}`);
    for (const [selectorId, rule] of Object.entries(rules)) {
      assertSafeId(selectorId, `${path}.${kind}.${selectorId}`, kind === "sourceRoles" ? ROLE_PATTERN : undefined);
      assertAllowedKeys(rule, new Set(["components"]), `${path}.${kind}.${selectorId}`);
      result[kind][selectorId] = {
        components: normalizeComponentPatch(
          registry,
          rule.components ?? {},
          `${path}.${kind}.${selectorId}.components`,
          `${scope}${scopeSuffix[kind]}`,
          options
        )
      };
    }
  }
  return result;
}

function normalizeAnnotations(value = {}, path, taxonomy, { overlay = false } = {}) {
  assertAllowedKeys(value, new Set(["displayName", "categoryId", "classIds", "labelIds"]), path);
  const result = {};
  if (Object.hasOwn(value, "displayName")) {
    result.displayName = overlay && value.displayName === null ? null : normalizeLabel(value.displayName, `${path}.displayName`);
  }
  if (Object.hasOwn(value, "categoryId")) {
    if (overlay && value.categoryId === null) result.categoryId = null;
    else {
      result.categoryId = assertSafeId(value.categoryId, `${path}.categoryId`);
      if (!taxonomy.categories[result.categoryId]) throw new TypeError(`${path}.categoryId: references an unknown category`);
    }
  }
  for (const [field, table] of [["classIds", taxonomy.classes], ["labelIds", taxonomy.labels]]) {
    if (!Object.hasOwn(value, field)) continue;
    if (overlay && value[field] === null) result[field] = null;
    else {
      result[field] = normalizeStringArray(value[field], `${path}.${field}`);
      for (const id of result[field]) if (!table[id]) throw new TypeError(`${path}.${field}: references unknown ${id}`);
    }
  }
  return result;
}

function normalizeSourceRef(value, path) {
  assertAllowedKeys(value, new Set(["bookId", "page", "regionId", "fingerprint"]), path);
  return {
    bookId: assertSafeId(value.bookId, `${path}.bookId`),
    page: normalizePage(value.page, `${path}.page`),
    regionId: assertSafeId(value.regionId, `${path}.regionId`),
    ...(optionalFingerprint(value.fingerprint, `${path}.fingerprint`) === undefined
      ? {}
      : { fingerprint: value.fingerprint })
  };
}

function normalizeRegion(registry, value, path, taxonomy, bookId, page, options = {}) {
  const overlay = options.overlay === true;
  const allowed = overlay
    ? new Set(["annotations", "components"])
    : new Set(["id", "sourceRef", "origin", "annotations", "components"]);
  assertAllowedKeys(value, allowed, path);
  if (overlay) {
    return {
      ...(Object.hasOwn(value, "annotations")
        ? { annotations: normalizeAnnotations(value.annotations, `${path}.annotations`, taxonomy, options) }
        : {}),
      ...(Object.hasOwn(value, "components")
        ? { components: normalizeComponentPatch(registry, value.components, `${path}.components`, "region", options) }
        : {})
    };
  }
  const id = assertSafeId(value.id, `${path}.id`);
  const origin = value.origin ?? "source";
  if (!["source", "authored"].includes(origin)) throw new TypeError(`${path}.origin: must be source or authored`);
  const sourceRef = normalizeSourceRef(value.sourceRef, `${path}.sourceRef`);
  if (sourceRef.bookId !== bookId || sourceRef.page !== page) {
    throw new TypeError(`${path}.sourceRef: must address this region object's book and page`);
  }
  return {
    id,
    sourceRef,
    origin,
    annotations: normalizeAnnotations(value.annotations ?? {}, `${path}.annotations`, taxonomy),
    components: normalizeComponentPatch(registry, value.components ?? {}, `${path}.components`, "region")
  };
}

function normalizePageBlock(registry, value, path, taxonomy, bookId, pageKey, options = {}) {
  const overlay = options.overlay === true;
  const allowed = overlay
    ? new Set(["components", "rules", "regions"])
    : new Set(["page", "displayName", "components", "rules", "regions"]);
  assertAllowedKeys(value, allowed, path);
  const page = normalizePage(overlay ? pageKey : value.page, `${path}.page`);
  if (String(page) !== String(Number(pageKey))) throw new TypeError(`${path}.page: must match its page map key`);
  const regions = {};
  for (const [regionId, region] of Object.entries(value.regions ?? {})) {
    assertSafeId(regionId, `${path}.regions.${regionId}`);
    const normalized = normalizeRegion(registry, region, `${path}.regions.${regionId}`, taxonomy, bookId, page, options);
    if (!overlay && normalized.id !== regionId) throw new TypeError(`${path}.regions.${regionId}.id: must match its map key`);
    regions[regionId] = normalized;
  }
  return {
    ...(!overlay ? { page, ...(optionalLabel(value.displayName, `${path}.displayName`) ? { displayName: value.displayName.trim() } : {}) } : {}),
    components: normalizeComponentPatch(registry, value.components ?? {}, `${path}.components`, "page", options),
    rules: normalizeRules(registry, value.rules ?? {}, `${path}.rules`, "page", options),
    regions
  };
}

function normalizeBookBlock(registry, value, path, taxonomy, bookId, options = {}) {
  const overlay = options.overlay === true;
  const allowed = overlay
    ? new Set(["components", "rules", "pages"])
    : new Set(["id", "displayName", "components", "rules", "pages"]);
  assertAllowedKeys(value, allowed, path);
  if (!overlay && assertSafeId(value.id, `${path}.id`) !== bookId) throw new TypeError(`${path}.id: must match its map key`);
  const pages = {};
  assertObject(value.pages ?? {}, `${path}.pages`);
  for (const [pageKey, page] of Object.entries(value.pages ?? {})) {
    const normalizedKey = String(normalizePage(pageKey, `${path}.pages key`));
    if (normalizedKey !== pageKey) throw new TypeError(`${path}.pages.${pageKey}: page keys must be canonical integers`);
    pages[pageKey] = normalizePageBlock(registry, page, `${path}.pages.${pageKey}`, taxonomy, bookId, pageKey, options);
  }
  return {
    ...(!overlay ? { id: bookId, ...(optionalLabel(value.displayName, `${path}.displayName`) ? { displayName: value.displayName.trim() } : {}) } : {}),
    components: normalizeComponentPatch(registry, value.components ?? {}, `${path}.components`, "book", options),
    rules: normalizeRules(registry, value.rules ?? {}, `${path}.rules`, "book", options),
    pages
  };
}

function normalizeTaxonomy(registry, value = {}, path = "taxonomy") {
  assertAllowedKeys(value, new Set(["categories", "classes", "labels"]), path);
  const result = { categories: {}, classes: {}, labels: {} };
  for (const [id, category] of Object.entries(value.categories ?? {})) {
    assertAllowedKeys(category, new Set(["id", "displayName", "parentId", "capabilities", "color", "components"]), `${path}.categories.${id}`);
    if (assertSafeId(category.id, `${path}.categories.${id}.id`) !== id) throw new TypeError(`${path}.categories.${id}.id: must match its map key`);
    result.categories[id] = {
      id,
      displayName: normalizeLabel(category.displayName, `${path}.categories.${id}.displayName`),
      ...(category.parentId === undefined || category.parentId === null ? {} : { parentId: assertSafeId(category.parentId, `${path}.categories.${id}.parentId`) }),
      capabilities: normalizeStringArray(category.capabilities ?? [], `${path}.categories.${id}.capabilities`),
      ...(category.color === undefined ? {} : { color: category.color.toLowerCase() }),
      components: normalizeComponentPatch(registry, category.components ?? {}, `${path}.categories.${id}.components`, "category")
    };
    if (category.color !== undefined && (typeof category.color !== "string" || !COLOR_PATTERN.test(category.color))) {
      throw new TypeError(`${path}.categories.${id}.color: must be an opaque hexadecimal color`);
    }
  }
  for (const [id, regionClass] of Object.entries(value.classes ?? {})) {
    assertAllowedKeys(regionClass, new Set(["id", "displayName", "description", "priority", "components"]), `${path}.classes.${id}`);
    if (assertSafeId(regionClass.id, `${path}.classes.${id}.id`) !== id) throw new TypeError(`${path}.classes.${id}.id: must match its map key`);
    result.classes[id] = {
      id,
      displayName: normalizeLabel(regionClass.displayName, `${path}.classes.${id}.displayName`),
      ...(regionClass.description === undefined ? {} : { description: normalizeLabel(regionClass.description, `${path}.classes.${id}.description`, { maximum: 1000 }) }),
      priority: assertFiniteNumber(regionClass.priority ?? 0, -1_000_000, 1_000_000, `${path}.classes.${id}.priority`, { integer: true }),
      components: normalizeComponentPatch(registry, regionClass.components ?? {}, `${path}.classes.${id}.components`, "class")
    };
  }
  for (const [id, label] of Object.entries(value.labels ?? {})) {
    assertAllowedKeys(label, new Set(["id", "displayName", "color"]), `${path}.labels.${id}`);
    if (assertSafeId(label.id, `${path}.labels.${id}.id`) !== id) throw new TypeError(`${path}.labels.${id}.id: must match its map key`);
    result.labels[id] = {
      id,
      displayName: normalizeLabel(label.displayName, `${path}.labels.${id}.displayName`),
      ...(label.color === undefined ? {} : { color: label.color.toLowerCase() })
    };
    if (label.color !== undefined && (typeof label.color !== "string" || !COLOR_PATTERN.test(label.color))) {
      throw new TypeError(`${path}.labels.${id}.color: must be an opaque hexadecimal color`);
    }
  }
  for (const category of Object.values(result.categories)) {
    if (category.parentId && !result.categories[category.parentId]) throw new TypeError(`${path}.categories.${category.id}.parentId: references an unknown category`);
    const seen = new Set([category.id]);
    let parentId = category.parentId;
    while (parentId) {
      if (seen.has(parentId)) throw new TypeError(`${path}.categories.${category.id}: category ancestry contains a cycle`);
      seen.add(parentId);
      parentId = result.categories[parentId]?.parentId;
    }
  }
  return result;
}

function normalizeSourceRegion(value, path, id) {
  assertAllowedKeys(value, new Set(["id", "sourceRole", "box", "content", "assetRef", "fingerprint"]), path);
  if (assertSafeId(value.id, `${path}.id`) !== id) throw new TypeError(`${path}.id: must match its map key`);
  const result = { id, sourceRole: assertSafeId(value.sourceRole, `${path}.sourceRole`, ROLE_PATTERN) };
  if (value.box !== undefined) {
    if (!Array.isArray(value.box) || value.box.length !== 4) throw new TypeError(`${path}.box: must have four coordinates`);
    result.box = value.box.map((number, index) => assertFiniteNumber(number, 0, 1, `${path}.box[${index}]`));
    if (result.box[2] <= result.box[0] || result.box[3] <= result.box[1]) throw new TypeError(`${path}.box: must have positive width and height`);
  }
  if (value.content !== undefined) {
    assertAllowedKeys(value.content, new Set(["modern", "diplomatic"]), `${path}.content`);
    result.content = {};
    for (const edition of ["modern", "diplomatic"]) {
      if (Object.hasOwn(value.content, edition)) {
        if (typeof value.content[edition] !== "string") throw new TypeError(`${path}.content.${edition}: must be a string`);
        result.content[edition] = value.content[edition];
      }
    }
  }
  if (value.assetRef !== undefined) result.assetRef = assertSafeId(value.assetRef, `${path}.assetRef`);
  const fingerprint = optionalFingerprint(value.fingerprint, `${path}.fingerprint`);
  if (fingerprint !== undefined) result.fingerprint = fingerprint;
  return result;
}

function normalizeSourceLibrary(value = {}, path = "sourceLibrary") {
  assertAllowedKeys(value, new Set(["books"]), path);
  const result = { books: {} };
  assertObject(value.books ?? {}, `${path}.books`);
  for (const [bookId, book] of Object.entries(value.books ?? {})) {
    assertAllowedKeys(book, new Set(["id", "displayName", "fingerprint", "pages"]), `${path}.books.${bookId}`);
    if (assertSafeId(book.id, `${path}.books.${bookId}.id`) !== bookId) throw new TypeError(`${path}.books.${bookId}.id: must match its map key`);
    const pages = {};
    for (const [pageKey, page] of Object.entries(book.pages ?? {})) {
      const pageNumber = normalizePage(pageKey, `${path}.books.${bookId}.pages key`);
      if (String(pageNumber) !== pageKey) throw new TypeError(`${path}.books.${bookId}.pages.${pageKey}: key must be canonical`);
      assertAllowedKeys(page, new Set(["page", "displayName", "fingerprint", "regions"]), `${path}.books.${bookId}.pages.${pageKey}`);
      if (normalizePage(page.page, `${path}.books.${bookId}.pages.${pageKey}.page`) !== pageNumber) throw new TypeError(`${path}.books.${bookId}.pages.${pageKey}.page: must match key`);
      const regions = {};
      for (const [regionId, region] of Object.entries(page.regions ?? {})) {
        regions[regionId] = normalizeSourceRegion(region, `${path}.books.${bookId}.pages.${pageKey}.regions.${regionId}`, regionId);
      }
      pages[pageKey] = {
        page: pageNumber,
        ...(optionalLabel(page.displayName, `${path}.books.${bookId}.pages.${pageKey}.displayName`) ? { displayName: page.displayName.trim() } : {}),
        ...(optionalFingerprint(page.fingerprint, `${path}.books.${bookId}.pages.${pageKey}.fingerprint`) ? { fingerprint: page.fingerprint } : {}),
        regions
      };
    }
    result.books[bookId] = {
      id: bookId,
      ...(optionalLabel(book.displayName, `${path}.books.${bookId}.displayName`) ? { displayName: book.displayName.trim() } : {}),
      ...(optionalFingerprint(book.fingerprint, `${path}.books.${bookId}.fingerprint`) ? { fingerprint: book.fingerprint } : {}),
      pages
    };
  }
  return result;
}

function normalizeWorkspace(registry, value, taxonomy) {
  assertAllowedKeys(value, new Set(["components", "rules", "books"]), "workspace");
  const result = {
    components: normalizeComponentPatch(registry, value.components ?? {}, "workspace.components", "project", { overlay: true }),
    rules: normalizeRules(registry, value.rules ?? {}, "workspace.rules", "project", { overlay: true }),
    books: {}
  };
  for (const [bookId, book] of Object.entries(value.books ?? {})) {
    result.books[bookId] = normalizeBookBlock(registry, book, `workspace.books.${bookId}`, taxonomy, bookId, { overlay: true });
  }
  return result;
}

function validateReferences(project) {
  const objectLocations = new Map();
  for (const [bookId, book] of Object.entries(project.books)) {
    const sourceBook = project.sourceLibrary.books[bookId];
    if (!sourceBook) throw new TypeError(`books.${bookId}: has no source library book`);
    for (const [pageKey, page] of Object.entries(book.pages)) {
      const sourcePage = sourceBook.pages[pageKey];
      if (!sourcePage) throw new TypeError(`books.${bookId}.pages.${pageKey}: has no source library page`);
      for (const [regionId, region] of Object.entries(page.regions)) {
        const location = `books.${bookId}.pages.${pageKey}.regions.${regionId}`;
        if (objectLocations.has(regionId)) {
          throw new TypeError(`${location}: region object ID is already used at ${objectLocations.get(regionId)}`);
        }
        objectLocations.set(regionId, location);
        if (region.origin === "source") {
          const referencedBook = project.sourceLibrary.books[region.sourceRef.bookId];
          const referencedPage = referencedBook?.pages[String(region.sourceRef.page)];
          if (!referencedPage?.regions[region.sourceRef.regionId]) {
            throw new TypeError(`${location}.sourceRef: referenced source region is missing`);
          }
        }
      }
    }
  }
  for (const [bookId, book] of Object.entries(project.workspace.books)) {
    const baseBook = project.books[bookId];
    if (!baseBook) throw new TypeError(`workspace.books.${bookId}: references an unknown book`);
    for (const [pageKey, page] of Object.entries(book.pages)) {
      const basePage = baseBook.pages[pageKey];
      if (!basePage) throw new TypeError(`workspace.books.${bookId}.pages.${pageKey}: references an unknown page`);
      for (const regionId of Object.keys(page.regions)) {
        if (!basePage.regions[regionId]) throw new TypeError(`workspace.books.${bookId}.pages.${pageKey}.regions.${regionId}: references an unknown region`);
      }
    }
  }
  for (const [collectionId, collection] of Object.entries(project.collections)) {
    for (const regionId of collection.regionIds) {
      if (!objectLocations.has(regionId)) {
        throw new TypeError(`collections.${collectionId}.regionIds: references unknown region object ${regionId}`);
      }
    }
  }
}

export function normalizeProject(value, componentRegistry) {
  assertAllowedKeys(value, new Set([
    "schema", "schemaVersion", "projectId", "displayName", "revision", "requiredExtensions", "optionalExtensions",
    "sourceLibrary", "taxonomy", "components", "rules", "books", "collections", "workspace", "extensions", "publicationProfiles"
  ]), "project");
  if (value.schema !== PROJECT_SCHEMA) throw new TypeError(`project.schema: must be ${PROJECT_SCHEMA}`);
  if (value.schemaVersion !== PROJECT_SCHEMA_VERSION) throw new TypeError(`project.schemaVersion: must be ${PROJECT_SCHEMA_VERSION}`);
  const taxonomy = normalizeTaxonomy(componentRegistry, value.taxonomy ?? {});
  const requiredExtensions = normalizeStringArray(value.requiredExtensions ?? [], "project.requiredExtensions", { pattern: EXTENSION_ID_PATTERN });
  const optionalExtensions = {};
  assertObject(value.optionalExtensions ?? {}, "project.optionalExtensions");
  for (const [id, descriptor] of Object.entries(value.optionalExtensions ?? {})) {
    assertSafeId(id, `project.optionalExtensions.${id}`, EXTENSION_ID_PATTERN);
    optionalExtensions[id] = normalizeExtensionDescriptor(descriptor, `project.optionalExtensions.${id}`);
  }
  const books = {};
  for (const [bookId, book] of Object.entries(value.books ?? {})) {
    assertSafeId(bookId, `project.books.${bookId}`);
    books[bookId] = normalizeBookBlock(componentRegistry, book, `project.books.${bookId}`, taxonomy, bookId);
  }
  const collections = {};
  for (const [id, collection] of Object.entries(value.collections ?? {})) {
    assertAllowedKeys(collection, new Set(["id", "displayName", "regionIds"]), `project.collections.${id}`);
    if (assertSafeId(collection.id, `project.collections.${id}.id`) !== id) throw new TypeError(`project.collections.${id}.id: must match its key`);
    collections[id] = {
      id,
      displayName: normalizeLabel(collection.displayName, `project.collections.${id}.displayName`),
      regionIds: normalizeStringArray(collection.regionIds ?? [], `project.collections.${id}.regionIds`)
    };
  }
  const project = {
    schema: PROJECT_SCHEMA,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: assertSafeId(value.projectId, "project.projectId"),
    displayName: normalizeLabel(value.displayName, "project.displayName"),
    revision: assertFiniteNumber(value.revision ?? 0, 0, Number.MAX_SAFE_INTEGER, "project.revision", { integer: true }),
    requiredExtensions,
    optionalExtensions,
    sourceLibrary: normalizeSourceLibrary(value.sourceLibrary),
    taxonomy,
    components: normalizeComponentPatch(componentRegistry, value.components ?? {}, "project.components", "project"),
    rules: normalizeRules(componentRegistry, value.rules ?? {}, "project.rules", "project", {}),
    books,
    collections,
    workspace: normalizeWorkspace(componentRegistry, value.workspace ?? {}, taxonomy),
    extensions: clone(value.extensions ?? {}),
    publicationProfiles: clone(value.publicationProfiles ?? {})
  };
  assertObject(project.extensions, "project.extensions");
  assertObject(project.publicationProfiles, "project.publicationProfiles");
  validateReferences(project);
  return project;
}

export function categoryAncestry(taxonomy, categoryId) {
  if (!categoryId) return [];
  const result = [];
  let current = taxonomy.categories[categoryId];
  while (current) {
    result.unshift(current.id);
    current = current.parentId ? taxonomy.categories[current.parentId] : null;
  }
  return result;
}

export function findRegion(project, bookId, page, regionId) {
  const pageKey = String(normalizePage(page));
  const book = project.books[bookId];
  const pageBlock = book?.pages[pageKey];
  const region = pageBlock?.regions[regionId];
  const sourceRef = region?.sourceRef;
  const sourceRegion = sourceRef
    ? project.sourceLibrary.books[sourceRef.bookId]?.pages[String(sourceRef.page)]?.regions[sourceRef.regionId] ?? null
    : null;
  return { book: book ?? null, page: pageBlock ?? null, region: region ?? null, sourceRegion };
}

export function createEmptyProject(projectId = "project") {
  return {
    schema: PROJECT_SCHEMA,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId,
    displayName: projectId,
    revision: 0,
    requiredExtensions: [],
    optionalExtensions: {},
    sourceLibrary: { books: {} },
    taxonomy: { categories: {}, classes: {}, labels: {} },
    components: {},
    rules: { sourceRoles: {}, categories: {}, classes: {} },
    books: {},
    collections: {},
    workspace: { components: {}, rules: { sourceRoles: {}, categories: {}, classes: {} }, books: {} },
    extensions: {},
    publicationProfiles: {}
  };
}
