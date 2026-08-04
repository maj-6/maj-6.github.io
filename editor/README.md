# World Herb Library desktop editor

This directory contains the first Electron authoring prototype for World Herb
Library facsimiles. The public GitHub Pages application remains a reader; this
desktop application is the intended home for trusted authoring workflows.

## Current prototype scope

The current vertical slice demonstrates:

- a React and BlueprintJS desktop shell with a Blender-inspired context model,
  Outliner, adjacent source/facsimile viewport, Properties editor, and status
  bar;
- synchronized page and region selection;
- region display names, categories, project classes, labels, text, typography,
  and normalized geometry controls;
- identical right-click and Shift+F10 region menus;
- secondary decorated-initial rendering controls with book, page, and region
  overrides for original, diplomatic, modern, automatic, and hidden
  representations; and
- operator-based mutations with an in-memory undo/redo facade.

The renderer calls operators rather than mutating project data directly. Its
small adapter translates UI intents to `createFacsimileEngine`; canonical
project state, the property cascade, history, and reader compilation remain
authoritative in the shared engine. The adapter is an integration seam, not a
second mutation or history implementation.

## Run it locally

Node.js 22.12 or newer is required.

```text
cd editor
npm ci
npm run dev
```

`npm run dev` starts the loopback-only Vite server and Electron together. To
run the production renderer through the application protocol instead:

```text
npm run build
npm start
```

Validation commands:

```text
npm test
npm run build
```

## Security boundary

Electron runs the renderer with sandboxing and context isolation enabled and
Node integration disabled. The renderer receives only a frozen `getAppInfo`
method from the preload bridge; it has no direct filesystem, shell, Git, AWS,
or raw IPC access. The main process additionally:

- accepts development content only from the exact
  `http://127.0.0.1:5173/` origin;
- serves production assets through a private application protocol with
  traversal and symlink-escape checks;
- denies permissions, downloads, webviews, new windows, and untrusted
  navigation; and
- uses an isolated in-memory Electron session.

Future workspace I/O and publication operations must remain in the main
process behind narrow, validated IPC contracts. Cloud credentials must never
be exposed to the renderer.

## Demo-data limitation

The application currently loads a small, in-memory project from
[`src/model/demo-project.js`](src/model/demo-project.js). Its two representative
Fuchs pages and source-scan treatment are UI fixtures, not live corpus scans or
Mistral OCR output. Authored changes last only for the current application
session. Opening real projects, atomic local saves, asset loading, migrations,
and recovery are not implemented in this prototype.

## Engine and design contracts

The reusable, dependency-free engine is under
[`../packages/facsimile-engine`](../packages/facsimile-engine) and is consumed
as the local `@whl/facsimile-engine` package. The Blueprint UI projects its
immutable canonical v2 document without placing renderer-only state into the
project. Further integration should follow the normative specifications:

- [Engine v2](../docs/spec/ENGINE_V2.md)
- [Electron editor UX](../docs/spec/EDITOR_UX.md)
- [Publishing and process isolation](../docs/spec/PUBLISHING.md)
- [Decorated and illuminated capitals](../docs/ILLUMINATED_CAPITALS.md)

Cloud publication is specified but not yet implemented. The intended workflow
uses validated local compilation, review-first GitHub publication, and AWS for
appropriate immutable assets; the current disabled Publish control performs no
network or repository mutation.
