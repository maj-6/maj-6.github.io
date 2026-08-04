# Electron editor UX specification

Status: draft implementation contract
UI toolkit: React and BlueprintJS 6

## 1. Product boundary

The Electron application is the authoring product. GitHub Pages is the reading
product. They share schemas, evaluation, renderer contracts, and publication
fixtures, but not UI code or privileges.

The editor renderer never accesses the filesystem, Git, shell, AWS, or raw
Electron APIs. It projects engine state and dispatches typed operators through
a narrow preload bridge. The main process owns validated workspace I/O and
publication services.

## 2. Workspace layout

```text
+----------------------------------------------------------------------------+
| Project | Book | Page | Workspace | Select/Transform/Text | Undo | Publish |
+--------------------+--------------------------------------+----------------+
| Outliner           | Original scan | Facsimile preview    | Properties     |
|                    |               |                       |                |
| Books              |      page viewport / overlays        | Context        |
| Pages              |                                      | Classification |
| Regions            |                                      | Content        |
| Collections        |                                      | Typography     |
| filters / search   |                                      | Transform      |
|                    |                                      | Rendering      |
+--------------------+--------------------------------------+----------------+
| status | active region | selection | coordinates | diagnostics | revision    |
+----------------------------------------------------------------------------+
```

The layout is deliberately stable rather than arbitrarily dockable. Panel
widths may be resized and saved locally. At narrow widths, Properties becomes a
drawer; the viewport remains the primary work area.

## 3. Workspaces and modes

Workspace tabs change defaults and panel emphasis, not underlying data:

- **Layout** — transforms, fit, typography, and page composition;
- **Text** — modern/diplomatic content and continuation relations;
- **Classification** — categories, classes, labels, and collections;
- **QA** — source comparison, confidence, diagnostics, and review state;
- **Publish** — diff, validation, assets, revision, and submission.

Modes are explicit and small:

- **Select** (`OBJECT`) selects and inspects regions;
- **Transform** previews move/resize, then confirms or cancels one transaction;
- **Text Edit** edits one region and edition.

Escape cancels a modal operation or leaves the current mode. Enter confirms a
transform. Text editing honors IME composition and uses Ctrl/Cmd+Enter to
commit. Arrow keys navigate pages only when focus is not owned by a control,
editable region, menu, or pannable viewport.

In Select mode, clicking the blank page stage (outside every region) clears
the region selection and returns Properties to page context. Escape also
clears a non-modal selection. Neither action creates undo history.

## 4. Top bar

Use Blueprint `Navbar`, `Button`, `ButtonGroup`, `Tabs`, `Select`, and `Tag`.
The top bar contains:

- project name and dirty indicator;
- book and page navigation;
- workspace tabs;
- mode/tool selector;
- undo and redo with operation labels;
- preview-reader action;
- validation status; and
- Publish, disabled until validation and source-fingerprint checks pass.

Publishing always opens a review screen. It is never a one-click background
upload from the editing workspace.

## 5. Outliner

The Outliner follows the Blender distinction between hierarchy and selection:

```text
Project
|- Books
|  `- Banckes 1552
|     `- Page 37
|        |- p0037-r007  Decorated D opening Dragantia
|        `- p0037-r008  Ragwort continuation
`- Collections
   |- Needs review
   `- Decorated initials
```

The tree must virtualize books/pages/regions; the corpus is too large for a
fully mounted Blueprint `Tree`. Rows show source role, authored category,
modified state, warnings, visibility, and lock state. Search supports IDs,
names, classes, labels, source text, and diagnostics.

Click selects and activates. Ctrl/Cmd toggles selection. Shift selects a range
within the current page. A region may belong to many collections without
duplicating its data block.

## 6. Viewport

The central viewport keeps the scan and facsimile directly adjacent and shares
pan/zoom when both are shown. Controls toggle scan, facsimile, both, region
boxes, reading order, confidence, and category colors.

The active region has a clear outline and compact edge/corner transform
handles. Other selected regions use a quieter outline. Move/resize affordances
remain low-contrast until hover, focus, or active transform; they use icons and
tooltips instead of persistent text labels. Touch/coarse-pointer targets remain
large enough for access without visually dominating the page. Category color
is an overlay aid only and must not alter the published facsimile.

Pointer transforms are previews. The engine receives one confirmed transform
operator, not every pointer move. Numeric transform fields and keyboard nudging
provide equivalent non-pointer access.

## 7. Region context menu

Right-click selects/activates according to the rule in the engine spec, then
opens a Blueprint `Menu`. The keyboard Menu key and Shift+F10 open the identical
menu at the active region. A visible Properties button provides the same route.

Menu structure:

```text
Assign category >
  Recent
  Text >
  Visual >
  Navigation >
  Artifact >
  ----------------
  Clear authored category
  Create category...
Classes >                  (checkable; mixed state for multi-selection)
Labels >
Set display name...
---------------------------
Capital rendering >        (only when renderer poll succeeds)
  Auto
  Original
  Diplomatic text
  Modern text
  Hidden
---------------------------
View properties
Reveal in Outliner
Frame selected
Reset overrides >
```

Category search should show the hierarchy and recent choices. Assigning a
category or toggling a class across multiple regions is one transaction. Menu
items show `poll` failure reasons rather than duplicating validation logic.

Illuminated/decorated-initial controls are intentionally secondary: a short
conditional submenu and a collapsed Rendering section, never a global top-bar
feature.

## 8. Properties editor

The Properties editor follows current context and exposes component-owned
sections:

1. **Object** — immutable ID, source reference, origin, display name;
2. **Classification** — source role, category, classes, labels, collections;
3. **Content** — edition text, relations, continuation behavior;
4. **Typography** — font, size, weight, color, line height, character spacing,
   alignment, last-line alignment, justification method, and hyphenation;
5. **Transform** — normalized box, translation, scaling, alignment;
6. **Text layout** — fit, wrapping, overflow, width, minimum type scale;
7. **Rendering** — renderer-specific panels whose `poll` succeeds;
8. **Source and QA** — confidence, fingerprint, crop, warnings, review state.

At the top, an Apply-to selector chooses book, source role, category, page,
page role/category/class, or exact region. Unsupported scopes are omitted.

Each field distinguishes:

- effective value;
- authored value at the active scope;
- inherited source and layer;
- mixed multi-selection state; and
- validation/diagnostic state.

"Reset" removes only the active-scope value. It does not copy the inherited
value into the scope. Provenance opens a popover containing the full cascade.

Blueprint `FormGroup`, `NumericInput`, `HTMLSelect`, `TagInput`, `Switch`,
`Slider`, `Callout`, `Popover`, `Collapse`, and `Divider` fit these panels.

When no region is selected, Properties exposes page-owned settings rather than
an empty-state dead end. The Page Appearance section supports book or page
scope, matched-paper or solid-color mode, and optional procedural paper/fiber
texture with strength and scale. Solid color affects only the facsimile sheet;
the adjacent original scan is unchanged. Color controls must maintain readable
text contrast or surface an explicit warning and safe preview fallback.

## 9. Decorated-initial panel

Visible only when the active category (or an ancestor capability) supports the
decorated-initial renderer. It contains:

- representation: Auto, Original, Diplomatic text, Modern text, Hidden;
- edition-specific override controls;
- original crop/asset preview, fit, alignment, opacity, and multiply blending;
- explicit diplomatic and modern equivalents;
- continuation region and safe prefix-consumption fields;
- drop-line count, scale, placement, alignment, and spacing;
- accessibility: decorative toggle and description; and
- fallback and diagnostics.

Original preview must show the untouched source crop. Modernization is a text
equivalent, not a generated or repainted image.

## 10. Command search and automation

An F3-style command search lists registered operators allowed by current
context. It is useful for advanced workflows without making the permanent UI
dense. Operator names, parameters, and shortcuts come from the same registry
used by scripts and the CLI.

The editor exposes a read-only operation log with deterministic arguments and
affected data blocks. Copying an operation as JSON provides a reproducible
starting point for batch automation.

## 11. Status and diagnostics

The bottom bar shows active region, selection count, normalized coordinates,
source confidence, dirty state, current revision, background activity, and the
highest-severity diagnostic. Clicking diagnostics opens a filterable panel.

Severity:

- error: blocks publication;
- warning: requires review or publication-profile acceptance;
- info: useful provenance or fallback detail.

Saving local authoring state and publishing are separate statuses. "Saved"
must mean the atomic workspace write completed. "Published" must identify a
specific immutable revision or pull request.

## 12. Accessibility

- All context-menu actions are available by Shift+F10/Menu key and Properties.
- Outliner and region selection use standard multi-select semantics.
- Transform handles have numeric and keyboard equivalents.
- Focus returns predictably after closing menus, dialogs, modes, and previews.
- Screen-reader announcements cover active region, selection count, committed
  operations, save state, and validation changes.
- Renderer previews expose the semantic initial exactly once.
- Color never carries category, warning, or inheritance meaning by itself.

## 13. Initial vertical slice

The first usable Electron slice should prove the architecture with:

1. local project open/save;
2. book/page navigation and adjacent scan/facsimile viewport;
3. active/selected region context and Outliner synchronization;
4. right-click/Shift+F10 category, class, label, and Properties actions;
5. effective/inherited property display;
6. decorated-initial original/modern/diplomatic preview settings;
7. transactional undo/redo;
8. deterministic reader-projection preview; and
9. publication validation and dry-run bundle generation.
