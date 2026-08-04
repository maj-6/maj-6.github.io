import { ProjectValidationError } from "./errors.js";

export const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const ROLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/;

export function fail(path, message) {
  throw new ProjectValidationError(path, message);
}

export function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertObject(value, path) {
  if (!isPlainObject(value)) fail(path, "must be a plain object");
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) fail(`${path}.${key}`, "contains an unsafe key");
  }
  return value;
}

export function assertAllowedKeys(value, allowed, path) {
  assertObject(value, path);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unknown property");
  }
}

export function assertSafeId(value, path, pattern = SAFE_ID_PATTERN) {
  if (typeof value !== "string" || !pattern.test(value) || DANGEROUS_KEYS.has(value)) {
    fail(path, "must be a safe identifier");
  }
  return value;
}

export function assertFiniteNumber(value, minimum, maximum, path, { integer = false } = {}) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
    || (integer && !Number.isInteger(value))
  ) {
    fail(path, `must be ${integer ? "an integer" : "a finite number"} from ${minimum} to ${maximum}`);
  }
  return Object.is(value, -0) ? 0 : value;
}

export function normalizePage(value, path = "page") {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return assertFiniteNumber(parsed, 1, 10_000_000, path, { integer: true });
}

export function normalizeLabel(value, path, { nullable = false, maximum = 256 } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") fail(path, "must be a string");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    fail(path, `must contain 1 to ${maximum} printable characters`);
  }
  return normalized;
}

export function clone(value, depth = 0) {
  if (depth > 100) fail("value", "is nested too deeply");
  if (Array.isArray(value)) return value.map((item) => clone(item, depth + 1));
  if (isPlainObject(value)) {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) fail(key, "contains an unsafe key");
      result[key] = clone(item, depth + 1);
    }
    return result;
  }
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  fail("value", "must contain only JSON-compatible values");
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

export function immutableClone(value) {
  return deepFreeze(clone(value));
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  const result = {};
  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
    result[key] = canonicalize(value[key]);
  }
  return result;
}

export function stableStringify(value, pretty = false) {
  return JSON.stringify(canonicalize(value), null, pretty ? 2 : 0);
}

export function sameValue(first, second) {
  return stableStringify(first) === stableStringify(second);
}

export function deepMerge(base, overlay) {
  const result = isPlainObject(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(overlay || {})) {
    if (isPlainObject(value) && isPlainObject(result[key])) result[key] = deepMerge(result[key], value);
    else result[key] = clone(value);
  }
  return result;
}

export function pruneEmpty(value) {
  if (!isPlainObject(value)) return value;
  for (const key of Object.keys(value)) {
    if (isPlainObject(value[key])) {
      pruneEmpty(value[key]);
      if (!Object.keys(value[key]).length) delete value[key];
    }
  }
  return value;
}

export function getPath(root, path) {
  let value = root;
  for (const segment of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, segment)) {
      return { exists: false, value: undefined };
    }
    value = value[segment];
  }
  return { exists: true, value };
}

export function setPath(root, path, value) {
  if (!path.length) throw new TypeError("Cannot replace the transaction root");
  let target = root;
  for (const segment of path.slice(0, -1)) {
    if (!isPlainObject(target[segment])) target[segment] = {};
    target = target[segment];
  }
  target[path.at(-1)] = clone(value);
}

export function deletePath(root, path) {
  if (!path.length) throw new TypeError("Cannot delete the transaction root");
  const parents = [];
  let target = root;
  for (const segment of path.slice(0, -1)) {
    if (!target || typeof target !== "object" || !Object.hasOwn(target, segment)) return;
    parents.push([target, segment]);
    target = target[segment];
  }
  delete target[path.at(-1)];
  for (const [parent, segment] of parents.reverse()) {
    if (isPlainObject(parent[segment]) && !Object.keys(parent[segment]).length) delete parent[segment];
    else break;
  }
}

export function leafPaths(value, prefix = []) {
  if (!isPlainObject(value) || !Object.keys(value).length) return [prefix];
  return Object.entries(value).flatMap(([key, item]) => leafPaths(item, [...prefix, key]));
}

export function normalizeStringArray(value, path, { pattern = SAFE_ID_PATTERN } = {}) {
  if (!Array.isArray(value)) fail(path, "must be an array");
  const result = [];
  const seen = new Set();
  value.forEach((item, index) => {
    const id = assertSafeId(item, `${path}[${index}]`, pattern);
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  });
  return result;
}

export function normalizeJsonBag(value, path) {
  assertObject(value, path);
  return clone(value);
}
