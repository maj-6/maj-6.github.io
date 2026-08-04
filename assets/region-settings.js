(() => {
  "use strict";

  const root = typeof window !== "undefined" ? window : globalThis;
  const SCHEMA = "whl-region-settings/1";
  const SCHEMA_VERSION = 1;
  const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
  const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const ROLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const FONT_TOKENS = new Set(["edition", "georgia", "palatino", "sans"]);
  const COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  const TEXT_LAYERS = new Set(["modern", "diplomatic"]);
  const FIT_MODES = new Set(["scroll", "grow-width", "shrink-text", "grow-then-shrink"]);
  const WRAP_VALUES = new Set(["normal", "nowrap", "balance"]);
  const OVERFLOW_VALUES = new Set(["hidden", "auto", "scroll", "visible"]);
  const TARGET_SCOPES = new Set(["book", "regionType", "page", "pageRegionType", "region"]);
  const STYLE_FIELDS = new Set(["fontFamily", "fontSize", "fontWeight", "color", "lineHeight", "letterSpacing"]);
  const GEOMETRY_FIELDS = new Set(["box", "translateX", "translateY", "scaleX", "scaleY"]);
  const FIT_FIELDS = new Set(["mode", "wrap", "overflow", "maxWidthScale", "minFontScale"]);
  const PATCH_FIELDS = new Set(["style", "geometry", "fit", "text"]);

  class EditorDisabledError extends Error {
    constructor(message = "The region editor is disabled by project configuration.") {
      super(message);
      this.name = "EditorDisabledError";
    }
  }

  class SettingsValidationError extends TypeError {
    constructor(message) {
      super(message);
      this.name = "SettingsValidationError";
    }
  }

  function fail(path, message) {
    throw new SettingsValidationError(`${path}: ${message}`);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function assertSafeKey(key, path) {
    if (DANGEROUS_KEYS.has(key)) fail(path, `unsafe key ${JSON.stringify(key)}`);
  }

  function assertObject(value, path) {
    if (!isPlainObject(value)) fail(path, "must be a plain object");
    Object.keys(value).forEach((key) => assertSafeKey(key, `${path}.${key}`));
  }

  function assertAllowedKeys(value, allowed, path) {
    assertObject(value, path);
    Object.keys(value).forEach((key) => {
      if (!allowed.has(key)) fail(`${path}.${key}`, "unknown property");
    });
  }

  function assertIdentifier(value, path, pattern = ID_PATTERN) {
    if (typeof value !== "string" || !pattern.test(value) || DANGEROUS_KEYS.has(value)) {
      fail(path, "must be a safe identifier");
    }
    return value;
  }

  function assertFiniteNumber(value, minimum, maximum, path, integer = false) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
      fail(path, `must be ${integer ? "an integer" : "a finite number"} from ${minimum} to ${maximum}`);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  function normalizePage(value, path = "page") {
    const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    return assertFiniteNumber(number, 1, 10_000_000, path, true);
  }

  function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (!value || typeof value !== "object") return value;
    const result = {};
    Object.keys(value).forEach((key) => {
      assertSafeKey(key, key);
      result[key] = clone(value[key]);
    });
    return result;
  }

  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== "object") return value;
    const result = {};
    Object.keys(value).sort((first, second) => first.localeCompare(second, "en", { numeric: true })).forEach((key) => {
      result[key] = canonicalize(value[key]);
    });
    return result;
  }

  function stableStringify(value, pretty = false) {
    return JSON.stringify(canonicalize(value), null, pretty ? 2 : 0);
  }

  function sameValue(first, second) {
    return stableStringify(first) === stableStringify(second);
  }

  function isEmptyObject(value) {
    return isPlainObject(value) && Object.keys(value).length === 0;
  }

  function pruneEmpty(value) {
    if (!isPlainObject(value)) return;
    Object.keys(value).forEach((key) => {
      if (isPlainObject(value[key])) {
        pruneEmpty(value[key]);
        if (isEmptyObject(value[key])) delete value[key];
      }
    });
  }

  function normalizeStyle(value, path) {
    assertAllowedKeys(value, STYLE_FIELDS, path);
    const result = {};
    if (Object.hasOwn(value, "fontFamily")) {
      if (!FONT_TOKENS.has(value.fontFamily)) fail(`${path}.fontFamily`, "must be edition, georgia, palatino, or sans");
      result.fontFamily = value.fontFamily;
    }
    if (Object.hasOwn(value, "fontSize")) result.fontSize = assertFiniteNumber(value.fontSize, 0.5, 4, `${path}.fontSize`);
    if (Object.hasOwn(value, "fontWeight")) result.fontWeight = assertFiniteNumber(value.fontWeight, 100, 900, `${path}.fontWeight`, true);
    if (Object.hasOwn(value, "color")) {
      if (typeof value.color !== "string" || !COLOR_PATTERN.test(value.color)) fail(`${path}.color`, "must be a hexadecimal color");
      result.color = value.color.toLowerCase();
    }
    if (Object.hasOwn(value, "lineHeight")) result.lineHeight = assertFiniteNumber(value.lineHeight, 0.5, 4, `${path}.lineHeight`);
    if (Object.hasOwn(value, "letterSpacing")) result.letterSpacing = assertFiniteNumber(value.letterSpacing, -0.25, 1, `${path}.letterSpacing`);
    return result;
  }

  function normalizeBox(value, path) {
    if (!Array.isArray(value) || value.length !== 4) fail(path, "must contain four normalized coordinates");
    const box = value.map((coordinate, index) => assertFiniteNumber(coordinate, 0, 1, `${path}[${index}]`));
    if (box[2] <= box[0] || box[3] <= box[1]) fail(path, "must have positive width and height");
    return box;
  }

  function normalizeGeometry(value, path, scope) {
    assertAllowedKeys(value, GEOMETRY_FIELDS, path);
    const result = {};
    if (Object.hasOwn(value, "box")) {
      if (scope !== "region") fail(`${path}.box`, "is only valid for an exact region scope");
      result.box = normalizeBox(value.box, `${path}.box`);
    }
    if (Object.hasOwn(value, "translateX")) result.translateX = assertFiniteNumber(value.translateX, -1, 1, `${path}.translateX`);
    if (Object.hasOwn(value, "translateY")) result.translateY = assertFiniteNumber(value.translateY, -1, 1, `${path}.translateY`);
    if (Object.hasOwn(value, "scaleX")) result.scaleX = assertFiniteNumber(value.scaleX, 0.25, 4, `${path}.scaleX`);
    if (Object.hasOwn(value, "scaleY")) result.scaleY = assertFiniteNumber(value.scaleY, 0.25, 4, `${path}.scaleY`);
    return result;
  }

  function normalizeFit(value, path) {
    assertAllowedKeys(value, FIT_FIELDS, path);
    const result = {};
    if (Object.hasOwn(value, "mode")) {
      if (!FIT_MODES.has(value.mode)) fail(`${path}.mode`, "has an unsupported fitting mode");
      result.mode = value.mode;
    }
    if (Object.hasOwn(value, "wrap")) {
      if (!WRAP_VALUES.has(value.wrap)) fail(`${path}.wrap`, "must be normal, nowrap, or balance");
      result.wrap = value.wrap;
    }
    if (Object.hasOwn(value, "overflow")) {
      if (!OVERFLOW_VALUES.has(value.overflow)) fail(`${path}.overflow`, "must be hidden, auto, scroll, or visible");
      result.overflow = value.overflow;
    }
    if (Object.hasOwn(value, "maxWidthScale")) result.maxWidthScale = assertFiniteNumber(value.maxWidthScale, 1, 4, `${path}.maxWidthScale`);
    if (Object.hasOwn(value, "minFontScale")) result.minFontScale = assertFiniteNumber(value.minFontScale, 0.5, 1, `${path}.minFontScale`);
    return result;
  }

  function normalizeText(value, path) {
    assertAllowedKeys(value, TEXT_LAYERS, path);
    const result = {};
    TEXT_LAYERS.forEach((layer) => {
      if (!Object.hasOwn(value, layer)) return;
      if (typeof value[layer] !== "string" || value[layer].length > 1_000_000) fail(`${path}.${layer}`, "must be a string no longer than 1,000,000 characters");
      result[layer] = value[layer];
    });
    return result;
  }

  function normalizePatch(value, path, scope) {
    assertAllowedKeys(value, PATCH_FIELDS, path);
    const result = {};
    if (Object.hasOwn(value, "style")) result.style = normalizeStyle(value.style, `${path}.style`);
    if (Object.hasOwn(value, "geometry")) result.geometry = normalizeGeometry(value.geometry, `${path}.geometry`, scope);
    if (Object.hasOwn(value, "fit")) result.fit = normalizeFit(value.fit, `${path}.fit`);
    if (Object.hasOwn(value, "text")) {
      if (scope !== "region") fail(`${path}.text`, "is only valid for an exact region scope");
      result.text = normalizeText(value.text, `${path}.text`);
    }
    pruneEmpty(result);
    return result;
  }

  function normalizeRoleMap(value, path, scope) {
    assertObject(value, path);
    const result = {};
    Object.entries(value).forEach(([role, patch]) => {
      assertIdentifier(role, `${path}.${role}`, ROLE_PATTERN);
      result[role] = normalizePatch(patch, `${path}.${role}`, scope);
    });
    pruneEmpty(result);
    return result;
  }

  function normalizeRegionMap(value, path) {
    assertObject(value, path);
    const result = {};
    Object.entries(value).forEach(([regionId, patch]) => {
      assertIdentifier(regionId, `${path}.${regionId}`);
      result[regionId] = normalizePatch(patch, `${path}.${regionId}`, "region");
    });
    pruneEmpty(result);
    return result;
  }

  function normalizePageRecord(value, path) {
    const allowed = new Set([...PATCH_FIELDS].filter((field) => field !== "text").concat(["regionTypes", "regions"]));
    assertAllowedKeys(value, allowed, path);
    const patchInput = {};
    ["style", "geometry", "fit"].forEach((field) => {
      if (Object.hasOwn(value, field)) patchInput[field] = value[field];
    });
    const result = normalizePatch(patchInput, path, "page");
    if (Object.hasOwn(value, "regionTypes")) result.regionTypes = normalizeRoleMap(value.regionTypes, `${path}.regionTypes`, "pageRegionType");
    if (Object.hasOwn(value, "regions")) result.regions = normalizeRegionMap(value.regions, `${path}.regions`);
    pruneEmpty(result);
    return result;
  }

  function normalizePages(value, path) {
    assertObject(value, path);
    const result = {};
    Object.entries(value).forEach(([pageKey, pageRecord]) => {
      const page = normalizePage(pageKey, `${path}.${pageKey}`);
      if (String(page) !== pageKey) fail(`${path}.${pageKey}`, "must use a canonical positive integer key");
      result[pageKey] = normalizePageRecord(pageRecord, `${path}.${pageKey}`);
    });
    pruneEmpty(result);
    return result;
  }

  function normalizeBookRecord(value, path) {
    const allowed = new Set(["book", "regionTypes", "pages"]);
    assertAllowedKeys(value, allowed, path);
    const result = {};
    if (Object.hasOwn(value, "book")) result.book = normalizePatch(value.book, `${path}.book`, "book");
    if (Object.hasOwn(value, "regionTypes")) result.regionTypes = normalizeRoleMap(value.regionTypes, `${path}.regionTypes`, "regionType");
    if (Object.hasOwn(value, "pages")) result.pages = normalizePages(value.pages, `${path}.pages`);
    pruneEmpty(result);
    return result;
  }

  function emptyDocument(projectId) {
    return { schema: SCHEMA, schemaVersion: SCHEMA_VERSION, projectId, overrides: {} };
  }

  function normalizeDocument(input, expectedProjectId, path = "settings") {
    let value = input;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch (error) {
        fail(path, `contains invalid JSON (${error.message})`);
      }
    }
    const allowed = new Set(["schema", "schemaVersion", "projectId", "overrides"]);
    assertAllowedKeys(value, allowed, path);
    if (value.schema !== SCHEMA) fail(`${path}.schema`, `must equal ${SCHEMA}`);
    if (value.schemaVersion !== SCHEMA_VERSION) fail(`${path}.schemaVersion`, `must equal ${SCHEMA_VERSION}`);
    const projectId = assertIdentifier(value.projectId, `${path}.projectId`);
    if (expectedProjectId && projectId !== expectedProjectId) fail(`${path}.projectId`, `must equal ${expectedProjectId}`);
    assertObject(value.overrides, `${path}.overrides`);
    const result = emptyDocument(projectId);
    Object.entries(value.overrides).forEach(([bookId, record]) => {
      assertIdentifier(bookId, `${path}.overrides.${bookId}`);
      result.overrides[bookId] = normalizeBookRecord(record, `${path}.overrides.${bookId}`);
    });
    pruneEmpty(result.overrides);
    return result;
  }

  function normalizeTarget(input) {
    const allowed = new Set(["scope", "bookId", "page", "role", "regionId"]);
    assertAllowedKeys(input, allowed, "target");
    if (!TARGET_SCOPES.has(input.scope)) fail("target.scope", "has an unsupported scope");
    const target = {
      scope: input.scope,
      bookId: assertIdentifier(input.bookId, "target.bookId")
    };
    const needsPage = ["page", "pageRegionType", "region"].includes(input.scope);
    const needsRole = ["regionType", "pageRegionType"].includes(input.scope);
    const needsRegion = input.scope === "region";
    if (needsPage) target.page = normalizePage(input.page, "target.page");
    else if (Object.hasOwn(input, "page")) fail("target.page", `is not valid for ${input.scope} scope`);
    if (needsRole) target.role = assertIdentifier(input.role, "target.role", ROLE_PATTERN);
    else if (Object.hasOwn(input, "role")) fail("target.role", `is not valid for ${input.scope} scope`);
    if (needsRegion) target.regionId = assertIdentifier(input.regionId, "target.regionId");
    else if (Object.hasOwn(input, "regionId")) fail("target.regionId", `is not valid for ${input.scope} scope`);
    return target;
  }

  function mergeObjects(base, overlay) {
    const result = clone(base || {});
    Object.entries(overlay || {}).forEach(([key, value]) => {
      if (isPlainObject(value) && isPlainObject(result[key])) result[key] = mergeObjects(result[key], value);
      else result[key] = clone(value);
    });
    return result;
  }

  function mergePatch(base, overlay) {
    const result = {};
    ["style", "geometry", "fit", "text"].forEach((group) => {
      if (base?.[group] || overlay?.[group]) result[group] = { ...(base?.[group] || {}), ...(overlay?.[group] || {}) };
    });
    pruneEmpty(result);
    return result;
  }

  function getScope(document, target) {
    const book = document.overrides[target.bookId];
    if (!book) return null;
    if (target.scope === "book") return book.book || null;
    if (target.scope === "regionType") return book.regionTypes?.[target.role] || null;
    const page = book.pages?.[String(target.page)];
    if (!page) return null;
    if (target.scope === "page") return page;
    if (target.scope === "pageRegionType") return page.regionTypes?.[target.role] || null;
    return page.regions?.[target.regionId] || null;
  }

  function ensureScope(document, target) {
    document.overrides[target.bookId] ||= {};
    const book = document.overrides[target.bookId];
    if (target.scope === "book") return (book.book ||= {});
    if (target.scope === "regionType") {
      book.regionTypes ||= {};
      return (book.regionTypes[target.role] ||= {});
    }
    book.pages ||= {};
    const page = (book.pages[String(target.page)] ||= {});
    if (target.scope === "page") return page;
    if (target.scope === "pageRegionType") {
      page.regionTypes ||= {};
      return (page.regionTypes[target.role] ||= {});
    }
    page.regions ||= {};
    return (page.regions[target.regionId] ||= {});
  }

  function deleteScope(document, target) {
    const book = document.overrides[target.bookId];
    if (!book) return;
    if (target.scope === "book") delete book.book;
    else if (target.scope === "regionType") delete book.regionTypes?.[target.role];
    else {
      const page = book.pages?.[String(target.page)];
      if (!page) return;
      if (target.scope === "page") {
        delete page.style;
        delete page.geometry;
        delete page.fit;
      } else if (target.scope === "pageRegionType") delete page.regionTypes?.[target.role];
      else delete page.regions?.[target.regionId];
    }
    pruneEmpty(document.overrides);
  }

  function setScopePatch(document, target, patch) {
    const scope = ensureScope(document, target);
    ["style", "geometry", "fit", "text"].forEach((group) => {
      if (!patch[group]) return;
      scope[group] = { ...(scope[group] || {}), ...clone(patch[group]) };
    });
    pruneEmpty(document.overrides);
  }

  function normalizeRemovePaths(path) {
    if (path === undefined || path === null) return null;
    const values = Array.isArray(path) ? path : [path];
    if (!values.length || values.some((value) => typeof value !== "string")) fail("path", "must be a property path or array of property paths");
    return values.map((value) => {
      const segments = value.split(".");
      if (segments.length < 1 || segments.length > 2 || !PATCH_FIELDS.has(segments[0])) fail("path", `unsupported path ${JSON.stringify(value)}`);
      if (segments.length === 2) {
        const fields = segments[0] === "style" ? STYLE_FIELDS : segments[0] === "geometry" ? GEOMETRY_FIELDS : segments[0] === "fit" ? FIT_FIELDS : TEXT_LAYERS;
        if (!fields.has(segments[1])) fail("path", `unsupported path ${JSON.stringify(value)}`);
      }
      return segments;
    });
  }

  function applyPatchToResolved(resolved, patch, layer) {
    if (!patch) return;
    ["style", "geometry", "fit"].forEach((group) => {
      if (patch[group]) Object.assign(resolved[group], patch[group]);
    });
    if (layer && patch.text && Object.hasOwn(patch.text, layer)) {
      resolved.text = patch.text[layer];
      resolved.hasTextOverride = true;
    }
  }

  function mergeDocuments(base, overlay) {
    const merged = emptyDocument(base.projectId);
    merged.overrides = mergeObjects(base.overrides, overlay.overrides);
    return normalizeDocument(merged, base.projectId, "merged settings");
  }

  function persistenceKey(prefix, projectId) {
    return `${prefix}${encodeURIComponent(projectId)}`;
  }

  function createLocalStoragePersistence(options = {}) {
    const storage = options.storage ?? root.localStorage;
    const keyPrefix = options.keyPrefix || "whl-region-settings:v1:";
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" || typeof storage.removeItem !== "function") {
      throw new SettingsValidationError("localStorage persistence requires a Storage-compatible object");
    }
    return Object.freeze({
      async load(projectId) {
        assertIdentifier(projectId, "projectId");
        const serialized = storage.getItem(persistenceKey(keyPrefix, projectId));
        if (serialized === null) return null;
        try {
          return normalizeDocument(JSON.parse(serialized), projectId, "stored settings");
        } catch (error) {
          if (error instanceof SettingsValidationError) throw error;
          throw new SettingsValidationError(`Stored region settings are corrupt: ${error.message}`);
        }
      },
      async save(projectId, document) {
        assertIdentifier(projectId, "projectId");
        const normalized = normalizeDocument(document, projectId, "settings to save");
        storage.setItem(persistenceKey(keyPrefix, projectId), stableStringify(normalized));
      },
      async remove(projectId) {
        assertIdentifier(projectId, "projectId");
        storage.removeItem(persistenceKey(keyPrefix, projectId));
      }
    });
  }

  function createIndexedDBPersistence(options = {}) {
    const indexedDB = options.indexedDB ?? root.indexedDB;
    const dbName = options.dbName || "whl-region-settings";
    const storeName = options.storeName || "projects";
    if (!indexedDB || typeof indexedDB.open !== "function") {
      throw new SettingsValidationError("IndexedDB persistence requires an IDBFactory-compatible object");
    }
    let databasePromise;
    const database = () => {
      if (databasePromise) return databasePromise;
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, SCHEMA_VERSION);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: "projectId" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Unable to open region settings database"));
        request.onblocked = () => reject(new Error("Region settings database upgrade is blocked"));
      });
      return databasePromise;
    };
    const requestResult = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
    return Object.freeze({
      async load(projectId) {
        assertIdentifier(projectId, "projectId");
        const db = await database();
        const record = await requestResult(db.transaction(storeName, "readonly").objectStore(storeName).get(projectId));
        return record ? normalizeDocument(record.document, projectId, "stored settings") : null;
      },
      async save(projectId, document) {
        assertIdentifier(projectId, "projectId");
        const normalized = normalizeDocument(document, projectId, "settings to save");
        const db = await database();
        const transaction = db.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).put({ projectId, document: normalized });
        await new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error || new Error("Unable to save region settings"));
          transaction.onabort = () => reject(transaction.error || new Error("Region settings save was aborted"));
        });
      },
      async remove(projectId) {
        assertIdentifier(projectId, "projectId");
        const db = await database();
        const transaction = db.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).delete(projectId);
        await new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error || new Error("Unable to remove region settings"));
          transaction.onabort = () => reject(transaction.error || new Error("Region settings removal was aborted"));
        });
      }
    });
  }

  function createBrowserPersistence(options = {}) {
    let indexed = null;
    let local = null;
    try {
      indexed = createIndexedDBPersistence(options);
    } catch {
      // A local fallback may still be usable.
    }
    try {
      local = createLocalStoragePersistence(options);
    } catch {
      // IndexedDB may still be usable.
    }
    if (!indexed && !local) throw new SettingsValidationError("No browser persistence mechanism is available");
    return Object.freeze({
      async load(projectId) {
        let indexedValue = null;
        let localValue = null;
        if (indexed) {
          try { indexedValue = await indexed.load(projectId); } catch { /* Try the fallback. */ }
        }
        if (local) {
          try { localValue = await local.load(projectId); } catch { /* A valid IDB copy may remain. */ }
        }
        if (localValue !== null && (indexedValue === null || !sameValue(localValue, indexedValue))) {
          if (indexed) indexed.save(projectId, localValue).catch(() => {});
          return localValue;
        }
        return indexedValue;
      },
      async save(projectId, document) {
        let localSaved = false;
        let localError = null;
        if (local) {
          try {
            await local.save(projectId, document);
            localSaved = true;
          } catch (error) {
            localError = error;
          }
        }
        let indexedError = null;
        if (indexed) {
          try {
            await indexed.save(projectId, document);
            if (!localSaved && local) await local.remove(projectId).catch(() => {});
            return;
          } catch (error) {
            indexedError = error;
          }
        }
        if (localSaved) return;
        throw indexedError || localError || new Error("No persistence mechanism could save region settings");
      },
      async remove(projectId) {
        const tasks = [];
        if (indexed) tasks.push(indexed.remove(projectId).catch(() => {}));
        if (local) tasks.push(local.remove(projectId));
        await Promise.all(tasks);
      }
    });
  }

  class RegionSettingsEngine {
    constructor(options = {}) {
      assertObject(options, "options");
      const allowed = new Set(["base", "local", "projectId", "editorEnabled", "persistence", "defaults", "historyLimit"]);
      Object.keys(options).forEach((key) => {
        if (!allowed.has(key)) fail(`options.${key}`, "unknown option");
      });
      this.projectId = assertIdentifier(options.projectId || options.base?.projectId || options.local?.projectId || "living-herbal", "options.projectId");
      this.editorEnabled = options.editorEnabled === true;
      this.persistence = options.persistence || null;
      if (this.persistence) {
        ["load", "save", "remove"].forEach((method) => {
          if (typeof this.persistence[method] !== "function") fail(`options.persistence.${method}`, "must be a function");
        });
      }
      this.defaults = options.defaults ? normalizePatch(options.defaults, "options.defaults", "book") : {};
      this.base = options.base ? normalizeDocument(options.base, this.projectId, "base") : emptyDocument(this.projectId);
      this.local = options.local ? normalizeDocument(options.local, this.projectId, "local") : emptyDocument(this.projectId);
      this.revision = 0;
      this.historyLimit = assertFiniteNumber(options.historyLimit ?? 100, 1, 1000, "options.historyLimit", true);
      this.undoStack = [];
      this.redoStack = [];
      this.listeners = new Set();
      this.batchDepth = 0;
      this.batchChanged = false;
      this.batchOperations = [];
      this.pendingSave = Promise.resolve();
      this.persistenceError = null;
      this.dirtyBeforeReady = false;
      this.readySettled = false;
      this.ready = this.initializePersistence(options.local === undefined || options.local === null);
    }

    async initializePersistence(shouldLoad) {
      if (this.persistence && shouldLoad) {
        try {
          const stored = await this.persistence.load(this.projectId);
          if (stored !== null && !this.dirtyBeforeReady) this.local = normalizeDocument(stored, this.projectId, "stored settings");
        } catch (error) {
          this.persistenceError = error;
        }
      }
      this.readySettled = true;
      if (this.dirtyBeforeReady) this.scheduleSave();
      return this;
    }

    assertEditable() {
      if (!this.editorEnabled) throw new EditorDisabledError();
    }

    scheduleSave() {
      if (!this.persistence) return;
      if (!this.readySettled) {
        this.dirtyBeforeReady = true;
        return;
      }
      const document = this.export();
      this.pendingSave = this.pendingSave.then(
        () => this.persistence.save(this.projectId, document),
        () => this.persistence.save(this.projectId, document)
      ).then(() => {
        this.persistenceError = null;
      }).catch((error) => {
        this.persistenceError = error;
      });
    }

    async flush() {
      await this.ready;
      await this.pendingSave;
    }

    notify(type, operations = []) {
      const event = Object.freeze({ type, revision: this.revision, operations: clone(operations) });
      this.listeners.forEach((listener) => {
        try {
          listener(event);
        } catch {
          // A subscriber cannot interrupt settings state changes.
        }
      });
    }

    commit(before, operations) {
      this.undoStack.push(before);
      if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
      this.redoStack.length = 0;
      this.revision += 1;
      this.scheduleSave();
      this.notify("change", operations);
    }

    mutate(operation, callback) {
      this.assertEditable();
      const signature = stableStringify(this.local);
      const before = this.batchDepth ? null : clone(this.local);
      callback();
      pruneEmpty(this.local.overrides);
      if (signature === stableStringify(this.local)) return false;
      if (this.batchDepth) {
        this.batchChanged = true;
        this.batchOperations.push(operation);
      } else {
        this.commit(before, [operation]);
      }
      return true;
    }

    set(targetInput, patchInput) {
      this.assertEditable();
      const target = normalizeTarget(targetInput);
      const patch = normalizePatch(patchInput, "patch", target.scope);
      return this.mutate({ op: "set", target }, () => setScopePatch(this.local, target, patch));
    }

    remove(targetInput, path) {
      this.assertEditable();
      const target = normalizeTarget(targetInput);
      const paths = normalizeRemovePaths(path);
      if (target.scope !== "region" && paths?.some((segments) => segments[0] === "text" || (segments[0] === "geometry" && segments[1] === "box"))) {
        fail("path", "text and exact boxes are only valid for a region scope");
      }
      return this.mutate({ op: "remove", target, path: path ?? null }, () => {
        if (!paths) {
          deleteScope(this.local, target);
          return;
        }
        const scope = getScope(this.local, target);
        if (!scope) return;
        paths.forEach((segments) => {
          if (segments.length === 1) delete scope[segments[0]];
          else if (scope[segments[0]]) delete scope[segments[0]][segments[1]];
        });
      });
    }

    setText(targetInput, layer, text) {
      this.assertEditable();
      const target = normalizeTarget(targetInput);
      if (target.scope !== "region") fail("target.scope", "must be region when editing text");
      if (!TEXT_LAYERS.has(layer)) fail("layer", "must be modern or diplomatic");
      if (typeof text !== "string" || text.length > 1_000_000) fail("text", "must be a string no longer than 1,000,000 characters");
      return this.mutate({ op: "setText", target, layer }, () => setScopePatch(this.local, target, { text: { [layer]: text } }));
    }

    clearText(targetInput, layer) {
      this.assertEditable();
      const target = normalizeTarget(targetInput);
      if (target.scope !== "region") fail("target.scope", "must be region when clearing text");
      if (!TEXT_LAYERS.has(layer)) fail("layer", "must be modern or diplomatic");
      return this.remove(target, `text.${layer}`);
    }

    import(document, options = {}) {
      this.assertEditable();
      assertObject(options, "import options");
      Object.keys(options).forEach((key) => {
        if (key !== "mode") fail(`import options.${key}`, "unknown option");
      });
      const mode = options.mode || "merge";
      if (!new Set(["merge", "replace"]).has(mode)) fail("import options.mode", "must be merge or replace");
      const normalized = normalizeDocument(document, this.projectId, "import");
      return this.mutate({ op: "import", mode }, () => {
        this.local = mode === "replace" ? normalized : mergeDocuments(this.local, normalized);
      });
    }

    export(options = {}) {
      assertObject(options, "export options");
      Object.keys(options).forEach((key) => {
        if (!["stringify", "pretty"].includes(key)) fail(`export options.${key}`, "unknown option");
      });
      const document = canonicalize(this.local);
      return options.stringify ? stableStringify(document, options.pretty === true) : clone(document);
    }

    snapshot() {
      return {
        schema: SCHEMA,
        schemaVersion: SCHEMA_VERSION,
        projectId: this.projectId,
        editorEnabled: this.editorEnabled,
        revision: this.revision,
        canUndo: this.undoStack.length > 0,
        canRedo: this.redoStack.length > 0,
        persistenceError: this.persistenceError ? String(this.persistenceError.message || this.persistenceError) : null,
        base: clone(this.base),
        local: this.export()
      };
    }

    getScope(targetInput, options = {}) {
      const target = normalizeTarget(targetInput);
      assertObject(options, "getScope options");
      Object.keys(options).forEach((key) => {
        if (key !== "source") fail(`getScope options.${key}`, "unknown option");
      });
      const source = options.source || "overlay";
      if (!new Set(["overlay", "base", "local"]).has(source)) fail("getScope options.source", "must be overlay, base, or local");
      const baseScope = getScope(this.base, target);
      const localScope = getScope(this.local, target);
      const base = baseScope ? mergePatch(null, baseScope) : null;
      const local = localScope ? mergePatch(null, localScope) : null;
      if (source === "base") return base ? clone(base) : null;
      if (source === "local") return local ? clone(local) : null;
      if (!base && !local) return null;
      return mergePatch(base, local);
    }

    resolve(context) {
      const allowed = new Set(["bookId", "page", "role", "regionId", "layer"]);
      assertAllowedKeys(context, allowed, "context");
      const bookId = assertIdentifier(context.bookId, "context.bookId");
      const page = normalizePage(context.page, "context.page");
      const role = assertIdentifier(context.role, "context.role", ROLE_PATTERN);
      const regionId = assertIdentifier(context.regionId, "context.regionId");
      const layer = context.layer ?? "modern";
      if (!TEXT_LAYERS.has(layer)) fail("context.layer", "must be modern or diplomatic");
      const resolved = { style: {}, geometry: {}, fit: {}, text: undefined, hasTextOverride: false };
      applyPatchToResolved(resolved, this.defaults, layer);
      const targets = [
        { scope: "book", bookId },
        { scope: "regionType", bookId, role },
        { scope: "page", bookId, page },
        { scope: "pageRegionType", bookId, page, role },
        { scope: "region", bookId, page, regionId }
      ];
      targets.forEach((target) => {
        applyPatchToResolved(resolved, getScope(this.base, target), layer);
        applyPatchToResolved(resolved, getScope(this.local, target), layer);
      });
      return clone(resolved);
    }

    undo() {
      this.assertEditable();
      if (!this.undoStack.length) return false;
      this.redoStack.push(clone(this.local));
      this.local = this.undoStack.pop();
      this.revision += 1;
      this.scheduleSave();
      this.notify("undo");
      return true;
    }

    redo() {
      this.assertEditable();
      if (!this.redoStack.length) return false;
      this.undoStack.push(clone(this.local));
      this.local = this.redoStack.pop();
      this.revision += 1;
      this.scheduleSave();
      this.notify("redo");
      return true;
    }

    batch(callbackOrCommands, label = "batch") {
      this.assertEditable();
      if (this.batchDepth) {
        if (typeof callbackOrCommands === "function") return callbackOrCommands(this);
        return this.applyCommands(callbackOrCommands);
      }
      const before = clone(this.local);
      this.batchDepth = 1;
      this.batchChanged = false;
      this.batchOperations = [];
      try {
        const result = typeof callbackOrCommands === "function"
          ? callbackOrCommands(this)
          : this.applyCommands(callbackOrCommands);
        if (result && typeof result.then === "function") fail("batch", "callback must be synchronous");
        this.batchDepth = 0;
        if (this.batchChanged && !sameValue(before, this.local)) this.commit(before, [{ op: "batch", label, operations: this.batchOperations }]);
        return result;
      } catch (error) {
        this.local = before;
        this.batchDepth = 0;
        this.batchChanged = false;
        this.batchOperations = [];
        throw error;
      }
    }

    applyCommands(commands) {
      if (!Array.isArray(commands)) fail("batch", "must receive a callback or command array");
      commands.forEach((command, index) => {
        assertObject(command, `batch[${index}]`);
        if (command.op === "set") this.set(command.target, command.patch);
        else if (command.op === "remove") this.remove(command.target, command.path);
        else if (command.op === "setText") this.setText(command.target, command.layer, command.text);
        else if (command.op === "clearText") this.clearText(command.target, command.layer);
        else fail(`batch[${index}].op`, "has an unsupported operation");
      });
      return true;
    }

    subscribe(listener) {
      if (typeof listener !== "function") fail("listener", "must be a function");
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
  }

  function createEngine(options = {}) {
    return new RegionSettingsEngine(options);
  }

  root.WHLRegionSettings = Object.freeze({
    SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    EditorDisabledError,
    SettingsValidationError,
    createEngine,
    createIndexedDBPersistence,
    createLocalStoragePersistence,
    createBrowserPersistence
  });
})();
