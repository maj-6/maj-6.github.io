# Region editor contract

The facsimile application has two operating modes built on the same region
settings engine:

- reader mode applies approved, published settings without exposing mutation
  controls;
- editor mode adds local drafting, direct region manipulation, editable plain
  text, and import/export tools.

The OCR page JSON, source scans, and scan-derived art are immutable inputs.
Neither mode rewrites them. Corrections and presentation changes are sparse,
reviewable overlays keyed to the existing book, page, role, and region IDs.

## Production feature gate

[`data/reader-config.json`](../data/reader-config.json) is the runtime project
configuration:

```json
{
  "schema": "whl-reader-config/1",
  "projectId": "living-herbal",
  "features": {
    "regionEditor": false
  },
  "publishedSettings": "data/region-settings.json",
  "draftStorageKey": "whl-region-settings-v1"
}
```

The editor is enabled only when the configuration has the expected schema and
project ID and `features.regionEditor` is the literal JSON boolean `true`.
Missing configuration, malformed JSON, a missing property, `false`, `null`,
`1`, and the string `"true"` all fail closed to reader mode. A query string,
local preference, imported settings file, or published settings document can
never enable editing. If configuration or editor initialization fails, normal
book loading and page navigation must continue.

The flag is a static feature gate, not authentication or authorization. Every
asset delivered by a static site is public and a visitor can modify their own
browser runtime. Consequently, editor saves are local drafts and exports; the
browser has no AWS credentials and performs no direct S3, CloudFront, GitHub,
or repository writes. Publishing remains an authenticated review and CI task.
Any future write API must enforce its own server-side authentication,
authorization, validation, revision checks, and audit trail independently of
this flag.

Published settings remain a read-only reader input whether or not the editor
is enabled. Local drafts and editor mutation APIs are ignored when the flag is
off, including drafts left in browser storage by an earlier enabled session.

## Settings model

Settings are sparse: an omitted value inherits from the next broader scope.
For a region, values resolve in this order, with later scopes winning:

1. book;
2. region type within that book;
3. page;
4. region type within that page;
5. individual region.

“Region type” means the normalized OCR `role`, such as `body`, `header`,
`heading`, `caption`, `marginalia`, or `page-number`. Each scope can set the
supported typography properties independently, so changing a page color does
not erase a region-specific size. A region can also carry an explicit
normalized box or constrained layout scale. Direct region geometry wins over
broader scaling rules.

The reader's personal Display controls are not authored settings. Text size
and line-height preferences are applied as final multipliers, and page zoom
scales the page and its typography exactly once. Thus an approved region style
survives page turns while reader accessibility preferences remain reversible.

The canonical published document is
[`data/region-settings.json`](../data/region-settings.json). It is safe to keep
empty; the base facsimile remains the fallback. The document and every import
must satisfy the
[`schemas/region-settings.schema.json`](../schemas/region-settings.schema.json)
structure and pass the runtime validator's tighter value bounds before values
are resolved or persisted.

The version 1 document shape is:

```json
{
  "schema": "whl-region-settings/1",
  "schemaVersion": 1,
  "projectId": "living-herbal",
  "overrides": {
    "fuchs-1542": {
      "book": {
        "style": { "fontFamily": "edition" }
      },
      "regionTypes": {
        "header": {
          "fit": {
            "mode": "grow-width",
            "wrap": "nowrap",
            "maxWidthScale": 1.5
          }
        }
      },
      "pages": {
        "236": {
          "style": { "color": "#29261e" },
          "regionTypes": {
            "caption": {
              "style": { "letterSpacing": 0.02 }
            }
          },
          "regions": {
            "p0236-r003": {
              "geometry": {
                "box": [0.22, 0.74, 0.43, 0.79]
              },
              "text": {
                "modern": "PAEONIA\nFEMALE"
              }
            }
          }
        }
      }
    }
  }
}
```

A patch may contain these property groups:

- `style`: `fontFamily`, `fontSize`, `fontWeight`, `color`, `lineHeight`, and
  `letterSpacing`;
- `geometry`: `translateX`, `translateY`, `scaleX`, and `scaleY`; an exact
  normalized `box` is valid only for an individual region;
- `fit`: `mode`, `wrap`, `overflow`, `maxWidthScale`, and `minFontScale`;
- `text`: `modern` and `diplomatic`, valid only for an individual region. An
  empty string is an intentional text override, not inheritance.

`regionTypes` appears at both book and page scope. Page keys are decimal page
numbers serialized as strings. Book IDs, normalized roles, and region IDs must
match the source data. Resolution merges properties rather than replacing an
entire group: for example, a region-specific weight retains a page-specific
color.

## Validation and safe rendering

The engine accepts a fixed property vocabulary rather than arbitrary CSS:
font family, font size, font weight, font color, line height, character
spacing, normalized geometry, and constrained layout scaling. It rejects
non-finite or out-of-range numbers, invalid boxes, unsupported font tokens,
unsafe colors, unknown properties, malformed book/page/region selectors,
prototype-pollution keys, and oversized text or documents. Invalid settings
are rejected before resolution or persistence; a settings failure must not
prevent the immutable underlying page from rendering.

Version 1 validates the following values:

- `fontFamily` is `edition`, `georgia`, `palatino`, or `sans`; `fontSize` is
  0.5–4; `fontWeight` is an integer from 100–900;
- `color` is opaque `#RGB` or `#RRGGBB`; `lineHeight` is
  0.5–4; `letterSpacing` is −0.25–1;
- normalized boxes contain four 0–1 coordinates and have positive area;
  `translateX`/`translateY` are −1–1 and `scaleX`/`scaleY` are 0.25–4;
- fit mode is `scroll`, `grow-width`, `shrink-text`, or `grow-then-shrink`;
  wrapping is `normal`, `nowrap`, or `balance`; overflow is `hidden`, `auto`,
  `scroll`, or `visible`; `maxWidthScale` is 1–4 and `minFontScale` is
  0.5–1;
- `modern` and `diplomatic` text are strings of at most 1,000,000 characters,
  including the intentional empty string.

Edited content is plain text. Rendering and editing use `textContent`, never
source-provided HTML. Direct editing is exposed as an accessible multiline
textbox only for the selected text region, and paste/import paths remove markup
before validation. Text for the modern and diplomatic layers is stored
separately. Text corrections should be reviewed against the scan, and their
region IDs should be revalidated whenever OCR geometry is regenerated.

## Drafts, import, and export

Editor operations update an in-memory draft immediately so page turns cannot
discard work. The configured `draftStorageKey` namespaces durable browser
storage by project; each book remains isolated inside that project's override
document. `createBrowserPersistence` prefers IndexedDB and falls back to
localStorage. Storage quota or privacy-mode failures are reported without
breaking reading, and callers can await `engine.flush()` before navigation or
shutdown when they require confirmation that queued storage has settled.

Export produces canonical JSON in the same validated contract as the
published settings file. Import is available only in editor mode, validates
before changing the draft, and should present a summary or diff before merge.
Import never publishes. The engine's programmatic interface uses the same
validated operations as the UI, allowing scripts to set or remove scoped
properties, replace layer text, and update a normalized region box without
special DOM manipulation.

The browser engine is exposed as `window.WHLRegionSettings`. Its versioned
surface includes `SCHEMA`, `schemaVersion`, `createEngine`,
`createIndexedDBPersistence`, `createLocalStoragePersistence`, and
`createBrowserPersistence`, plus `EditorDisabledError` and
`SettingsValidationError`. Application and script callers should use the
engine instead of modifying the override object or region DOM directly:

```js
const editorEnabled = config?.schema === "whl-reader-config/1"
  && config?.projectId === "living-herbal"
  && config?.features?.regionEditor === true;
const persistence = editorEnabled
  ? WHLRegionSettings.createBrowserPersistence({
      dbName: config.draftStorageKey,
      keyPrefix: `${config.draftStorageKey}:`
    })
  : null;

const engine = WHLRegionSettings.createEngine({
  projectId: config.projectId,
  base: publishedSettings,
  editorEnabled,
  persistence
});

await engine.ready;

const context = {
  bookId: "fuchs-1542",
  page: 236,
  role: "caption",
  regionId: "p0236-r003",
  layer: "modern"
};
const target = {
  scope: "region",
  bookId: context.bookId,
  page: context.page,
  regionId: context.regionId
};

const effective = engine.resolve(context);
engine.set(
  target,
  { style: { fontWeight: 600 }, geometry: { scaleX: 1.1 } }
);
engine.setText(target, "modern", "Corrected text");
await engine.flush();
```

Mutation targets have scope `book`, `regionType`, `page`, `pageRegionType`, or
`region` and include only the identifiers required by that scope. `set()`
merges a validated patch; `remove()` clears a scope or property path;
`setText()` and `clearText()` operate on one region and layer. `import()` uses
`merge` or `replace` mode, while `export({ stringify: true, pretty: true })`
returns canonical JSON. `getScope()`, `resolve()`, `snapshot()`, `undo()`,
`redo()`, `batch()`, `applyCommands()`, `subscribe()`, `ready`, and `flush()`
support inspection, automation, history, observation, and persistence.
Mutation methods throw `EditorDisabledError` unless the engine was constructed
with the strict project gate enabled; read-only resolution remains available.

After reader initialization, `window.WHLReaderRegions` provides only the
read-only application surface: `ready`, `resolve`, `getScope`, `snapshot`,
`export`, and `subscribe`. The runtime creates `window.WHLReaderEditor` only
when the strict JSON gate is enabled. That gated surface adds `set`, `remove`,
`setText`, `clearText`, `setBox`, `import`, `undo`, `redo`, `batch`, `flush`,
and `selectRegion`. Scripts intended to operate inside the reader should prefer
these application surfaces so their permissions match the current mode.

To publish an approved export:

1. validate it with the repository tests and schema;
2. review text, geometry, source fingerprints, and accessibility implications;
3. merge it into `data/region-settings.json` through version control;
4. run the complete reader and release checks;
5. deploy through the existing GitHub Pages/AWS publication workflow.

Do not paste AWS keys into the editor or add a browser-side “publish” request.

## Accessibility and keyboard behavior

Selection, movement, and resizing must have labelled numeric or keyboard
controls in addition to pointer handles. Only the active text region becomes
editable, with an accessible region/type label and multiline semantics.
Escape cancels a pending text edit and Ctrl/Cmd+Enter commits it. IME
composition must finish before committing.

Arrow keys inside a range, select, text field, editable region, or pannable
spread retain their native purpose. When focus is on the Display summary,
Left and Right continue to turn pages; merely opening settings must not disable
page navigation.
