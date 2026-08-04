# Decorated and illuminated capitals

Status: normative decorated-initial companion to `docs/spec/ENGINE_V2.md`.

This document specifies the secondary handling of decorated initials in the
World Herb Library editor and reader. It covers classification, source assets,
layer-aware text equivalents, render settings, inheritance, fallback, and
accessibility. It does not make decorated initials a primary editor workflow,
and it does not change immutable OCR roles.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** describe normative
requirements.

The v2 engine specification is the canonical contract. This companion narrows
that contract with corpus evidence and asset requirements; it does not define a
second component model or alternative cascade.

## Corpus evidence

The current public corpus contains 16,560 OCR regions. Its 1,078 image regions
are classified as follows:

| Book | Figures | Ornaments | `drop-capital` regions |
| --- | ---: | ---: | ---: |
| Fuchs, 1542 | 403 | 255 | 0 |
| *Herbarius zü Teütsch*, 1488 | 401 | 2 | 0 |
| Banckes herbal, 1552 | 16 | 1 | 0 |

The pipeline currently assigns an OCR image the role `ornament` when its area
and width fall below fixed thresholds; all other OCR images become `figure`.
Although the pipeline's art-role set and reader CSS recognize `drop-capital`,
role inference never emits it. The published `ornament` role is therefore a
geometric heuristic, not a reliable historical classification.

A geometric audit found text immediately to the right of 219 of the 255 Fuchs
ornaments. Many are plausible decorated initials, but no bulk conversion is
safe. The following records are representative fixtures:

| Fixture | Evidence | Expected use |
| --- | --- | --- |
| `banckes-1552`, page 37, `p0037-r007` | A decorated D precedes `p0037-r008`. The diplomatic continuation begins “Ragaunce”; the modern continuation already begins “Ragwort.” | Positive decorated-initial fixture and layer-aware continuation test. |
| `fuchs-1542`, page 332, `p0332-r006` | A large historiated/decorated initial precedes `p0332-r007`. | Positive original-crop and per-region override fixture. |
| `fuchs-1542`, page 319, `p0319-r004` | A small printed initial is separately boxed before `p0319-r005`. | Positive compact-layout fixture. |
| `herbarius-1488`, page 1, `p0001-r002` and `p0001-r003` | Small ornaments without an initial/continuation relationship. | Negative fixture: an ornament MUST NOT be promoted automatically. |

Classification can be suggested from geometry and adjacency, but a user or a
reviewed programmatic rule MUST confirm it. OCR image filenames such as
`img-3.jpeg` carry no semantic meaning and MUST NOT be used to infer a letter.

## Historical and engine taxonomy

The editor MUST preserve the source OCR `role`. That field participates in the
existing translation, layout, and art pipeline and is evidence about the OCR
result. Authored classification belongs to a separate annotation on the Region
Object.

The built-in primary category is:

```text
visual
└── ornament
    └── decorated-initial
```

Its stable category ID is `visual.ornament.decorated-initial`. More specific
historical descriptions SHOULD be classes rather than mutually exclusive
categories:

- `woodcut`: a printed initial cut in relief;
- `historiated`: an initial containing a recognizable scene or figure;
- `illuminated`: an initial decorated by hand, especially with pigment, ink,
  or metal leaf;
- `hand-colored`: a printed form with later or contemporary hand coloring.

These terms are not interchangeable. In particular, the Fuchs and Banckes
fixtures are printed decorated or historiated initials and MUST NOT be labeled
`illuminated` merely because the renderer supports illuminated capitals.

A region's authored identity uses stable definition IDs, not display strings:

```json
{
  "displayName": "Decorated D opening Dragantia",
  "categoryId": "visual.ornament.decorated-initial",
  "classIds": ["chapter-opener", "woodcut"],
  "labelIds": ["reviewed"]
}
```

- `displayName` is the editor-facing object name.
- `categoryId` is one semantic leaf in the project taxonomy.
- `classIds` retains assignment order for display, while behavior resolves by
  class priority and then stable class ID; assignment order never creates
  hidden specificity.
- `labelIds` is an unordered set used for filtering, review state, and search.

Definitions own their human-readable names and colors so they can be renamed
without changing references. User-supplied IDs or names MUST NOT be emitted as
raw DOM class names. The renderer applies validated data attributes or internal
tokens instead.

## Region Object and decorated-initial component

The v2 engine treats an on-page region like a Blender Object referencing an
immutable source data block. OCR role, source box, OCR text, and source asset
remain immutable; the Region Object owns authored classification, transforms,
and sparse component overrides.

Decorated-initial content and presentation use one registered component,
`render.decoratedInitial`, supplied by the required extension
`whl.decorated-initial`. Keeping one component gives its validator and reader
serializer a single security boundary while normal sparse-cascade rules still
allow book, page, class, and exact-region overrides. Text equivalents and
continuation relationships SHOULD normally be authored at exact-region scope.

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

Built-in equivalent keys are `diplomatic` and `modern`. `text` contains 1–256
characters. `continuationRegionId` may reference a region on the same physical
page. `consumePrefix`, when present, requires that reference and is compared
exactly against resolved continuation text; the compiler does not case-fold,
trim, normalize Unicode, or guess. A mismatch leaves content unchanged and
emits `DECORATED_INITIAL_PREFIX_MISMATCH`.

The compiler applies a validated prefix once to the compiled continuation,
marks the renderer projection `prefixConsumed`, and keeps the initial once in
the accessibility sequence. Dangling relationships, cycles, multiple consumers
for one continuation/edition, and prefix consumption by a decorative initial
block publication. The reader never repeats the compile-time consumption step.

## Addressable source-art contract

The current reader receives one flattened full-page art remainder. It cannot
hide or replace one initial independently. A paper-colored cover rectangle is
not an acceptable substitute: it destroys scan texture and can cover adjacent
marks.

Pages containing addressable visual regions use
`whl-addressable-art/1`:

```json
{
  "art": {
    "schema": "whl-addressable-art/1",
    "base": {
      "url": "art/0037-base.webp",
      "mimeType": "image/webp",
      "sha256": "<64 lowercase hexadecimal characters>",
      "sourcePageSha256": "<64 lowercase hexadecimal characters>",
      "pixelSize": [1400, 2025]
    },
    "regions": {
      "p0037-r007": {
        "url": "art/regions/0037-p0037-r007.webp",
        "mimeType": "image/webp",
        "sha256": "<64 lowercase hexadecimal characters>",
        "sourcePageSha256": "<64 lowercase hexadecimal characters>",
        "sourceBox": [0.057725, 0.5574092, 0.2207131, 0.6486752],
        "renderBox": [0.053, 0.553, 0.225, 0.653],
        "pixelSize": [241, 203],
        "alphaMethod": "scan-paper-difference/1"
      }
    }
  }
}
```

Coordinates are normalized page coordinates `[x0, y0, x1, y1]` with an
upper-left origin. `sourceBox` is immutable OCR evidence. `renderBox` includes
the reviewed crop bleed and is the box into which the region asset is placed.
Both boxes MUST have positive area and remain within the page.

The asset build MUST:

1. derive the base and region pixels from the same source scan and page color
   sample;
2. use the existing paper-difference alpha approach so original marks retain
   their color and edge character;
3. assign addressable pixels to the region mask and subtract those exact alpha
   pixels from `base`, preventing a duplicate image beneath the crop;
4. preserve nearby text or artwork outside the mask, even when the reviewed
   crop includes bleed;
5. record source-page and output checksums and reject stale crops when the
   source page changes;
6. publish assets through the normal immutable S3/CloudFront path.

The base and crop MUST use the page's native aspect ratio. Reader zoom and
region geometry are applied by layout exactly once; raster pixel dimensions do
not change logical placement. The default composition uses multiply blend to
match the sampled facsimile paper. The renderer MUST NOT apply tinting,
sharpening, generative reconstruction, or style filters.

## Renderer properties

`render.decoratedInitial` is a sparse property bag. Omitted values inherit
through the common component cascade shown in `ENGINE_V2.md`.

### Modes

| Mode | Visual behavior |
| --- | --- |
| `auto` | Diplomatic prefers `original`; modern prefers its explicit modern equivalent. |
| `original` | Render the scan-derived addressable crop. |
| `diplomatic` | Omit the crop and render the diplomatic equivalent. |
| `modern` | Omit the crop and render the modern equivalent. |
| `hidden` | Omit both visual crop and visual text. Semantic text remains unless the component is explicitly decorative. |

`representationByEdition` supplies an edition-specific representation and wins
over `representation` only when the latter is `auto`. `fallback` uses the same
five-value vocabulary. If no field is authored, the default representation is
`auto`.

### Original presentation

| Property | Values | Default |
| --- | --- | --- |
| `assetRef` | safe asset ID | source region asset |
| `fit` | `contain`, `cover`, `stretch` | `contain` |
| `alignX`, `alignY` | number from 0 to 1 | `0.5` |
| `opacity` | number from 0 to 1 | `1` |
| `blendMode` | `multiply`, `normal` | `multiply` |

These properties control composition, not image alteration. Implementations
MUST NOT add arbitrary CSS filters through custom properties.

### Text presentation

| Property | Values | Default |
| --- | --- | --- |
| `placement` | `inline`, `drop-cap`, `overlay` | `drop-cap` |
| `dropLines` | integer from 1 to 12 | `2` |
| `scale` | number from 0.25 to 4 | `1` |
| `align` | `start`, `center`, `end` | `start` |

Font family, size, weight, color, line height, and character spacing remain in
the common `core.typography` component rather than being reimplemented here.
Text fitting remains constrained by the Region Object's resolved transform and
text-layout components.

### Scope and precedence

Renderer settings use the engine's normal component precedence: registered
defaults; project components and project selector rules; taxonomy category and
priority-sorted class bundles; book components and selector rules; page
components and selector rules; source data; and exact-region components. Each
published/workspace pair resolves at its specificity before moving to the next.

The same sparse leaf merge applies inside `original`, `text`,
`representationByEdition`, `equivalents`, and `accessibility`. Every resolved
leaf retains provenance so Properties can show, for example, “Original —
inherited from Fuchs book settings.” In workspace overlays, JSON `null` is an
explicit tombstone that reveals the value and provenance inherited before that
published/workspace bucket; it is never emitted as a reader value.

## Fallback and diagnostics

Fallback is conservative and must keep source evidence visible:

1. If `modern` or `diplomatic` is requested but that explicit equivalent is
   missing, follow `fallback` and emit
   `DECORATED_INITIAL_REPRESENTATION_MISSING`.
2. If `original` is requested and the addressable region crop is missing,
   follow `fallback` and emit the same diagnostic. A legacy flattened page-art
   region is not falsely treated as an addressable asset.
3. If no requested or fallback representation is available, use `hidden` for
   visual safety. A non-decorative initial without an explicit equivalent also
   emits `DECORATED_INITIAL_ACCESSIBLE_FALLBACK_MISSING` and blocks
   publication.
4. `hidden` is the only mode that intentionally permits no visual output. It
   does not suppress semantic text unless `accessibility.decorative` is true.

A non-addressable legacy art layer cannot support `modern`, `diplomatic`, or `hidden` for one
region. The reader MUST fall back to visible original art rather than covering
or erasing it. Diagnostics include project, book, page, region, layer, active
publication profile, requested representation, fallback representation, and
property provenance.

## Accessibility and reading order

Visual composition and semantic reading are separate outputs of the renderer.
The page MUST expose one linearized semantic fragment for a content-bearing
initial and its continuation, independent of visual mode.

- When a valid equivalent is present, the original crop is `aria-hidden` and
  the equivalent participates in semantic reading order exactly once.
- A modern or diplomatic visible glyph MUST NOT create a second accessible copy.
- Hidden mode still contributes the semantic equivalent unless the region is
  explicitly decorative.
- `accessibility.decorative` defaults to `false`. When true, the crop and
  equivalent are excluded from semantic output and `consumePrefix` MUST be
  absent.
- If a non-decorative original has no equivalent, the renderer MAY expose its
  `description` as an image description but MUST also report
  `DECORATED_INITIAL_ACCESSIBLE_FALLBACK_MISSING`; a description is not a
  transcription.
- Language is inherited from the active edition; a future language override
  requires a separately registered, reader-safe schema extension.

The editor context menu is not the only way to classify or edit a capital.
Menu-key/Shift+F10 access and the Properties editor MUST expose the same
operators. Right-clicking a region makes it active; it preserves an existing
multi-selection when the region is already selected. Category assignment and
multi-region class changes are single undoable transactions.

## Test contract

### Unit and schema tests

1. Preserve immutable source role when assigning or clearing a category.
2. Accept the decorated-initial category and descendants; reject the renderer
   on an unrelated ornament.
3. Validate safe definition IDs, existing taxonomy parents, acyclic category
   trees, ordered/deduplicated classes, text limits, numeric ranges, MIME
   types, boxes, and checksums.
4. Reject cross-page continuation references, cycles, duplicate consumers, and
   `consumePrefix` without a continuation.
5. Resolve project -> book -> page -> priority-sorted classes -> exact-region
   leaf precedence with correct provenance. Removing a workspace leaf reveals
   the inherited value and provenance.
6. Map `auto` to original for diplomatic and modern text for modern. Verify
   `representationByEdition` and exact-region overrides.
7. Preserve unavailable extension bags value-for-value through canonical
   import/export and report them inactive.
8. Migrate v1 typography, geometry, fit, and text overrides without changing
   their effective values.

### Content and fallback tests

1. For Banckes page 37, produce diplomatic `D` + `Ragaunce` and modern `R` +
   (`Ragwort` minus declared prefix `R`) without duplication.
2. Change the modern continuation to a nonmatching prefix; preserve all text,
   emit `DECORATED_INITIAL_PREFIX_MISMATCH`, and require review before a strict
   publication.
3. Request modern text with no equivalent; follow the configured fallback and
   emit `DECORATED_INITIAL_REPRESENTATION_MISSING`.
4. Request original against legacy full-page art; keep original page art
   visible and emit `DECORATED_INITIAL_REPRESENTATION_MISSING` because the
   region is not independently addressable.
5. Verify hidden mode removes visual output but preserves semantic content.

### Render and accessibility tests

1. On Fuchs page 332, assert the base layer does not contain the initial's
   assigned alpha pixels and the original crop appears once.
2. Switch only `p0332-r006` to modern and assert neighboring text/art pixels are
   unchanged.
3. Exercise original and modern at 50%, 100%, and 250% reader zoom; region
   geometry and typography scale exactly once.
4. Compare the crop against its source scan checksum and inspect edge alpha on
   the sampled page background; no tint or reconstruction is permitted.
5. Assert a screen reader receives the equivalent and continuation exactly
   once in original, modern/diplomatic, and hidden representations.
6. Assert the Herbarius page 1 ornaments remain ordinary ornaments unless an
   explicit reviewed assignment is applied.
7. Exercise category and mode actions with mouse, Menu key, and Shift+F10;
   verify selection preservation, mixed class state, one-step undo/redo, and
   inherited-property labels in the Properties editor.

These fixtures are regression anchors, not exhaustive classifications. A
future reviewed annotation pass may add more decorated initials without
changing this renderer contract.
