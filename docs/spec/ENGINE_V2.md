# Facsimile engine v2 specification

Status: draft implementation contract
Audience: engine, reader, Electron editor, pipeline, and publication tooling
Normative words: **must**, **should**, and **may** have their usual RFC meanings.

## 1. Decision

The World Herb Library facsimile system is split into three contracts:

1. **Source library** — immutable OCR page data, scans, and addressable visual
   assets produced by the pipeline.
2. **Authoring project** — editable taxonomy, region objects, property
   overrides, workspaces, and review state used by Electron and automation.
3. **Reader publication** — a deterministic, read-only projection compiled
   from an authoring revision for GitHub Pages.

The Electron editor and the publication compiler use the same dependency-free
engine core. The reader consumes only the compiled projection and the
reader-safe renderer modules. Editor controls, history, credentials, and
desktop IPC must not be present in the Pages artifact.

The existing `whl-region-settings/1` document remains an import format. A v1
migration adapter maps it into the v2 component model without changing the
effective typography, geometry, layout, or text values.

## 2. Goals and non-goals

The engine must:

- preserve source OCR and scan data as immutable inputs;
- provide stable, scriptable identities for books, pages, and regions;
- support labels, semantic categories, reusable region classes, and
  organizational collections without conflating them with OCR roles;
- resolve sparse book, role, category, class, page, and exact-region
  properties deterministically and report their provenance;
- expose the same validated operator surface to UI, scripts, tests, and CLI;
- support renderer plug-ins with typed settings and explicit reader safety;
- make every confirmed edit atomic and undoable;
- compile a small, deterministic reader publication; and
- fail publication when required extensions, source references, or accessible
  fallbacks cannot be evaluated.

The first version does not attempt Blender-style animation, arbitrary Python
execution, arbitrary CSS, user-scripted UI panels, unconstrained custom
properties, or arbitrary window layouts.

## 3. Blender concepts adopted

The model borrows a small set of useful Blender ideas:

| Blender concept | Facsimile equivalent |
| --- | --- |
| Main database | Authoring project database |
| Scene | Active page scene |
| Object | Region object with transform, annotations, and component overrides |
| Object data | Immutable OCR region, text data, or visual asset |
| Material | Style or render profile |
| Collection | Non-exclusive organizational region collection |
| View layer | Modern, diplomatic, QA, or publication edition |
| Active object | Region receiving context-sensitive edits |
| Selected objects | Regions included in a multi-object operation |
| Context | Immutable view of workspace, area, mode, selection, and active scope |
| Operator | Validated command with `poll`, execute, inverse, and dirty tags |
| Library override | Published base plus local authoring overlay |
| Dependency graph | Incremental source-to-publication evaluator |

As in Blender, active and selected are distinct. Right-clicking an unselected
region makes it active and selected. Right-clicking a member of an intentional
multi-selection preserves the selection while making that region active.

## 4. Data-block hierarchy

```text
Project
|- SourceLibrary references (immutable)
|- Taxonomy
|  |- Categories (single-parent hierarchy)
|  |- RegionClasses (ordered reusable property bundles)
|  `- Labels (search/review tags)
|- Books
|  |- book properties and source-role/category/class rules
|  `- Pages
|     |- page properties and source-role/category/class rules
|     `- RegionObjects
|- RenderProfiles
|- Editions
`- PublicationProfiles
```

Every data block has an immutable, namespaced ID and a mutable display name.
References use IDs, never array positions or display names.

### 4.1 Region object

A region object points to immutable source data and contains only authored
metadata and overrides:

```json
{
  "id": "region:banckes-1552:37:p0037-r007",
  "sourceRef": {
    "bookId": "banckes-1552",
    "page": 37,
    "regionId": "p0037-r007",
    "fingerprint": "sha256:source-region-digest"
  },
  "origin": "source",
  "annotations": {
    "displayName": "Decorated D opening Dragantia",
    "categoryId": "visual.ornament.decorated-initial",
    "classIds": ["banckes.chapter-opener", "woodcut"],
    "labelIds": ["reviewed"]
  },
  "components": {
    "render.decoratedInitial": {
      "representation": "original"
    }
  }
}
```

`sourceRole` remains in the immutable source region. `categoryId` is one
exclusive authored semantic classification. `classIds` are reusable ordered
behavior/property bundles. `labelIds` are non-behavioral search and review
tags. User-defined IDs must never be copied directly into DOM class names.

`origin` is `source` or `authored`. Only an authored region may be deleted;
deleting a source-backed region means setting edition visibility, never
deleting source data.

### 4.2 Taxonomy

Categories form an acyclic, single-parent hierarchy. A category can declare
capabilities that activate components and renderers:

```json
{
  "id": "visual.ornament.decorated-initial",
  "displayName": "Decorated initial",
  "parentId": "visual.ornament",
  "capabilities": ["visual-source", "text-equivalent", "decorated-initial"],
  "color": "#8f6347"
}
```

Suggested built-in roots are `text`, `visual`, `navigation`, and `artifact`.
The historically narrower `visual.ornament.illuminated-capital` may be a child
of `visual.ornament.decorated-initial`; the UI must not automatically call all
printed decorated or historiated initials "illuminated".

Classes have a deterministic integer priority and a typed component bundle.
Lower priority applies first; ties resolve by immutable class ID. Assignment
order is retained for display but must not create hidden CSS-like specificity.

Collections may contain a region in more than one place and are organizational
only. Collection membership does not affect property evaluation unless a
future extension explicitly registers such a rule type.

## 5. Component and renderer registries

The core knows how to orchestrate components, but not their property fields.
Each component owns its validator, merge semantics, defaults, dirty tags,
reader serializer, and optional inspector metadata.

Initial component IDs:

- `core.pageAppearance`
- `core.typography`
- `core.transform`
- `core.textLayout`
- `core.content`
- `core.visibility`
- `render.decoratedInitial`

Conceptual registration API:

```js
components.register({
  id: "core.typography",
  version: 1,
  readerSafe: true,
  targetKinds: ["region"],
  supportedScopes: ["project", "book", "page", "region"],
  defaults: {},
  validate(value, context) {},
  merge(base, override) {},
  dirtyTags: ["layout", "paint", "accessibility"],
  serializeForReader(value) {}
});

renderers.register({
  id: "decorated-initial",
  version: 1,
  readerSafe: true,
  requiredCapability: "decorated-initial",
  componentId: "render.decoratedInitial",
  evaluate(region, assets, edition) {},
  serializeForReader(value) {},
  validatePublication(model) {}
});
```

Both registries are publication-deny-by-default. `readerSafe: true` is valid
only with an explicit reader serializer; the compiler never raw-clones an
unmarked component or renderer result. A renderer serializer cannot replace
the registered renderer ID.

The project declares `requiredExtensions` and `optionalExtensions`. Unknown
required extensions fail validation and compilation. Unknown optional
extension blocks round-trip canonically but are never executed or emitted to a
reader unless an installed serializer marks them reader-safe.

Every component declares the target kind it evaluates (`region` or `page`)
and the authoring scopes at which it is legal. Region components may cascade
through project, taxonomy, selector-rule, book, page, and exact-region scopes.
Page components use a separate project to book to page cascade and must not be
placed in category/class rules or exact regions. The initial
`core.pageAppearance` page component is:

```json
{
  "mode": "matched",
  "color": "#eee2c5",
  "texture": { "kind": "paper", "strength": 0.28, "scale": 1 }
}
```

`mode` is `matched` or `solid`; procedural texture kinds are `none`, `paper`,
and `fibers`. Texture configuration contains no asset URL or arbitrary CSS.
`solid` plus `none` must paint a truly flat color. Scan imagery remains a
separate immutable source layer and is never sampled or altered to create the
solid background.

## 6. Context model

Context is transient, immutable, and passed explicitly to every operator. It
must not be serialized into a reader publication or contain credentials.

```js
{
  projectId: "living-herbal",
  workspaceId: "classification",
  mode: "OBJECT",
  area: "viewport",
  bookId: "banckes-1552",
  page: 37,
  activeRegionId: "p0037-r007",
  selectedRegionIds: ["p0037-r007"],
  activeScope: { kind: "region", regionId: "p0037-r007" },
  activeEdition: "modern",
  activeToolId: "select",
  previewIntent: "editor"
}
```

Initial modes are:

- `OBJECT`: select, classify, and edit properties;
- `TRANSFORM`: modal move/resize with preview, confirm, or cancel;
- `TEXT`: edit one region/layer while geometry remains stable.

Automation may derive a context with explicit overrides. There is no mutable
global context singleton.

Clearing selection sets `activeRegionId` to `null`, empties
`selectedRegionIds`, and restores `{ "kind": "page" }` as the active scope.
It is a transient context change, not an operator, and therefore never enters
project history.

## 7. Operators and transactions

All mutations go through registered operators. UI components, context menus,
scripts, and the CLI must not mutate documents or DOM state directly.

```js
engine.operators.poll("region.assignCategory", context, {
  categoryId: "visual.ornament.decorated-initial"
});

await engine.operators.execute(
  "region.assignCategory",
  context,
  { categoryId: "visual.ornament.decorated-initial" }
);
```

`poll` returns `{ allowed, reason? }`. `execute` validates context and
arguments, creates forward and inverse changes, and emits dirty tags. A
multi-region category assignment is one transaction and one undo entry.

Initial operators:

- `region.setDisplayName`
- `region.assignCategory`
- `region.addClass` / `region.removeClass`
- `region.addLabel` / `region.removeLabel`
- `region.create` / `region.deleteAuthored`
- `region.transform`
- `content.setText`
- `property.set` / `property.reset`
- `collection.link` / `collection.unlink`
- `render.setRepresentation`
- `project.import`
- `publication.compile` / `publication.submit`

Pointer transforms are modal transactions: begin, preview many times, then
confirm once or cancel. Only confirmation enters history. History stores
changesets plus periodic checkpoints rather than a full project clone per
edit.

## 8. Property cascade and provenance

Classification is resolved before category and class rules. Component fields
then resolve from least to most specific:

1. component defaults;
2. project components;
3. taxonomy category bundles, root to leaf;
4. taxonomy class bundles by priority and stable ID;
5. project source-role, category, and class rules;
6. book components, then book source-role, category, and class rules;
7. page components, then page source-role, category, and class rules;
8. immutable source-region object data;
9. exact Region Object components.

At each scope, published base applies before the local workspace overlay.
Specificity outranks layer: a published exact-region value remains more
specific than a local book default. This preserves v1 behavior and prevents a
broad local edit from unexpectedly erasing reviewed exceptions.

Every resolved field includes provenance:

```json
{
  "value": "original",
  "source": {
    "layer": "workspace",
    "scope": "pageCategory",
    "ownerId": "page:banckes-1552:37",
    "selectorId": "visual.ornament.decorated-initial",
    "componentId": "render.decoratedInitial",
    "path": "representation"
  }
}
```

The Properties editor shows both effective and authored values and offers
"Reset to inherited" per field. Explicit `null` tombstones are used where a
local overlay must clear a published assignment; absence always means inherit.

`core.typography` includes the closed-vocabulary layout fields `textAlign`
(`start`, `center`, `end`, `justify`), `textAlignLast`, `textJustify`, and
`hyphens`. These fields follow the same field-level cascade and reader-safe
serialization as font, size, weight, color, line height, and character
spacing.

Page-target evaluation is intentionally smaller: component defaults, project,
book, then page, with the published value preceding the workspace overlay at
each level. `engine.evaluatePage(bookId, page)` returns an immutable page
snapshot and field provenance. Page components never appear in
`evaluateRegion`, even when project/book/page component bags contain both
target kinds.

## 9. Dependency graph

Evaluation is a pure pipeline:

```text
source region
  -> authored annotations/category/classes
  -> component cascade and provenance
  -> renderer selection
  -> asset and content relations
  -> transform and text layout
  -> paint/compositing
  -> accessibility tree
  -> reader serialization
```

Components tag affected stages: `classification`, `content`, `geometry`,
`layout`, `paint`, `assets`, `accessibility`, or `publication`. The evaluator
invalidates only affected regions/pages. A book category-default change may
invalidate all matching regions in that book; an exact text edit must not
re-evaluate unrelated pages.

## 10. Decorated and illuminated initials

`render.decoratedInitial` is a capability-driven optional component. It is not
shown prominently and is polled only for a category with the
`decorated-initial` capability.

```json
{
  "representation": "auto",
  "fallback": "modern",
  "representationByEdition": {
    "diplomatic": "original",
    "modern": "modern"
  },
  "equivalents": {
    "diplomatic": {
      "text": "D",
      "continuationRegionId": "p0037-r008"
    },
    "modern": {
      "text": "R",
      "continuationRegionId": "p0037-r008",
      "consumePrefix": "R"
    }
  },
  "original": {
    "assetRef": "asset:banckes-1552:37:p0037-r007",
    "fit": "contain",
    "alignX": 0.5,
    "alignY": 0.5,
    "opacity": 1,
    "blendMode": "multiply"
  },
  "text": {
    "placement": "drop-cap",
    "dropLines": 2,
    "scale": 1,
    "align": "start"
  },
  "accessibility": {
    "decorative": false,
    "description": "Decorated initial D"
  }
}
```

Representations are `auto`, `original`, `diplomatic`, `modern`, and `hidden`.
`auto` is edition-aware. Original uses an unaltered, addressable source crop;
modern and diplomatic use explicit text equivalents. No generative repainting,
hue shift, or style alteration is part of this renderer.

Book defaults are category rules. Page-category and exact-region components
override them through the normal cascade. A missing asset or equivalent emits
a diagnostic and follows `fallback`; it must never silently produce an empty
semantic initial.

If `consumePrefix` does not match the resolved continuation, compilation warns
and leaves the continuation intact. Visual and accessibility evaluation must
include the initial exactly once regardless of representation.

When the prefix matches, the compiler removes it once from the compiled
continuation edition and marks the renderer projection `prefixConsumed`; the
reader does not consume it again. Dangling continuations, cycles, multiple
consumers of one continuation/edition, or semantic consumption by a decorative
initial block publication.

An independently switchable original requires an addressable crop/mask. A
flattened page-art image cannot safely be covered with a paper-colored box.
The asset contract is specified in [`ILLUMINATED_CAPITALS.md`](../ILLUMINATED_CAPITALS.md).

## 11. Reader publication

The compiler emits `whl-reader-publication/1`, not the authoring database. The
projection contains:

- project ID, source fingerprints, revision, and content hash;
- reader-safe taxonomy/category capabilities used on published pages;
- compiled effective page/region components;
- reader-safe renderer IDs and validated assets; and
- diagnostics explicitly accepted by the publication profile.

It excludes editor context, selections, workspace layout, undo history,
reviewer credentials, cloud configuration, unpublished labels, and extensions
that do not declare a reader serializer.

Canonical JSON sorting and content hashing make identical authoring states
produce byte-identical projections. Assets use immutable content-addressed
paths. The static reader treats missing or invalid optional renderer data as a
diagnostic fallback and continues to render immutable source content.

## 12. Persistence, source drift, and migration

An Electron workspace is a directory, not a single mutable browser-storage
record:

```text
project.whlproject/
  project.json
  overlays/
  journal.ndjson
  snapshots/
  assets/
  publication/
```

Writes validate to a sibling temporary file, flush, and atomically replace the
target. An append-only, checksummed transaction journal supports recovery.
Periodic checkpoints bound replay time. UI layout is application-local and is
not published.

Source references include book, page, source region ID, and fingerprint. A
Region Object ID is independent from its source-region ID and is globally
unique within the project. Missing expected/source fingerprints and exact
fingerprint mismatches block publication. OCR regeneration produces a remapping
report; the engine must never silently fuzzy-remap an edited region.

The v1 migration maps:

- `style` to `core.typography`;
- `geometry` to `core.transform`;
- `fit` to `core.textLayout`;
- `text` to `core.content`; and
- `regionTypes` to source-role rules.

Golden tests resolve representative v1 pages through both models and compare
effective values before the current browser engine is retired.

## 13. Required conformance tests

- safe IDs, parent existence, category cycle rejection, and reference checks;
- deterministic category ancestry and class-priority ordering;
- full cascade precedence with field-level provenance;
- page-target cascade, scope rejection, tombstones, and publication isolation;
- justification vocabulary, cascade, and reader serialization;
- selection clearing as immutable, history-free context state;
- active versus selected context and operator `poll` behavior;
- one changeset for multi-region and modal edits; undo, redo, and cancel;
- lossless unknown optional extensions and rejected required extensions;
- canonical import/export and v1 migration equivalence;
- book/page/region decorated-initial overrides and edition-aware `auto`;
- missing asset/equivalent diagnostics and prefix-consumption mismatch safety;
- accessible reading order containing each semantic initial exactly once;
- source-fingerprint drift blocking publication; and
- reader projection exclusion of all editor-only state and APIs.

## 14. Implementation order

1. Land schemas, registries, context, operators, cascade, migration, and golden
   fixtures in a dependency-free core.
2. Build the Electron/Blueprint shell and local workspace persistence.
3. Add taxonomy, labels, classes, context menus, and provenance inspection.
4. Generate addressable decorated-initial assets and add the renderer.
5. Compile the read-only browser runtime from shared components.
6. Add reviewed publication and cloud staging.
7. Remove the transitional editor UI and mutation engine from GitHub Pages.
