import assert from "node:assert/strict";
import test from "node:test";

import {
  DECORATED_INITIAL_COMPONENT,
  PROJECT_SCHEMA,
  PROJECT_SCHEMA_VERSION,
  PublicationValidationError,
  RegistryError,
  RendererRegistry,
  UnsupportedExtensionError,
  activateRegion,
  createContext,
  createDefaultComponentRegistry,
  createFacsimileEngine,
  evaluateRegion,
  migrateRegionSettingsV1,
  normalizeProject,
  provenanceFor,
  sha256Hex
} from "../../packages/facsimile-engine/index.js";

function rules() {
  return { sourceRoles: {}, categories: {}, classes: {} };
}

function fixture() {
  const sourceRegions = {
    r1: { id: "r1", sourceRole: "body", box: [0.1, 0.1, 0.4, 0.5], content: { modern: "Rose", diplomatic: "Roſe" }, assetRef: "asset:r1", fingerprint: "sha256:r1" },
    r2: { id: "r2", sourceRole: "body", box: [0.4, 0.1, 0.8, 0.5], content: { modern: "Root", diplomatic: "Root" }, assetRef: "asset:r2", fingerprint: "sha256:r2" }
  };
  const regions = Object.fromEntries(Object.keys(sourceRegions).map((id) => [id, {
    id,
    sourceRef: { bookId: "book", page: 1, regionId: id, fingerprint: `sha256:${id}` },
    origin: "source",
    annotations: {
      displayName: id === "r1" ? "Opening initial" : "Continuation",
      ...(id === "r1" ? { categoryId: "visual.ornament.decorated-initial" } : {}),
      classIds: id === "r1" ? ["class.high", "class.low"] : [],
      labelIds: []
    },
    components: id === "r1" ? {
      [DECORATED_INITIAL_COMPONENT]: {
        fallback: "modern",
        equivalents: {
          modern: { text: "R", continuationRegionId: "r2", consumePrefix: "R" },
          diplomatic: { text: "R" }
        },
        original: { assetRef: "asset:r1" }
      }
    } : {}
  }]));
  return {
    schema: PROJECT_SCHEMA,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: "project",
    displayName: "Test herbal",
    revision: 0,
    requiredExtensions: ["whl.core", "whl.decorated-initial"],
    optionalExtensions: { "vendor.optional": { version: "1", data: { retained: true } } },
    sourceLibrary: {
      books: {
        book: {
          id: "book",
          displayName: "Book",
          fingerprint: "sha256:book",
          pages: { "1": { page: 1, fingerprint: "sha256:page", regions: sourceRegions } }
        }
      }
    },
    taxonomy: {
      categories: {
        visual: { id: "visual", displayName: "Visual", capabilities: ["visual-source"] },
        "visual.ornament": { id: "visual.ornament", displayName: "Ornament", parentId: "visual", capabilities: [] },
        "visual.ornament.decorated-initial": {
          id: "visual.ornament.decorated-initial",
          displayName: "Decorated initial",
          parentId: "visual.ornament",
          capabilities: ["text-equivalent", "decorated-initial"]
        }
      },
      classes: {
        "class.high": { id: "class.high", displayName: "High", priority: 20, components: { "core.typography": { fontWeight: 700 } } },
        "class.low": { id: "class.low", displayName: "Low", priority: 10, components: { "core.typography": { fontWeight: 400 } } }
      },
      labels: {
        reviewed: { id: "reviewed", displayName: "Reviewed" }
      }
    },
    components: { "core.typography": { fontSize: 1 } },
    rules: rules(),
    books: {
      book: {
        id: "book",
        displayName: "Book",
        components: { "core.typography": { color: "#333333" } },
        rules: {
          ...rules(),
          sourceRoles: { body: { components: { "core.typography": { lineHeight: 1.2 } } } },
          categories: {
            "visual.ornament.decorated-initial": {
              components: {
                "core.typography": { fontSize: 1.4 },
                [DECORATED_INITIAL_COMPONENT]: { representation: "original" }
              }
            }
          }
        },
        pages: {
          "1": {
            page: 1,
            displayName: "Page one",
            components: {},
            rules: {
              ...rules(),
              categories: {
                "visual.ornament.decorated-initial": {
                  components: { [DECORATED_INITIAL_COMPONENT]: { representation: "modern" } }
                }
              }
            },
            regions
          }
        }
      }
    },
    collections: { review: { id: "review", displayName: "Review", regionIds: [] } },
    workspace: {
      components: {},
      rules: rules(),
      books: {
        book: {
          components: { "core.typography": { fontSize: 1.1 } },
          rules: rules(),
          pages: {
            "1": {
              components: {}, rules: rules(),
              regions: { r1: { components: { "core.typography": { color: "#663322" } } } }
            }
          }
        }
      }
    },
    extensions: { "vendor.optional": { opaque: [1, 2, 3] } },
    publicationProfiles: {}
  };
}

function context(selectedRegionIds = ["r1"], activeRegionId = "r1") {
  return createContext({
    projectId: "project", workspaceId: "classification", mode: "OBJECT", area: "viewport",
    bookId: "book", page: 1, activeRegionId, selectedRegionIds,
    activeScope: { kind: "region", regionId: activeRegionId }, activeEdition: "modern",
    activeToolId: "select", previewIntent: "editor"
  });
}

test("project validation rejects category cycles and unsafe references", () => {
  const value = fixture();
  value.taxonomy.categories.visual.parentId = "visual.ornament.decorated-initial";
  assert.throws(() => normalizeProject(value, createDefaultComponentRegistry()), /cycle/);
});

test("context is immutable and right-click activation preserves intentional selection", () => {
  const initial = context(["r1", "r2"], "r1");
  const active = activateRegion(initial, "r2");
  assert.deepEqual(active.selectedRegionIds, ["r1", "r2"]);
  assert.equal(active.activeRegionId, "r2");
  assert.ok(Object.isFrozen(active));
  const exclusive = activateRegion(initial, "r3");
  assert.deepEqual(exclusive.selectedRegionIds, ["r3"]);
});

test("cascade is deterministic across class priority, specificity, layers, and provenance", () => {
  const components = createDefaultComponentRegistry();
  const project = normalizeProject(fixture(), components);
  const region = evaluateRegion(project, components, "book", 1, "r1");
  assert.equal(region.components["core.typography"].fontSize, 1.4, "published category outranks local book default");
  assert.equal(region.components["core.typography"].fontWeight, 700, "higher-priority class applies last");
  assert.equal(region.components["core.typography"].color, "#663322");
  assert.equal(region.components[DECORATED_INITIAL_COMPONENT].representation, "modern", "page category outranks book category");
  assert.deepEqual(region.categoryAncestry, ["visual", "visual.ornament", "visual.ornament.decorated-initial"]);
  assert.equal(provenanceFor(region, "core.typography", "fontSize").scope, "bookCategory");
  assert.equal(provenanceFor(region, "core.typography", "color").layer, "workspace");
});

test("taxonomy/classification operators are atomic, scriptable, and undoable", () => {
  const engine = createFacsimileEngine({ project: fixture() });
  const selected = context(["r1", "r2"], "r1");
  engine.operators.execute("taxonomy.createLabel", selected, { id: "needs-review", displayName: "Needs review" });
  engine.operators.execute("region.addLabel", selected, { labelId: "needs-review" });
  assert.deepEqual(engine.evaluateRegion("book", 1, "r1").labelIds, ["needs-review"]);
  assert.deepEqual(engine.evaluateRegion("book", 1, "r2").labelIds, ["needs-review"]);
  assert.equal(engine.operationLog().at(-1).operatorId, "region.addLabel");
  assert.equal(engine.history.snapshot().undoLabel, "region.addLabel");
  engine.history.undo();
  assert.deepEqual(engine.evaluateRegion("book", 1, "r1").labelIds, []);
  engine.history.redo();
  assert.deepEqual(engine.evaluateRegion("book", 1, "r2").labelIds, ["needs-review"]);
});

test("modal transforms preview, cancel, and commit as one changeset", () => {
  const engine = createFacsimileEngine({ project: fixture() });
  engine.modal.begin("region.transform", context());
  engine.modal.preview({ transform: { translateX: 0.1 } });
  engine.modal.preview({ transform: { translateX: 0.2 } });
  assert.equal(engine.evaluateRegion("book", 1, "r1").components["core.transform"].translateX, 0.2);
  engine.modal.cancel();
  assert.equal(engine.evaluateRegion("book", 1, "r1").components["core.transform"].translateX, undefined);
  engine.modal.begin("region.transform", context());
  engine.modal.preview({ transform: { translateX: 0.25 } });
  engine.modal.confirm();
  assert.equal(engine.operationLog().length, 1);
  assert.equal(engine.evaluateRegion("book", 1, "r1").components["core.transform"].translateX, 0.25);
});

test("v1 migration preserves sparse typography, layout, geometry, and content", () => {
  const migrated = migrateRegionSettingsV1({
    schema: "whl-region-settings/1", schemaVersion: 1, projectId: "project",
    overrides: {
      book: {
        book: { style: { fontSize: 1.25 } },
        regionTypes: { body: { fit: { wrap: "nowrap" } } },
        pages: { "1": { regions: { r1: { geometry: { scaleX: 1.3 }, text: { modern: "Modern rose" } } } } }
      }
    }
  }, fixture());
  const components = createDefaultComponentRegistry();
  const region = evaluateRegion(normalizeProject(migrated, components), components, "book", 1, "r1");
  assert.equal(region.components["core.typography"].fontSize, 1.4, "more-specific published category remains authoritative");
  assert.equal(region.components["core.textLayout"].wrap, "nowrap");
  assert.equal(region.components["core.transform"].scaleX, 1.3);
  assert.equal(region.components["core.content"].modern, "Modern rose");
});

test("decorated-initial settings cascade by book/page/region and compile reader-only output", () => {
  const engine = createFacsimileEngine({ project: fixture() });
  let publication = engine.compilePublication({ activeEdition: "modern" });
  let rendered = publication.books.book.pages["1"].regions.find(({ id }) => id === "r1").renderer;
  assert.equal(rendered.representation, "modern");
  assert.equal(rendered.text, "R");
  assert.equal(rendered.accessibilityText, "R");
  assert.equal(rendered.prefixConsumed, true);
  assert.equal(rendered.continuationEdition, "modern");
  const continuation = publication.books.book.pages["1"].regions.find(({ id }) => id === "r2");
  assert.equal(continuation.components["core.content"].modern, "oot");
  assert.equal(rendered.accessibilityText + continuation.components["core.content"].modern, "Root");
  assert.match(publication.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(publication.sourceFingerprints["region:book:1:r1"], "sha256:r1");
  assert.equal("workspace" in publication, false);
  assert.equal(JSON.stringify(publication).includes("needs-review"), false);

  engine.operators.execute("render.setRepresentation", context(), { representation: "original" });
  publication = engine.compilePublication({ activeEdition: "modern" });
  rendered = publication.books.book.pages["1"].regions.find(({ id }) => id === "r1").renderer;
  assert.equal(rendered.representation, "original");
  assert.equal(rendered.assetRef, "asset:r1");
  assert.equal(rendered.accessibilityText, "R");
});

test("publication rejects unknown required extensions and source drift", () => {
  const unsupported = fixture();
  unsupported.requiredExtensions.push("vendor.required");
  assert.throws(() => createFacsimileEngine({ project: unsupported }).compilePublication(), UnsupportedExtensionError);
  const drift = fixture();
  drift.sourceLibrary.books.book.pages["1"].regions.r1.fingerprint = "sha256:changed";
  assert.throws(() => createFacsimileEngine({ project: drift }).compilePublication(), PublicationValidationError);

  const missingReferenceFingerprint = fixture();
  delete missingReferenceFingerprint.books.book.pages["1"].regions.r1.sourceRef.fingerprint;
  assert.throws(
    () => createFacsimileEngine({ project: missingReferenceFingerprint }).compilePublication(),
    (error) => error instanceof PublicationValidationError
      && error.details.diagnostics.some(({ code }) => code === "SOURCE_FINGERPRINT_MISSING")
  );

  const missingSourceFingerprint = fixture();
  delete missingSourceFingerprint.sourceLibrary.books.book.pages["1"].regions.r1.fingerprint;
  assert.throws(
    () => createFacsimileEngine({ project: missingSourceFingerprint }).compilePublication(),
    (error) => error instanceof PublicationValidationError
      && error.details.diagnostics.some(({ code }) => code === "SOURCE_FINGERPRINT_UNAVAILABLE")
  );
});

test("reader component and renderer publication are deny-by-default", () => {
  const components = createDefaultComponentRegistry();
  assert.throws(() => components.register({
    id: "vendor.unsafe-reader-component",
    version: 1,
    extensionId: "vendor.optional",
    readerSafe: true,
    defaults: {},
    validate: (value) => value
  }), RegistryError);

  components.register({
    id: "vendor.editor-secret",
    version: 1,
    extensionId: "vendor.optional",
    defaults: {},
    validate: (value) => value
  });
  const withEditorSecret = fixture();
  withEditorSecret.components["vendor.editor-secret"] = { token: "must-not-publish" };
  const safeProjection = createFacsimileEngine({ project: withEditorSecret, components }).compilePublication();
  assert.equal(JSON.stringify(safeProjection).includes("must-not-publish"), false);
  assert.equal(safeProjection.books.book.pages["1"].regions[0].components["vendor.editor-secret"], undefined);

  const renderers = new RendererRegistry().register({
    id: "vendor.editor-renderer",
    version: 1,
    extensionId: "vendor.optional",
    poll: () => true,
    evaluate: () => ({ rendererId: "spoofed", secret: "renderer-secret" })
  });
  const withEditorRenderer = fixture();
  const rendererProjection = createFacsimileEngine({ project: withEditorRenderer, renderers }).compilePublication();
  const opening = rendererProjection.books.book.pages["1"].regions.find(({ id }) => id === "r1");
  assert.equal(opening.renderer, undefined);
  assert.equal(JSON.stringify(rendererProjection).includes("renderer-secret"), false);
  assert.ok(opening.diagnostics.some(({ code }) => code === "RENDERER_EDITOR_ONLY"));
});

test("decorated-initial continuation graph rejects dangling and cyclic relationships", () => {
  const dangling = fixture();
  dangling.books.book.pages["1"].regions.r1.components[DECORATED_INITIAL_COMPONENT]
    .equivalents.modern.continuationRegionId = "missing";
  assert.throws(
    () => createFacsimileEngine({ project: dangling }).compilePublication(),
    (error) => error instanceof PublicationValidationError
      && error.details.diagnostics.some(({ code }) => code === "DECORATED_INITIAL_CONTINUATION_MISSING")
  );

  const cyclic = fixture();
  cyclic.books.book.pages["1"].regions.r2.annotations.categoryId = "visual.ornament.decorated-initial";
  cyclic.books.book.pages["1"].regions.r2.components[DECORATED_INITIAL_COMPONENT] = {
    representation: "modern",
    equivalents: { modern: { text: "R", continuationRegionId: "r1" } }
  };
  assert.throws(
    () => createFacsimileEngine({ project: cyclic }).compilePublication(),
    (error) => error instanceof PublicationValidationError
      && error.details.diagnostics.some(({ code }) => code === "DECORATED_INITIAL_CONTINUATION_CYCLE")
  );
});

test("SHA-256 helper matches the standard vector and publication is byte-deterministic", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const first = createFacsimileEngine({ project: fixture() }).compilePublication();
  const second = createFacsimileEngine({ project: fixture() }).compilePublication();
  assert.deepEqual(first, second);
});
