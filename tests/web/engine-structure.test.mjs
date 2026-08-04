import assert from "node:assert/strict";
import test from "node:test";

import {
  createContext,
  createDefaultComponentRegistry,
  createFacsimileEngine,
  evaluateRegion,
  migrateRegionSettingsV1,
  normalizeProject,
  provenanceFor
} from "../../packages/facsimile-engine/index.js";

const OBJECT_ONE = "region:b:1:r1";
const OBJECT_TWO = "region:b:2:r2";
const SOURCE_ONE = "source-r1";
const SOURCE_TWO = "source-r2";

function emptyRules() {
  return { sourceRoles: {}, categories: {}, classes: {} };
}

function sourceRegion(id, text, fingerprint) {
  return {
    id,
    sourceRole: "body",
    box: [0.1, 0.1, 0.9, 0.9],
    content: { modern: text, diplomatic: text },
    fingerprint
  };
}

function objectRegion(id, sourceId, page, categoryId = "text.body") {
  return {
    id,
    sourceRef: { bookId: "b", page, regionId: sourceId, fingerprint: `sha256:${sourceId}` },
    origin: "source",
    annotations: {
      displayName: `Object ${id}`,
      categoryId,
      classIds: ["emphasis"],
      labelIds: []
    },
    components: {}
  };
}

function projectFixture() {
  return {
    schema: "whl-facsimile-project/2",
    schemaVersion: 2,
    projectId: "structure-test",
    displayName: "Structure test",
    revision: 0,
    requiredExtensions: ["whl.core", "whl.decorated-initial"],
    optionalExtensions: {},
    sourceLibrary: {
      books: {
        b: {
          id: "b",
          fingerprint: "sha256:book",
          pages: {
            "1": { page: 1, regions: { [SOURCE_ONE]: sourceRegion(SOURCE_ONE, "Rose", `sha256:${SOURCE_ONE}`) } },
            "2": { page: 2, regions: { [SOURCE_TWO]: sourceRegion(SOURCE_TWO, "Root", `sha256:${SOURCE_TWO}`) } }
          }
        }
      }
    },
    taxonomy: {
      categories: {
        text: { id: "text", displayName: "Text", capabilities: [], components: {} },
        "text.body": { id: "text.body", displayName: "Body", parentId: "text", capabilities: [], components: {} },
        visual: { id: "visual", displayName: "Visual", capabilities: [], components: {} },
        "visual.decorated": {
          id: "visual.decorated",
          displayName: "Decorated initial",
          parentId: "visual",
          capabilities: ["decorated-initial"],
          components: {}
        }
      },
      classes: {
        emphasis: {
          id: "emphasis",
          displayName: "Emphasis",
          priority: 10,
          components: {}
        }
      },
      labels: {
        reviewed: { id: "reviewed", displayName: "Reviewed" }
      }
    },
    components: {},
    rules: {
      sourceRoles: { body: { components: { "core.typography": { lineHeight: 1.3 } } } },
      categories: { "text.body": { components: { "core.typography": { fontSize: 1.25, color: "#222222" } } } },
      classes: { emphasis: { components: { "core.typography": { fontWeight: 600 } } } }
    },
    books: {
      b: {
        id: "b",
        components: { "core.typography": { color: "#444444" } },
        rules: emptyRules(),
        pages: {
          "1": { page: 1, components: {}, rules: emptyRules(), regions: { [OBJECT_ONE]: objectRegion(OBJECT_ONE, SOURCE_ONE, 1) } },
          "2": { page: 2, components: {}, rules: emptyRules(), regions: { [OBJECT_TWO]: objectRegion(OBJECT_TWO, SOURCE_TWO, 2) } }
        }
      }
    },
    collections: {
      review: { id: "review", displayName: "Review", regionIds: [OBJECT_ONE] }
    },
    workspace: {
      components: {},
      rules: {
        ...emptyRules(),
        categories: { "text.body": { components: { "core.typography": { fontSize: 1.35 } } } }
      },
      books: {}
    },
    extensions: {},
    publicationProfiles: {}
  };
}

function editorContext() {
  return createContext({
    projectId: "structure-test",
    workspaceId: "layout",
    mode: "OBJECT",
    area: "viewport",
    bookId: "b",
    page: 1,
    activeRegionId: OBJECT_ONE,
    selectedRegionIds: [OBJECT_ONE],
    activeScope: { kind: "region", regionId: OBJECT_ONE },
    activeEdition: "modern",
    activeToolId: "select",
    previewIntent: "editor"
  });
}

test("region object identity is independent from its immutable source-region identity", () => {
  const engine = createFacsimileEngine({ project: projectFixture() });
  const evaluated = engine.evaluateRegion("b", 1, OBJECT_ONE);
  assert.equal(evaluated.id, OBJECT_ONE);
  assert.equal(evaluated.sourceRef.regionId, SOURCE_ONE);
  assert.equal(evaluated.sourceRegion.id, SOURCE_ONE);
  assert.equal(evaluated.components["core.content"].modern, "Rose");
  assert.equal(engine.evaluateRegion("b", "01", OBJECT_ONE).page, 1);

  const wrongPage = projectFixture();
  wrongPage.books.b.pages["1"].regions[OBJECT_ONE].sourceRef.page = 2;
  assert.throws(() => createFacsimileEngine({ project: wrongPage }), /must address this region object's book and page/);

  const missingSource = projectFixture();
  missingSource.books.b.pages["1"].regions[OBJECT_ONE].sourceRef.regionId = "source-missing";
  assert.throws(() => createFacsimileEngine({ project: missingSource }), /referenced source region is missing/);
});

test("region object IDs are project-global and collections resolve deterministically", () => {
  const duplicate = projectFixture();
  duplicate.books.b.pages["2"].regions[OBJECT_ONE] = {
    ...duplicate.books.b.pages["2"].regions[OBJECT_TWO],
    id: OBJECT_ONE
  };
  delete duplicate.books.b.pages["2"].regions[OBJECT_TWO];
  assert.throws(() => createFacsimileEngine({ project: duplicate }), /region object ID is already used/);

  const unknownCollectionMember = projectFixture();
  unknownCollectionMember.collections.review.regionIds.push("region:unknown");
  assert.throws(() => createFacsimileEngine({ project: unknownCollectionMember }), /references unknown region object/);
});

test("project selector rules resolve before book scopes with field provenance", () => {
  const engine = createFacsimileEngine({ project: projectFixture() });
  const evaluated = engine.evaluateRegion("b", 1, OBJECT_ONE);
  const typography = evaluated.components["core.typography"];
  assert.equal(typography.lineHeight, 1.3);
  assert.equal(typography.fontSize, 1.35);
  assert.equal(typography.fontWeight, 600);
  assert.equal(typography.color, "#444444", "book defaults remain more specific than project category rules");
  assert.equal(provenanceFor(evaluated, "core.typography", "lineHeight").scope, "projectSourceRole");
  assert.equal(provenanceFor(evaluated, "core.typography", "fontSize").layer, "workspace");
  assert.equal(provenanceFor(evaluated, "core.typography", "fontWeight").scope, "projectClass");
  assert.equal(provenanceFor(evaluated, "core.typography", "color").scope, "book");
});

test("a parent tombstone restores both inherited values and descendant provenance", () => {
  const value = projectFixture();
  value.books.b.pages["1"].regions[OBJECT_ONE].annotations.categoryId = "visual.decorated";
  value.books.b.rules.categories["visual.decorated"] = {
    components: { "render.decoratedInitial": { original: { fit: "cover", alignX: 0.25 } } }
  };
  value.books.b.pages["1"].rules.categories["visual.decorated"] = {
    components: { "render.decoratedInitial": { original: { fit: "contain", alignX: 0.5 } } }
  };
  value.workspace.books.b = {
    components: {}, rules: emptyRules(), pages: {
      "1": {
        components: {},
        rules: {
          ...emptyRules(),
          categories: { "visual.decorated": { components: { "render.decoratedInitial": { original: null } } } }
        },
        regions: {}
      }
    }
  };
  const components = createDefaultComponentRegistry();
  const evaluated = evaluateRegion(normalizeProject(value, components), components, "b", 1, OBJECT_ONE);
  assert.equal(evaluated.components["render.decoratedInitial"].original.fit, "cover");
  assert.equal(evaluated.components["render.decoratedInitial"].original.alignX, 0.25);
  assert.equal(provenanceFor(evaluated, "render.decoratedInitial", "original.fit").scope, "bookCategory");
  assert.equal(provenanceFor(evaluated, "render.decoratedInitial", "original.alignX").scope, "bookCategory");
});

test("v1 migration deep-merges components and preserves existing region metadata", () => {
  const target = projectFixture();
  target.workspace.books.b = {
    components: { "core.typography": { color: "#123456", lineHeight: 1.1 } },
    rules: {
      ...emptyRules(),
      sourceRoles: { body: { components: { "core.typography": { letterSpacing: 0.02 } } } }
    },
    pages: {
      "1": {
        components: { "core.textLayout": { overflow: "visible" } },
        rules: emptyRules(),
        regions: {
          [OBJECT_ONE]: {
            annotations: { displayName: "Preserved name", labelIds: ["reviewed"] },
            components: {
              "core.typography": { fontWeight: 700 },
              "core.visibility": { modern: false }
            }
          }
        }
      }
    }
  };
  const migrated = migrateRegionSettingsV1({
    schema: "whl-region-settings/1",
    schemaVersion: 1,
    projectId: "structure-test",
    overrides: {
      b: {
        book: { style: { fontSize: 1.5 } },
        regionTypes: { body: { style: { color: "#654321" } } },
        pages: {
          "1": {
            fit: { wrap: "nowrap" },
            regions: { [OBJECT_ONE]: { geometry: { scaleX: 1.4 }, text: { modern: "Migrated rose" } } }
          }
        }
      }
    }
  }, target);
  const overlay = migrated.workspace.books.b.pages["1"].regions[OBJECT_ONE];
  assert.deepEqual(overlay.annotations, { displayName: "Preserved name", labelIds: ["reviewed"] });
  assert.equal(overlay.components["core.typography"].fontWeight, 700);
  assert.equal(overlay.components["core.visibility"].modern, false);
  assert.equal(overlay.components["core.transform"].scaleX, 1.4);
  assert.equal(migrated.workspace.books.b.components["core.typography"].color, "#123456");
  assert.equal(migrated.workspace.books.b.components["core.typography"].fontSize, 1.5);
  assert.equal(migrated.workspace.books.b.rules.sourceRoles.body.components["core.typography"].letterSpacing, 0.02);
  assert.equal(migrated.workspace.books.b.rules.sourceRoles.body.components["core.typography"].color, "#654321");
  assert.equal(migrated.workspace.books.b.pages["1"].components["core.textLayout"].overflow, "visible");
  assert.equal(migrated.workspace.books.b.pages["1"].components["core.textLayout"].wrap, "nowrap");

  const engine = createFacsimileEngine({ project: migrated });
  assert.equal(engine.evaluateRegion("b", 1, OBJECT_ONE).components["core.content"].modern, "Migrated rose");
});

test("authored region creation requires an explicit fingerprint and global object ID", () => {
  const engine = createFacsimileEngine({ project: projectFixture() });
  assert.throws(
    () => engine.operators.execute("region.create", editorContext(), { id: "region:b:1:new" }),
    /arguments\.fingerprint/
  );
  engine.operators.execute("region.create", editorContext(), {
    id: "region:b:1:new",
    sourceRegionId: "authored:new",
    fingerprint: "sha256:authored-new",
    annotations: { displayName: "Authored note", categoryId: "text.body", classIds: [], labelIds: [] },
    components: {
      "core.transform": { box: [0.2, 0.2, 0.4, 0.4] },
      "core.content": { modern: "Authored note", diplomatic: "Authored note" }
    }
  });
  const created = engine.project.books.b.pages["1"].regions["region:b:1:new"];
  assert.equal(created.sourceRef.regionId, "authored:new");
  assert.equal(created.sourceRef.fingerprint, "sha256:authored-new");
  assert.equal(engine.evaluateRegion("b", 1, "region:b:1:new").components["core.content"].modern, "Authored note");
  assert.throws(
    () => engine.operators.execute("region.create", editorContext(), {
      id: OBJECT_TWO,
      fingerprint: "sha256:duplicate"
    }),
    /already exists in this project/
  );
});
