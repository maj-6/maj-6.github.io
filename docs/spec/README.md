# Editor architecture specifications

These documents define the design-first transition from the transitional web
editor to a dedicated Electron authoring application:

- [`ENGINE_V2.md`](ENGINE_V2.md) — data blocks, taxonomy, context, operators,
  component and renderer registries, cascade, provenance, migration, and reader
  compilation;
- [`EDITOR_UX.md`](EDITOR_UX.md) — BlueprintJS workspace structure, Outliner,
  viewport, Properties editor, context menu, keyboard access, and initial
  vertical slice;
- [`PUBLISHING.md`](PUBLISHING.md) — Electron process isolation, atomic local
  persistence, review-first GitHub publication, and AWS asset staging; and
- [`../ILLUMINATED_CAPITALS.md`](../ILLUMINATED_CAPITALS.md) — audited corpus
  evidence and the detailed decorated/illuminated-initial asset and renderer
  contract.

The specifications are normative for the v2 engine. The existing
`whl-region-settings/1` browser engine remains a compatibility and migration
source until the Electron editor and compiled reader runtime reach parity.
