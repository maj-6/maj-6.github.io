import { ComponentRegistry, OperatorRegistry, RendererRegistry } from "./registries.js";
import {
  assertAllowedKeys,
  assertFiniteNumber,
  assertObject,
  assertSafeId,
  clone,
  deepMerge,
  fail,
  isPlainObject,
  normalizeLabel
} from "./utils.js";

export const CORE_EXTENSION = "whl.core";
export const DECORATED_INITIAL_EXTENSION = "whl.decorated-initial";
export const DECORATED_INITIAL_CATEGORY = "visual.ornament.decorated-initial";
export const DECORATED_INITIAL_COMPONENT = "render.decoratedInitial";
export const DECORATED_INITIAL_RENDERER = "decorated-initial";
// Source-compatible names for the short-lived v2 prototype. New documents are
// always normalized to the historically broader decorated-initial vocabulary.
export const ILLUMINATED_CAPITAL_EXTENSION = DECORATED_INITIAL_EXTENSION;
export const ILLUMINATED_CAPITAL_CATEGORY = DECORATED_INITIAL_CATEGORY;
export const ILLUMINATED_CAPITAL_COMPONENT = DECORATED_INITIAL_COMPONENT;
export const ILLUMINATED_CAPITAL_RENDERER = DECORATED_INITIAL_RENDERER;

const COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const FONT_TOKENS = new Set(["edition", "georgia", "palatino", "sans"]);
const REPRESENTATIONS = new Set(["auto", "original", "modern", "diplomatic", "hidden"]);
const serializeJsonForReader = (value) => clone(value);

function normalizeTypography(value, metadata) {
  const allowed = new Set(["fontFamily", "fontSize", "fontWeight", "color", "lineHeight", "letterSpacing"]);
  assertAllowedKeys(value, allowed, metadata.path || "core.typography");
  const path = metadata.path || "core.typography";
  const result = {};
  if (Object.hasOwn(value, "fontFamily")) {
    if (!FONT_TOKENS.has(value.fontFamily)) fail(`${path}.fontFamily`, "has an unsupported font token");
    result.fontFamily = value.fontFamily;
  }
  if (Object.hasOwn(value, "fontSize")) result.fontSize = assertFiniteNumber(value.fontSize, 0.5, 4, `${path}.fontSize`);
  if (Object.hasOwn(value, "fontWeight")) {
    result.fontWeight = assertFiniteNumber(value.fontWeight, 100, 900, `${path}.fontWeight`, { integer: true });
  }
  if (Object.hasOwn(value, "color")) {
    if (typeof value.color !== "string" || !COLOR_PATTERN.test(value.color)) fail(`${path}.color`, "must be an opaque hexadecimal color");
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

function normalizeTransform(value, metadata) {
  const path = metadata.path || "core.transform";
  const allowed = new Set(["box", "translateX", "translateY", "scaleX", "scaleY"]);
  assertAllowedKeys(value, allowed, path);
  const result = {};
  if (Object.hasOwn(value, "box")) {
    if (metadata.scope !== "region") fail(`${path}.box`, "is valid only for an exact region");
    result.box = normalizeBox(value.box, `${path}.box`);
  }
  if (Object.hasOwn(value, "translateX")) result.translateX = assertFiniteNumber(value.translateX, -1, 1, `${path}.translateX`);
  if (Object.hasOwn(value, "translateY")) result.translateY = assertFiniteNumber(value.translateY, -1, 1, `${path}.translateY`);
  if (Object.hasOwn(value, "scaleX")) result.scaleX = assertFiniteNumber(value.scaleX, 0.25, 4, `${path}.scaleX`);
  if (Object.hasOwn(value, "scaleY")) result.scaleY = assertFiniteNumber(value.scaleY, 0.25, 4, `${path}.scaleY`);
  return result;
}

function normalizeTextLayout(value, metadata) {
  const path = metadata.path || "core.textLayout";
  const allowed = new Set(["mode", "wrap", "overflow", "maxWidthScale", "minFontScale"]);
  assertAllowedKeys(value, allowed, path);
  const result = {};
  if (Object.hasOwn(value, "mode")) {
    if (!["scroll", "grow-width", "shrink-text", "grow-then-shrink"].includes(value.mode)) fail(`${path}.mode`, "has an unsupported fit mode");
    result.mode = value.mode;
  }
  if (Object.hasOwn(value, "wrap")) {
    if (!["normal", "nowrap", "balance"].includes(value.wrap)) fail(`${path}.wrap`, "has an unsupported wrapping mode");
    result.wrap = value.wrap;
  }
  if (Object.hasOwn(value, "overflow")) {
    if (!["hidden", "auto", "scroll", "visible"].includes(value.overflow)) fail(`${path}.overflow`, "has an unsupported overflow policy");
    result.overflow = value.overflow;
  }
  if (Object.hasOwn(value, "maxWidthScale")) {
    result.maxWidthScale = assertFiniteNumber(value.maxWidthScale, 1, 4, `${path}.maxWidthScale`);
  }
  if (Object.hasOwn(value, "minFontScale")) {
    result.minFontScale = assertFiniteNumber(value.minFontScale, 0.5, 1, `${path}.minFontScale`);
  }
  return result;
}

function normalizeOriginalSettings(value, path) {
  assertAllowedKeys(value, new Set(["assetRef", "fit", "alignX", "alignY", "opacity", "blendMode"]), path);
  const result = {};
  if (Object.hasOwn(value, "assetRef")) result.assetRef = assertSafeId(value.assetRef, `${path}.assetRef`);
  if (Object.hasOwn(value, "fit")) {
    if (!["contain", "cover", "stretch"].includes(value.fit)) fail(`${path}.fit`, "must be contain, cover, or stretch");
    result.fit = value.fit;
  }
  if (Object.hasOwn(value, "alignX")) result.alignX = assertFiniteNumber(value.alignX, 0, 1, `${path}.alignX`);
  if (Object.hasOwn(value, "alignY")) result.alignY = assertFiniteNumber(value.alignY, 0, 1, `${path}.alignY`);
  if (Object.hasOwn(value, "opacity")) result.opacity = assertFiniteNumber(value.opacity, 0, 1, `${path}.opacity`);
  if (Object.hasOwn(value, "blendMode")) {
    if (!["normal", "multiply"].includes(value.blendMode)) fail(`${path}.blendMode`, "must be normal or multiply");
    result.blendMode = value.blendMode;
  }
  return result;
}

function normalizeEquivalent(value, path) {
  assertAllowedKeys(value, new Set(["text", "continuationRegionId", "consumePrefix"]), path);
  if (typeof value.text !== "string" || value.text.length < 1 || value.text.length > 256) fail(`${path}.text`, "must be a string from 1 to 256 characters");
  const result = { text: value.text };
  if (Object.hasOwn(value, "continuationRegionId")) {
    result.continuationRegionId = assertSafeId(value.continuationRegionId, `${path}.continuationRegionId`);
  }
  if (Object.hasOwn(value, "consumePrefix")) {
    if (!Object.hasOwn(value, "continuationRegionId")) fail(`${path}.consumePrefix`, "requires continuationRegionId");
    if (typeof value.consumePrefix !== "string" || value.consumePrefix.length < 1 || value.consumePrefix.length > 256) fail(`${path}.consumePrefix`, "must be a string from 1 to 256 characters");
    result.consumePrefix = value.consumePrefix;
  }
  return result;
}

function normalizeEquivalents(value, path) {
  assertAllowedKeys(value, new Set(["modern", "diplomatic"]), path);
  const result = {};
  for (const edition of ["modern", "diplomatic"]) {
    if (Object.hasOwn(value, edition)) result[edition] = normalizeEquivalent(value[edition], `${path}.${edition}`);
  }
  return result;
}

function normalizeRepresentationByEdition(value, path) {
  assertAllowedKeys(value, new Set(["modern", "diplomatic"]), path);
  const result = {};
  for (const edition of ["modern", "diplomatic"]) {
    if (!Object.hasOwn(value, edition)) continue;
    if (!REPRESENTATIONS.has(value[edition])) fail(`${path}.${edition}`, "has an unsupported representation");
    result[edition] = value[edition];
  }
  return result;
}

function normalizeDecoratedText(value, path) {
  assertAllowedKeys(value, new Set(["placement", "dropLines", "scale", "align"]), path);
  const result = {};
  if (Object.hasOwn(value, "placement")) {
    if (!["inline", "drop-cap", "overlay"].includes(value.placement)) fail(`${path}.placement`, "has an unsupported placement");
    result.placement = value.placement;
  }
  if (Object.hasOwn(value, "dropLines")) result.dropLines = assertFiniteNumber(value.dropLines, 1, 12, `${path}.dropLines`, { integer: true });
  if (Object.hasOwn(value, "scale")) result.scale = assertFiniteNumber(value.scale, 0.25, 4, `${path}.scale`);
  if (Object.hasOwn(value, "align")) {
    if (!["start", "center", "end"].includes(value.align)) fail(`${path}.align`, "must be start, center, or end");
    result.align = value.align;
  }
  return result;
}

function normalizeAccessibility(value, path) {
  assertAllowedKeys(value, new Set(["decorative", "description"]), path);
  const result = {};
  if (Object.hasOwn(value, "decorative")) {
    if (typeof value.decorative !== "boolean") fail(`${path}.decorative`, "must be a boolean");
    result.decorative = value.decorative;
  }
  if (Object.hasOwn(value, "description")) {
    if (typeof value.description !== "string" || value.description.length > 500) fail(`${path}.description`, "must be a string no longer than 500 characters");
    result.description = value.description;
  }
  return result;
}

function normalizeDecoratedInitial(value, metadata) {
  const path = metadata.path || DECORATED_INITIAL_COMPONENT;
  assertAllowedKeys(value, new Set([
    "representation", "fallback", "representationByEdition", "equivalents", "original", "text", "accessibility"
  ]), path);
  const result = {};
  for (const field of ["representation", "fallback"]) {
    if (!Object.hasOwn(value, field)) continue;
    if (!REPRESENTATIONS.has(value[field])) fail(`${path}.${field}`, "has an unsupported representation");
    result[field] = value[field];
  }
  if (Object.hasOwn(value, "representationByEdition")) result.representationByEdition = normalizeRepresentationByEdition(value.representationByEdition, `${path}.representationByEdition`);
  if (Object.hasOwn(value, "equivalents")) result.equivalents = normalizeEquivalents(value.equivalents, `${path}.equivalents`);
  if (Object.hasOwn(value, "original")) result.original = normalizeOriginalSettings(value.original, `${path}.original`);
  if (Object.hasOwn(value, "text")) result.text = normalizeDecoratedText(value.text, `${path}.text`);
  if (Object.hasOwn(value, "accessibility")) result.accessibility = normalizeAccessibility(value.accessibility, `${path}.accessibility`);
  return result;
}

function evaluateDecoratedInitial(region, category, environment = {}) {
  const config = deepMerge({
    representation: "auto",
    fallback: "modern",
    representationByEdition: {},
    equivalents: {},
    original: { fit: "contain", alignX: 0.5, alignY: 0.5, opacity: 1, blendMode: "multiply" },
    text: { placement: "drop-cap", dropLines: 2, scale: 1, align: "start" },
    accessibility: { decorative: false, description: "" }
  }, region.components[DECORATED_INITIAL_COMPONENT] || {});
  const activeEdition = environment.activeEdition || "modern";
  const assetRef = config.original.assetRef || region.sourceRegion?.assetRef || null;
  let representation = config.representation === "auto"
    ? (config.representationByEdition[activeEdition] || (activeEdition === "diplomatic" ? "original" : "modern"))
    : config.representation;
  const equivalentText = (candidate) => config.equivalents[candidate]?.text ?? "";
  const available = (candidate) => candidate === "hidden"
    || (candidate === "original" ? Boolean(assetRef) : (["modern", "diplomatic"].includes(candidate) && Boolean(equivalentText(candidate))));
  const diagnostics = [];
  if (!available(representation)) {
    diagnostics.push({ severity: "warning", code: "DECORATED_INITIAL_REPRESENTATION_MISSING", message: `Representation ${representation} is unavailable.` });
    representation = available(config.fallback) ? config.fallback : (assetRef ? "original" : (["modern", "diplomatic"].find(available) || "hidden"));
  }
  const continuationEdition = ["modern", "diplomatic"].includes(representation)
    ? representation
    : (activeEdition === "diplomatic" ? "diplomatic" : "modern");
  const equivalent = config.equivalents[continuationEdition] || {};
  const continuationText = equivalent.continuationRegionId
    ? environment.regionContent?.(equivalent.continuationRegionId, continuationEdition) ?? ""
    : "";
  const consumePrefixMatches = !equivalent.consumePrefix || continuationText.startsWith(equivalent.consumePrefix);
  if (!consumePrefixMatches) diagnostics.push({ severity: "warning", code: "DECORATED_INITIAL_PREFIX_MISMATCH", message: "The continuation prefix did not match and was not consumed." });
  return {
    kind: "decorated-initial",
    representation,
    assetRef: representation === "original" ? assetRef : null,
    text: ["modern", "diplomatic"].includes(representation) ? equivalentText(representation) : null,
    continuationRegionId: equivalent.continuationRegionId || null,
    continuationEdition: equivalent.continuationRegionId ? continuationEdition : null,
    consumePrefix: consumePrefixMatches ? equivalent.consumePrefix || null : null,
    original: clone(config.original),
    textSettings: clone(config.text),
    accessibility: clone(config.accessibility),
    diagnostics
  };
}

export function createBuiltinCategories() {
  return {
    text: { id: "text", displayName: "Text", capabilities: [], components: {} },
    visual: { id: "visual", displayName: "Visual", capabilities: ["visual-source"], components: {} },
    "visual.ornament": { id: "visual.ornament", displayName: "Ornament", parentId: "visual", capabilities: ["visual-source"], components: {} },
    [DECORATED_INITIAL_CATEGORY]: {
      id: DECORATED_INITIAL_CATEGORY,
      displayName: "Decorated initial",
      parentId: "visual.ornament",
      capabilities: ["visual-source", "text-equivalent", "decorated-initial"],
      rendererId: DECORATED_INITIAL_RENDERER,
      components: {}
    },
    navigation: { id: "navigation", displayName: "Navigation", capabilities: [], components: {} },
    artifact: { id: "artifact", displayName: "Artifact", capabilities: [], components: {} }
  };
}

function normalizeContent(value, metadata) {
  const path = metadata.path || "core.content";
  assertAllowedKeys(value, new Set(["modern", "diplomatic"]), path);
  const result = {};
  for (const edition of ["modern", "diplomatic"]) {
    if (!Object.hasOwn(value, edition)) continue;
    if (typeof value[edition] !== "string") fail(`${path}.${edition}`, "must be a string");
    result[edition] = value[edition];
  }
  return result;
}

function normalizeVisibility(value, metadata) {
  const path = metadata.path || "core.visibility";
  assertAllowedKeys(value, new Set(["modern", "diplomatic", "publication"]), path);
  const result = {};
  for (const edition of ["modern", "diplomatic", "publication"]) {
    if (!Object.hasOwn(value, edition)) continue;
    if (typeof value[edition] !== "boolean") fail(`${path}.${edition}`, "must be a boolean");
    result[edition] = value[edition];
  }
  return result;
}

export function createDefaultComponentRegistry() {
  return new ComponentRegistry()
    .register({
      id: "core.typography",
      version: 1,
      extensionId: CORE_EXTENSION,
      readerSafe: true,
      serializeForReader: serializeJsonForReader,
      defaults: {},
      validate: normalizeTypography
    })
    .register({
      id: "core.transform",
      version: 1,
      extensionId: CORE_EXTENSION,
      readerSafe: true,
      serializeForReader: serializeJsonForReader,
      defaults: {},
      validate: normalizeTransform
    })
    .register({
      id: "core.textLayout",
      version: 1,
      extensionId: CORE_EXTENSION,
      readerSafe: true,
      serializeForReader: serializeJsonForReader,
      defaults: {},
      validate: normalizeTextLayout
    })
    .register({
      id: "core.content",
      version: 1,
      extensionId: CORE_EXTENSION,
      readerSafe: true,
      serializeForReader: serializeJsonForReader,
      defaults: {},
      validate: normalizeContent
    })
    .register({
      id: "core.visibility",
      version: 1,
      extensionId: CORE_EXTENSION,
      readerSafe: true,
      serializeForReader: serializeJsonForReader,
      defaults: { modern: true, diplomatic: true, publication: true },
      validate: normalizeVisibility
    })
    .register({
      id: DECORATED_INITIAL_COMPONENT,
      version: 1,
      extensionId: DECORATED_INITIAL_EXTENSION,
      readerSafe: true,
      serializeForReader: serializeJsonForReader,
      defaults: {
        representation: "auto",
        fallback: "modern",
        representationByEdition: {},
        equivalents: {},
        original: { fit: "contain", alignX: 0.5, alignY: 0.5, opacity: 1, blendMode: "multiply" },
        text: { placement: "drop-cap", dropLines: 2, scale: 1, align: "start" },
        accessibility: { decorative: false, description: "" }
      },
      validate: normalizeDecoratedInitial
    });
}

export function createDefaultRendererRegistry() {
  return new RendererRegistry().register({
    id: DECORATED_INITIAL_RENDERER,
    version: 1,
    extensionId: DECORATED_INITIAL_EXTENSION,
    readerSafe: true,
    serializeForReader: serializeJsonForReader,
    poll: (region, category) => category?.capabilities?.includes("decorated-initial")
      || region.categoryCapabilities?.includes("decorated-initial"),
    evaluate: evaluateDecoratedInitial
  });
}

export function createEmptyOperatorRegistry() {
  return new OperatorRegistry();
}

export function normalizeExtensionDescriptor(value, path) {
  assertObject(value, path);
  assertAllowedKeys(value, new Set(["version", "data"]), path);
  if (typeof value.version !== "string" || !value.version || value.version.length > 64) {
    fail(`${path}.version`, "must be a non-empty version string");
  }
  return {
    version: value.version,
    ...(Object.hasOwn(value, "data") ? { data: clone(value.data) } : {})
  };
}
