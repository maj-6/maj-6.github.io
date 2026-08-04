import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDefaultComponentRegistry } from "../../packages/facsimile-engine/builtins.js";
import { createFacsimileEngine } from "../../packages/facsimile-engine/engine.js";
import { normalizeProject } from "../../packages/facsimile-engine/project.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..", "..");
const loadJson = (relativePath) => JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
const editorSchema = loadJson("schemas/editor-project.schema.json");
const readerSchema = loadJson("schemas/reader-publication.schema.json");

class ContractError extends Error {}

function sameJson(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function schemaTarget(rootSchema, reference) {
  if (!reference.startsWith("#/")) throw new ContractError(`unsupported non-local reference ${reference}`);
  return reference.slice(2).split("/").reduce((value, rawPart) => {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || !Object.hasOwn(value, part)) throw new ContractError(`unresolved reference ${reference}`);
    return value[part];
  }, rootSchema);
}

function matchesType(value, expected) {
  switch (expected) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "string": return typeof value === "string";
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    default: throw new ContractError(`unsupported JSON Schema type ${expected}`);
  }
}

function validate(rootSchema, schema, value, path = "$", seenRefs = []) {
  if (schema.$ref) {
    if (seenRefs.length > 200) throw new ContractError(`${path}: reference nesting is too deep`);
    return validate(rootSchema, schemaTarget(rootSchema, schema.$ref), value, path, [...seenRefs, schema.$ref]);
  }

  if (Object.hasOwn(schema, "const") && !sameJson(value, schema.const)) {
    throw new ContractError(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((candidate) => sameJson(value, candidate))) {
    throw new ContractError(`${path}: is not an allowed value`);
  }
  if (schema.not) {
    let matched = true;
    try {
      validate(rootSchema, schema.not, value, path, seenRefs);
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      matched = false;
    }
    if (matched) throw new ContractError(`${path}: matches a forbidden shape`);
  }
  if (schema.anyOf) {
    const matched = schema.anyOf.some((candidate) => {
      try {
        validate(rootSchema, candidate, value, path, seenRefs);
        return true;
      } catch (error) {
        if (!(error instanceof ContractError)) throw error;
        return false;
      }
    });
    if (!matched) throw new ContractError(`${path}: does not match any allowed shape`);
  }

  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((candidate) => matchesType(value, candidate))) {
      throw new ContractError(`${path}: must be ${allowed.join(" or ")}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new ContractError(`${path}: is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new ContractError(`${path}: is above maximum`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) throw new ContractError(`${path}: is too short`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) throw new ContractError(`${path}: is too long`);
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern, "u")).test(value)) {
      throw new ContractError(`${path}: does not match ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new ContractError(`${path}: has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new ContractError(`${path}: has too many items`);
    if (schema.uniqueItems) {
      const encoded = value.map((item) => JSON.stringify(item));
      if (new Set(encoded).size !== encoded.length) throw new ContractError(`${path}: items must be unique`);
    }
    if (schema.items) value.forEach((item, index) => validate(rootSchema, schema.items, item, `${path}[${index}]`, seenRefs));
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      throw new ContractError(`${path}: has too few properties`);
    }
    for (const name of schema.required || []) {
      if (!Object.hasOwn(value, name)) throw new ContractError(`${path}.${name}: is required`);
    }
    for (const [trigger, dependencies] of Object.entries(schema.dependentRequired || {})) {
      if (!Object.hasOwn(value, trigger)) continue;
      for (const dependency of dependencies) {
        if (!Object.hasOwn(value, dependency)) {
          throw new ContractError(`${path}.${dependency}: is required when ${trigger} is present`);
        }
      }
    }
    if (schema.propertyNames) {
      keys.forEach((name) => validate(rootSchema, schema.propertyNames, name, `${path}{${name}}`, seenRefs));
    }
    for (const name of keys) {
      if (schema.properties && Object.hasOwn(schema.properties, name)) {
        validate(rootSchema, schema.properties[name], value[name], `${path}.${name}`, seenRefs);
      } else if (schema.additionalProperties === false) {
        throw new ContractError(`${path}.${name}: additional property is not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validate(rootSchema, schema.additionalProperties, value[name], `${path}.${name}`, seenRefs);
      }
    }
  }

  return true;
}

function assertValid(schema, value) {
  assert.equal(validate(schema, schema, value), true);
}

function assertInvalid(schema, value, message) {
  assert.throws(() => validate(schema, schema, value), ContractError, message);
}

const emptyRules = () => ({ sourceRoles: {}, categories: {}, classes: {} });
const sourceRegionId = "p0037-r007";
const objectRegionId = sourceRegionId;
const fingerprint = "sha256:" + "b".repeat(64);

function representativeEditorProject() {
  const decoratedCategory = {
    id: "visual.ornament.decorated-initial",
    displayName: "Decorated initial",
    parentId: "visual.ornament",
    capabilities: ["visual-source", "text-equivalent", "decorated-initial"],
    color: "#8f6347"
  };
  return {
    schema: "whl-facsimile-project/2",
    schemaVersion: 2,
    projectId: "living-herbal",
    displayName: "The Living Herbal",
    revision: 7,
    requiredExtensions: ["whl.core", "whl.decorated-initial"],
    optionalExtensions: {
      "org.example.review": { version: "1", data: { reviewer: "local" } }
    },
    sourceLibrary: {
      books: {
        "banckes-1552": {
          id: "banckes-1552",
          displayName: "A Little Herball",
          fingerprint,
          pages: {
            "37": {
              page: 37,
              displayName: "Leaf 19 recto",
              fingerprint,
              regions: {
                [sourceRegionId]: {
                  id: sourceRegionId,
                  sourceRole: "ornament",
                  box: [0.057, 0.557, 0.221, 0.649],
                  content: { diplomatic: "D", modern: "R" },
                  assetRef: "asset:banckes-1552:37:p0037-r007",
                  fingerprint
                }
              }
            }
          }
        }
      }
    },
    taxonomy: {
      categories: {
        visual: { id: "visual", displayName: "Visual", capabilities: [], components: {} },
        "visual.ornament": {
          id: "visual.ornament",
          displayName: "Ornament",
          parentId: "visual",
          capabilities: ["visual-source"],
          components: {}
        },
        "visual.ornament.decorated-initial": { ...decoratedCategory, components: {} }
      },
      classes: {
        "banckes.chapter-opener": {
          id: "banckes.chapter-opener",
          displayName: "Chapter opener",
          priority: 20,
          components: {
            "core.typography": {
              fontWeight: 600,
              textAlign: "justify",
              textAlignLast: "start",
              textJustify: "inter-word",
              hyphens: "auto"
            }
          }
        }
      },
      labels: {
        reviewed: { id: "reviewed", displayName: "Reviewed", color: "#476a50" }
      }
    },
    components: {
      "core.pageAppearance": {
        mode: "solid",
        color: "#eee2c5",
        texture: { kind: "paper", strength: 0.25, scale: 1 }
      }
    },
    rules: emptyRules(),
    books: {
      "banckes-1552": {
        id: "banckes-1552",
        displayName: "A Little Herball",
        components: {},
        rules: {
          ...emptyRules(),
          categories: {
            "visual.ornament.decorated-initial": {
              components: {
                "render.decoratedInitial": {
                  representation: "auto",
                  representationByEdition: { diplomatic: "original", modern: "modern" }
                }
              }
            }
          }
        },
        pages: {
          "37": {
            page: 37,
            displayName: "Leaf 19 recto",
            components: {},
            rules: emptyRules(),
            regions: {
              [sourceRegionId]: {
                id: sourceRegionId,
                sourceRef: {
                  bookId: "banckes-1552",
                  page: 37,
                  regionId: sourceRegionId,
                  fingerprint
                },
                origin: "source",
                annotations: {
                  displayName: "Decorated D opening Dragantia",
                  categoryId: decoratedCategory.id,
                  classIds: ["banckes.chapter-opener"],
                  labelIds: ["reviewed"]
                },
                components: {
                  "render.decoratedInitial": {
                    representation: "original",
                    fallback: "modern",
                    equivalents: {
                      diplomatic: { text: "D", continuationRegionId: "p0037-r008" },
                      modern: { text: "R", continuationRegionId: "p0037-r008", consumePrefix: "R" }
                    },
                    original: {
                      assetRef: "asset:banckes-1552:37:p0037-r007",
                      fit: "contain",
                      alignX: 0.5,
                      alignY: 0.5,
                      opacity: 0.96,
                      blendMode: "multiply"
                    },
                    text: { placement: "drop-cap", dropLines: 2, scale: 1, align: "start" },
                    accessibility: { decorative: false, description: "Decorated initial D" }
                  }
                }
              }
            }
          }
        }
      }
    },
    collections: {
      "review.decorated-initials": {
        id: "review.decorated-initials",
        displayName: "Decorated initials to review",
        regionIds: [objectRegionId]
      }
    },
    workspace: { components: {}, rules: emptyRules(), books: {} },
    extensions: {},
    publicationProfiles: {
      default: { id: "default", displayName: "Default publication", edition: "modern", strict: true }
    }
  };
}

function representativeReaderPublication() {
  return {
    schema: "whl-reader-publication/1",
    schemaVersion: 1,
    projectId: "living-herbal",
    revision: 7,
    activeEdition: "modern",
    contentHash: "sha256:" + "a".repeat(64),
    sourceFingerprints: {
      "book:banckes-1552": fingerprint,
      "page:banckes-1552:37": fingerprint,
      "region:banckes-1552:37:p0037-r007": fingerprint
    },
    taxonomy: {
      categories: {
        "visual.ornament.decorated-initial": {
          id: "visual.ornament.decorated-initial",
          displayName: "Decorated initial",
          capabilities: ["visual-source", "text-equivalent", "decorated-initial"]
        }
      }
    },
    books: {
      "banckes-1552": {
        id: "banckes-1552",
        displayName: "A Little Herball",
        pages: {
          "37": {
            page: 37,
            displayName: "Leaf 19 recto",
            components: {
              "core.pageAppearance": {
                mode: "solid",
                color: "#eee2c5",
                texture: { kind: "paper", strength: 0.25, scale: 1 }
              }
            },
            regions: [{
              id: objectRegionId,
              sourceRef: { bookId: "banckes-1552", page: 37, regionId: sourceRegionId, fingerprint },
              sourceRole: "ornament",
              annotations: {
                displayName: "Decorated D opening Dragantia",
                categoryId: "visual.ornament.decorated-initial"
              },
              components: {
                "core.typography": { fontFamily: "edition", fontWeight: 600 },
                "render.decoratedInitial": { representation: "original" }
              },
              renderer: {
                rendererId: "decorated-initial",
                kind: "decorated-initial",
                representation: "original",
                assetRef: "asset:banckes-1552:37:p0037-r007"
              },
              diagnostics: []
            }]
          }
        }
      }
    },
    diagnostics: [],
    extensions: {}
  };
}

test("v2 schemas use stable canonical identities and only local references", () => {
  assert.equal(editorSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(readerSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(editorSchema.properties.schema.const, "whl-facsimile-project/2");
  assert.equal(readerSchema.properties.schema.const, "whl-reader-publication/1");
  assert.equal(readerSchema.properties.contentHash.pattern, "^sha256:[0-9a-f]{64}$");
  for (const schema of [editorSchema, readerSchema]) {
    const references = JSON.stringify(schema).match(/#\/$defs\/[A-Za-z0-9._-]+/g) || [];
    references.forEach((reference) => assert.doesNotThrow(() => schemaTarget(schema, reference)));
  }
});

test("editor schema accepts canonical taxonomy, rules, labels, classes, and decorated-initial settings", () => {
  const normalized = normalizeProject(representativeEditorProject(), createDefaultComponentRegistry());
  assertValid(editorSchema, normalized);
});

test("editor schema rejects unsafe identities, duplicate assignments, and invalid component values", () => {
  const unsafe = representativeEditorProject();
  unsafe.taxonomy.labels = JSON.parse('{"__proto__":{"id":"unsafe","displayName":"Unsafe"}}');
  assertInvalid(editorSchema, unsafe, "unsafe definition keys must fail");

  const duplicateClass = representativeEditorProject();
  duplicateClass.books["banckes-1552"].pages["37"].regions[objectRegionId].annotations.classIds.push("banckes.chapter-opener");
  assertInvalid(editorSchema, duplicateClass, "class assignment is an ordered set");

  const badCapital = representativeEditorProject();
  badCapital.books["banckes-1552"].pages["37"].regions[objectRegionId]
    .components["render.decoratedInitial"].original.opacity = 1.2;
  assertInvalid(editorSchema, badCapital, "decorated-initial opacity must remain normalized");

  const badTypography = representativeEditorProject();
  badTypography.taxonomy.classes["banckes.chapter-opener"].components["core.typography"].fontWeight = 950;
  assertInvalid(editorSchema, badTypography, "known component patches use registry ranges");

  const badJustification = representativeEditorProject();
  badJustification.taxonomy.classes["banckes.chapter-opener"].components["core.typography"].textAlign = "spread";
  assertInvalid(editorSchema, badJustification, "typography alignment is a closed vocabulary");

  const badTexture = representativeEditorProject();
  badTexture.components["core.pageAppearance"].texture.strength = 1.5;
  assertInvalid(editorSchema, badTexture, "procedural texture strength remains normalized");

  const pageAppearanceOnRegion = representativeEditorProject();
  pageAppearanceOnRegion.books["banckes-1552"].pages["37"].regions[objectRegionId]
    .components["core.pageAppearance"] = { mode: "solid" };
  assertInvalid(editorSchema, pageAppearanceOnRegion, "page presentation cannot be authored on a region");

  const orphanedPrefix = representativeEditorProject();
  orphanedPrefix.books["banckes-1552"].pages["37"].regions[objectRegionId]
    .components["render.decoratedInitial"].equivalents.modern = { text: "R", consumePrefix: "R" };
  assertInvalid(editorSchema, orphanedPrefix, "prefix consumption requires an explicit continuation");
});

test("editor schema keeps transient context, history, credentials, and arbitrary root fields out of projects", () => {
  for (const forbidden of ["context", "history", "credentials", "windowLayout"]) {
    const project = representativeEditorProject();
    project[forbidden] = {};
    assertInvalid(editorSchema, project, `${forbidden} must not enter an authoring project`);
  }
});

test("reader schema accepts a compiled reader-safe projection", () => {
  assertValid(readerSchema, representativeReaderPublication());

  const project = representativeEditorProject();
  const equivalents = project.books["banckes-1552"].pages["37"].regions[objectRegionId]
    .components["render.decoratedInitial"].equivalents;
  delete equivalents.modern.continuationRegionId;
  delete equivalents.modern.consumePrefix;
  delete equivalents.diplomatic.continuationRegionId;
  const compiled = createFacsimileEngine({ project }).compilePublication({ activeEdition: "modern" });
  assertValid(readerSchema, compiled);
});

test("reader schema rejects authoring state, private classification, and malformed integrity data", () => {
  const editorState = representativeReaderPublication();
  editorState.workspace = {};
  assertInvalid(readerSchema, editorState, "workspace overlays must not publish");

  const privateAnnotations = representativeReaderPublication();
  privateAnnotations.books["banckes-1552"].pages["37"].regions[0].annotations.labelIds = ["reviewed"];
  assertInvalid(readerSchema, privateAnnotations, "authoring labels must not publish");

  const badHash = representativeReaderPublication();
  badHash.contentHash = "fnv1a64:0123456789abcdef";
  assertInvalid(readerSchema, badHash, "publication integrity requires SHA-256");

  const badRole = representativeReaderPublication();
  badRole.books["banckes-1552"].pages["37"].regions[0].sourceRole = "Decorated Initial";
  assertInvalid(readerSchema, badRole, "source roles remain safe source identifiers");

  const unsafePageAppearance = representativeReaderPublication();
  unsafePageAppearance.books["banckes-1552"].pages["37"]
    .components["core.pageAppearance"].color = "url(https://example.invalid/paper.png)";
  assertInvalid(readerSchema, unsafePageAppearance, "page appearance cannot carry arbitrary CSS or URLs");

  const pageAppearanceOnRegion = representativeReaderPublication();
  pageAppearanceOnRegion.books["banckes-1552"].pages["37"].regions[0]
    .components["core.pageAppearance"] = { mode: "solid", color: "#eee2c5" };
  assertInvalid(readerSchema, pageAppearanceOnRegion, "page components serialize only once on the page");

  const regionComponentOnPage = representativeReaderPublication();
  regionComponentOnPage.books["banckes-1552"].pages["37"]
    .components["core.typography"] = { fontSize: 1.2 };
  assertInvalid(readerSchema, regionComponentOnPage, "resolved region components serialize only on regions");

  const unresolvedAppearance = representativeReaderPublication();
  unresolvedAppearance.books["banckes-1552"].pages["37"]
    .components["core.pageAppearance"] = { mode: "solid" };
  assertInvalid(readerSchema, unresolvedAppearance, "reader page appearance is a fully resolved component");
});
