import { RegistryError } from "./errors.js";
import { assertSafeId, clone, deepMerge, immutableClone, isPlainObject } from "./utils.js";

function validateDefinition(definition, kind) {
  if (!isPlainObject(definition)) throw new RegistryError(`${kind} definition must be a plain object`);
  assertSafeId(definition.id, `${kind}.id`);
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new RegistryError(`${kind} ${definition.id} must have a positive integer version`);
  }
  if (typeof definition.extensionId !== "string" || !definition.extensionId) {
    throw new RegistryError(`${kind} ${definition.id} must declare extensionId`);
  }
}

export class ComponentRegistry {
  #definitions = new Map();

  register(definition) {
    validateDefinition(definition, "component");
    if (typeof definition.validate !== "function") {
      throw new RegistryError(`component ${definition.id} must provide validate(value, metadata)`);
    }
    if (definition.readerSafe !== undefined && typeof definition.readerSafe !== "boolean") {
      throw new RegistryError(`component ${definition.id} readerSafe must be a boolean`);
    }
    if (definition.readerSafe === true && typeof definition.serializeForReader !== "function") {
      throw new RegistryError(`reader-safe component ${definition.id} must provide serializeForReader(value)`);
    }
    if (this.#definitions.has(definition.id)) throw new RegistryError(`component ${definition.id} is already registered`);
    const normalized = Object.freeze({
      readerSafe: false,
      defaults: {},
      merge: deepMerge,
      ...definition,
      defaults: clone(definition.defaults || {})
    });
    this.#definitions.set(normalized.id, normalized);
    return this;
  }

  has(id) {
    return this.#definitions.has(id);
  }

  get(id) {
    const definition = this.#definitions.get(id);
    if (!definition) throw new RegistryError(`component ${id} is not registered`, { componentId: id });
    return definition;
  }

  normalize(id, value, metadata = {}) {
    const definition = this.get(id);
    const normalized = definition.validate(clone(value), immutableClone(metadata));
    if (!isPlainObject(normalized)) throw new RegistryError(`component ${id} validator must return a plain object`);
    return clone(normalized);
  }

  merge(id, base, patch) {
    const definition = this.get(id);
    const merged = definition.merge(clone(base || {}), clone(patch || {}));
    if (!isPlainObject(merged)) throw new RegistryError(`component ${id} merge must return a plain object`);
    return clone(merged);
  }

  entries() {
    return [...this.#definitions.values()];
  }

  supportedExtensions() {
    return new Set(this.entries().map((definition) => definition.extensionId));
  }
}

export class RendererRegistry {
  #definitions = new Map();

  register(definition) {
    validateDefinition(definition, "renderer");
    if (typeof definition.poll !== "function" || typeof definition.evaluate !== "function") {
      throw new RegistryError(`renderer ${definition.id} must provide poll() and evaluate()`);
    }
    if (definition.readerSafe !== undefined && typeof definition.readerSafe !== "boolean") {
      throw new RegistryError(`renderer ${definition.id} readerSafe must be a boolean`);
    }
    if (definition.readerSafe === true && typeof definition.serializeForReader !== "function") {
      throw new RegistryError(`reader-safe renderer ${definition.id} must provide serializeForReader(value)`);
    }
    if (this.#definitions.has(definition.id)) throw new RegistryError(`renderer ${definition.id} is already registered`);
    this.#definitions.set(definition.id, Object.freeze({ readerSafe: false, ...definition }));
    return this;
  }

  has(id) {
    return this.#definitions.has(id);
  }

  get(id) {
    const definition = this.#definitions.get(id);
    if (!definition) throw new RegistryError(`renderer ${id} is not registered`, { rendererId: id });
    return definition;
  }

  choose(evaluatedRegion, category = null, environment = {}) {
    if (category?.rendererId) {
      const renderer = this.get(category.rendererId);
      return renderer.poll(evaluatedRegion, category, environment) ? renderer : null;
    }
    return [...this.#definitions.values()].find((renderer) => renderer.poll(evaluatedRegion, category, environment)) || null;
  }

  evaluate(evaluatedRegion, category = null, environment = {}) {
    const renderer = this.choose(evaluatedRegion, category, environment);
    if (!renderer) return null;
    return immutableClone({ ...renderer.evaluate(evaluatedRegion, category, environment), rendererId: renderer.id });
  }

  entries() {
    return [...this.#definitions.values()];
  }

  supportedExtensions() {
    return new Set(this.entries().map((definition) => definition.extensionId));
  }
}

function normalizePollResult(value) {
  if (value === true || value === undefined) return { allowed: true, reason: null };
  if (value === false) return { allowed: false, reason: "Operator is unavailable in the current context." };
  if (typeof value === "string") return { allowed: false, reason: value };
  if (isPlainObject(value) && typeof value.allowed === "boolean") {
    return { allowed: value.allowed, reason: value.allowed ? null : String(value.reason || "Operator is unavailable.") };
  }
  throw new RegistryError("operator poll() returned an invalid result");
}

export class OperatorRegistry {
  #definitions = new Map();

  register(definition) {
    validateDefinition(definition, "operator");
    if (typeof definition.execute !== "function") throw new RegistryError(`operator ${definition.id} must provide execute()`);
    if (definition.poll !== undefined && typeof definition.poll !== "function") {
      throw new RegistryError(`operator ${definition.id} poll must be a function`);
    }
    if (this.#definitions.has(definition.id)) throw new RegistryError(`operator ${definition.id} is already registered`);
    this.#definitions.set(definition.id, Object.freeze({ poll: () => true, ...definition }));
    return this;
  }

  has(id) {
    return this.#definitions.has(id);
  }

  get(id) {
    const definition = this.#definitions.get(id);
    if (!definition) throw new RegistryError(`operator ${id} is not registered`, { operatorId: id });
    return definition;
  }

  poll(id, environment) {
    return Object.freeze(normalizePollResult(this.get(id).poll(environment)));
  }

  entries() {
    return [...this.#definitions.values()];
  }

  supportedExtensions() {
    return new Set(this.entries().map((definition) => definition.extensionId));
  }
}
