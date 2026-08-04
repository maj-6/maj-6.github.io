import {
  CORE_EXTENSION,
  DECORATED_INITIAL_CATEGORY,
  DECORATED_INITIAL_COMPONENT,
  DECORATED_INITIAL_EXTENSION,
  PROJECT_SCHEMA,
  PROJECT_SCHEMA_VERSION
} from "@whl/facsimile-engine";

export const CATEGORY_ORDER = [
  "text.body",
  "text.header",
  "text.caption",
  DECORATED_INITIAL_CATEGORY,
  "visual.ornament"
];

export const CLASS_ORDER = [
  "layout.wide-header",
  "typography.small-caps",
  "decoration.ornate-initial"
];

function emptyRules() {
  return { sourceRoles: {}, categories: {}, classes: {} };
}

function sourceRegion(id, sourceRole, box, modern, diplomatic = modern, options = {}) {
  return {
    id,
    sourceRole,
    box,
    content: { modern, diplomatic },
    ...(options.assetRef ? { assetRef: options.assetRef } : {}),
    fingerprint: `sha256:${id}`
  };
}

function authoredRegion(bookId, page, source, annotations, typography, components = {}) {
  return {
    id: source.id,
    sourceRef: {
      bookId,
      page,
      regionId: source.id,
      fingerprint: source.fingerprint
    },
    origin: "source",
    annotations,
    components: {
      "core.typography": typography,
      ...components
    }
  };
}

/**
 * Canonical v2 engine fixture used only by the desktop vertical slice. The
 * source pages are representative in-memory data, not live OCR or scan assets.
 */
export function createDemoProject() {
  const bookId = "fuchs-1542";
  const page236Sources = {
    "p0236-r001": sourceRegion(
      "p0236-r001", "header", [0.13, 0.08, 0.87, 0.16],
      "OF PEONY · CHAPTER CLXXV", "DE PAEONIA · CAPVT CLXXV"
    ),
    "p0236-r002": sourceRegion(
      "p0236-r002", "ornament", [0.12, 0.25, 0.25, 0.43], "P", "P",
      { assetRef: "asset:fuchs-1542:236:p0236-r002" }
    ),
    "p0236-r003": sourceRegion(
      "p0236-r003", "body", [0.25, 0.24, 0.87, 0.61],
      "Male and female peony are described by their broad leaves and remarkable flower.",
      "PAEONIA mas et foemina, foliis ampla atque insigni flore describitur."
    ),
    "p0236-r004": sourceRegion(
      "p0236-r004", "caption", [0.28, 0.78, 0.72, 0.86],
      "FEMALE PEONY", "PAEONIA FOEMINA."
    )
  };
  const page237Sources = {
    "p0237-r001": sourceRegion(
      "p0237-r001", "header", [0.16, 0.08, 0.84, 0.15],
      "HISTORY OF PLANTS", "PLANTARVM HISTORIA"
    ),
    "p0237-r002": sourceRegion(
      "p0237-r002", "body", [0.14, 0.22, 0.86, 0.51],
      "The root is thick and is prepared for several medicinal uses.",
      "Radix crassa est, et ad varios medicinae usus paratur."
    ),
    "p0237-r003": sourceRegion(
      "p0237-r003", "ornament", [0.36, 0.68, 0.64, 0.78], "❦", "❦"
    )
  };

  const labels = {
    "chapter-heading": { id: "chapter-heading", displayName: "chapter heading" },
    "opening-initial": { id: "opening-initial", displayName: "opening initial" },
    "reviewed-crop": { id: "reviewed-crop", displayName: "reviewed crop" },
    "plant-description": { id: "plant-description", displayName: "plant description" },
    "botanical-caption": { id: "botanical-caption", displayName: "botanical caption" },
    "running-header": { id: "running-header", displayName: "running header" },
    "continued-description": { id: "continued-description", displayName: "continued description" },
    "printer-ornament": { id: "printer-ornament", displayName: "printer ornament" },
    "needs-review": { id: "needs-review", displayName: "needs review", color: "#d99e42" },
    reviewed: { id: "reviewed", displayName: "reviewed", color: "#55a86c" },
    "decorated-initial": { id: "decorated-initial", displayName: "decorated initial" }
  };

  const page236Regions = {
    "p0236-r001": authoredRegion(bookId, 236, page236Sources["p0236-r001"], {
      displayName: "Peony chapter heading",
      categoryId: "text.header",
      classIds: ["layout.wide-header", "typography.small-caps"],
      labelIds: ["chapter-heading"]
    }, {
      fontFamily: "edition", fontSize: 1.04, fontWeight: 650,
      color: "#3f2d21", lineHeight: 1.05, letterSpacing: 0.04
    }),
    "p0236-r002": authoredRegion(bookId, 236, page236Sources["p0236-r002"], {
      displayName: "Decorated P opening",
      categoryId: DECORATED_INITIAL_CATEGORY,
      classIds: ["decoration.ornate-initial"],
      labelIds: ["opening-initial", "reviewed-crop"]
    }, {
      fontFamily: "edition", fontSize: 2.5, fontWeight: 700,
      color: "#6d342b", lineHeight: 0.9, letterSpacing: 0
    }, {
      [DECORATED_INITIAL_COMPONENT]: {
        fallback: "modern",
        equivalents: {
          modern: { text: "P" },
          diplomatic: { text: "P" }
        },
        original: {
          assetRef: "asset:fuchs-1542:236:p0236-r002",
          fit: "contain",
          blendMode: "multiply"
        }
      }
    }),
    "p0236-r003": authoredRegion(bookId, 236, page236Sources["p0236-r003"], {
      displayName: "Peony description",
      categoryId: "text.body",
      classIds: [],
      labelIds: ["plant-description"]
    }, {
      fontFamily: "edition", fontSize: 1, fontWeight: 430,
      color: "#45362b", lineHeight: 1.2, letterSpacing: 0.01
    }),
    "p0236-r004": authoredRegion(bookId, 236, page236Sources["p0236-r004"], {
      displayName: "Female peony caption",
      categoryId: "text.caption",
      classIds: [],
      labelIds: ["botanical-caption"]
    }, {
      fontFamily: "edition", fontSize: 0.9, fontWeight: 550,
      color: "#4a372b", lineHeight: 1.05, letterSpacing: 0.08
    })
  };

  const page237Regions = {
    "p0237-r001": authoredRegion(bookId, 237, page237Sources["p0237-r001"], {
      displayName: "Running header",
      categoryId: "text.header",
      classIds: ["layout.wide-header"],
      labelIds: ["running-header"]
    }, {
      fontFamily: "edition", fontSize: 1, fontWeight: 650,
      color: "#443328", lineHeight: 1.05, letterSpacing: 0.05
    }),
    "p0237-r002": authoredRegion(bookId, 237, page237Sources["p0237-r002"], {
      displayName: "Medicinal uses",
      categoryId: "text.body",
      classIds: [],
      labelIds: ["continued-description"]
    }, {
      fontFamily: "edition", fontSize: 1, fontWeight: 430,
      color: "#49382c", lineHeight: 1.2, letterSpacing: 0.01
    }),
    "p0237-r003": authoredRegion(bookId, 237, page237Sources["p0237-r003"], {
      displayName: "Printer's ornament",
      categoryId: "visual.ornament",
      classIds: [],
      labelIds: ["printer-ornament"]
    }, {
      fontFamily: "edition", fontSize: 1.6, fontWeight: 500,
      color: "#6a4d39", lineHeight: 1, letterSpacing: 0
    })
  };

  return {
    schema: PROJECT_SCHEMA,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: "living-herbal-demo",
    displayName: "The Living Herbal",
    revision: 0,
    requiredExtensions: [CORE_EXTENSION, DECORATED_INITIAL_EXTENSION],
    optionalExtensions: {},
    sourceLibrary: {
      books: {
        [bookId]: {
          id: bookId,
          displayName: "De Historia Stirpium source",
          fingerprint: "sha256:fuchs-1542-demo",
          pages: {
            "236": { page: 236, displayName: "Leaf 201 recto source", fingerprint: "sha256:fuchs-1542:236", regions: page236Sources },
            "237": { page: 237, displayName: "Leaf 201 verso source", fingerprint: "sha256:fuchs-1542:237", regions: page237Sources }
          }
        }
      }
    },
    taxonomy: {
      categories: {
        text: { id: "text", displayName: "Text", capabilities: [], components: {} },
        "text.body": { id: "text.body", displayName: "Body text", parentId: "text", capabilities: [], components: {} },
        "text.header": { id: "text.header", displayName: "Header", parentId: "text", capabilities: [], components: {} },
        "text.caption": { id: "text.caption", displayName: "Caption", parentId: "text", capabilities: [], components: {} },
        visual: { id: "visual", displayName: "Visual", capabilities: ["visual-source"], components: {} },
        "visual.ornament": {
          id: "visual.ornament", displayName: "Ornament", parentId: "visual",
          capabilities: ["visual-source"], components: {}
        },
        [DECORATED_INITIAL_CATEGORY]: {
          id: DECORATED_INITIAL_CATEGORY,
          displayName: "Decorated initial",
          parentId: "visual.ornament",
          capabilities: ["visual-source", "text-equivalent", "decorated-initial"],
          components: {}
        },
        navigation: { id: "navigation", displayName: "Navigation", capabilities: [], components: {} },
        artifact: { id: "artifact", displayName: "Artifact", capabilities: [], components: {} }
      },
      classes: {
        "layout.wide-header": {
          id: "layout.wide-header", displayName: "Wide header",
          description: "Allows long running headers to remain on one line.", priority: 10,
          components: { "core.textLayout": { wrap: "nowrap", maxWidthScale: 1.4 } }
        },
        "typography.small-caps": {
          id: "typography.small-caps", displayName: "Small capitals",
          description: "Uses restrained edition-style small capitals.", priority: 20,
          components: { "core.typography": { letterSpacing: 0.04 } }
        },
        "decoration.ornate-initial": {
          id: "decoration.ornate-initial", displayName: "Ornate initial",
          description: "Marks a source-backed decorated opening letter.", priority: 10,
          components: {}
        }
      },
      labels
    },
    components: {},
    rules: emptyRules(),
    books: {
      [bookId]: {
        id: bookId,
        displayName: "De Historia Stirpium",
        components: {},
        rules: {
          ...emptyRules(),
          categories: {
            [DECORATED_INITIAL_CATEGORY]: {
              components: { [DECORATED_INITIAL_COMPONENT]: { representation: "original" } }
            }
          }
        },
        pages: {
          "236": { page: 236, displayName: "Leaf 201 recto", components: {}, rules: emptyRules(), regions: page236Regions },
          "237": { page: 237, displayName: "Leaf 201 verso", components: {}, rules: emptyRules(), regions: page237Regions }
        }
      }
    },
    collections: {
      "needs-review": { id: "needs-review", displayName: "Needs review", regionIds: [] },
      "decorated-initials": { id: "decorated-initials", displayName: "Decorated initials", regionIds: ["p0236-r002"] }
    },
    workspace: { components: {}, rules: emptyRules(), books: {} },
    extensions: {
      "whl.demo-ui": {
        books: {
          [bookId]: {
            creator: "Leonhart Fuchs",
            year: 1542,
            language: "Latin",
            pages: {
              "236": { paper: "#d7bea7" },
              "237": { paper: "#d9c3ad" }
            }
          }
        }
      }
    },
    publicationProfiles: {}
  };
}
