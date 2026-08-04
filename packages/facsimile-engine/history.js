import { clone, deletePath, getPath, immutableClone, isPlainObject, sameValue, setPath } from "./utils.js";

function collectChanges(before, after, path = [], operations = []) {
  if (sameValue(before, after)) return operations;
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const oldExists = Object.hasOwn(before, key);
      const newExists = Object.hasOwn(after, key);
      if (!oldExists || !newExists) {
        operations.push({
          path: [...path, key],
          oldExists,
          ...(oldExists ? { oldValue: clone(before[key]) } : {}),
          newExists,
          ...(newExists ? { newValue: clone(after[key]) } : {})
        });
      } else collectChanges(before[key], after[key], [...path, key], operations);
    }
    return operations;
  }
  operations.push({ path, oldExists: true, oldValue: clone(before), newExists: true, newValue: clone(after) });
  return operations;
}

export function createChangeSet(before, after, metadata = {}) {
  const operations = collectChanges(before, after);
  return immutableClone({
    id: metadata.id || `operation:${metadata.sequence ?? 0}`,
    sequence: metadata.sequence ?? 0,
    operatorId: metadata.operatorId || "unknown",
    arguments: clone(metadata.arguments || {}),
    dirtyTags: [...new Set(metadata.dirtyTags || [])].sort(),
    operations
  });
}

export function applyChangeSet(document, changeSet, direction = "forward") {
  if (!["forward", "inverse"].includes(direction)) throw new TypeError("direction must be forward or inverse");
  const result = clone(document);
  const operations = direction === "forward" ? changeSet.operations : [...changeSet.operations].reverse();
  for (const operation of operations) {
    const exists = direction === "forward" ? operation.newExists : operation.oldExists;
    const value = direction === "forward" ? operation.newValue : operation.oldValue;
    if (!operation.path.length) throw new TypeError("A changeset cannot replace the project root");
    if (exists) setPath(result, operation.path, value);
    else deletePath(result, operation.path);
  }
  return result;
}

export class History {
  #past = [];
  #future = [];
  #limit;

  constructor({ limit = 200 } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("history limit must be a positive integer");
    this.#limit = limit;
  }

  push(changeSet) {
    if (!changeSet.operations.length) return false;
    this.#past.push(changeSet);
    if (this.#past.length > this.#limit) this.#past.shift();
    this.#future.length = 0;
    return true;
  }

  undo(document) {
    const changeSet = this.#past.pop();
    if (!changeSet) return null;
    this.#future.push(changeSet);
    return { document: applyChangeSet(document, changeSet, "inverse"), changeSet };
  }

  redo(document) {
    const changeSet = this.#future.pop();
    if (!changeSet) return null;
    this.#past.push(changeSet);
    return { document: applyChangeSet(document, changeSet, "forward"), changeSet };
  }

  clear() {
    this.#past.length = 0;
    this.#future.length = 0;
  }

  snapshot() {
    return immutableClone({
      canUndo: this.#past.length > 0,
      canRedo: this.#future.length > 0,
      undoLabel: this.#past.at(-1)?.operatorId || null,
      redoLabel: this.#future.at(-1)?.operatorId || null,
      past: this.#past,
      future: this.#future
    });
  }
}
