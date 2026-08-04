# World Herb Library reading facsimiles

This repository publishes a static World Herb Library reading room for three
early printed herbals selected from `whl_catalog.csv`:

- Leonhart Fuchs, *De Historia Stirpium Commentarii Insignes* (Latin, 1542);
- *Herbarius zü Teütsch* (German, 1488; attributed to Johannes von Cuba and
  printed by Hans Schönsperger);
- *A Boke of the Propreties of Herbes* (archaic English, 1552; anonymous,
  Copland/Kele imprint).

The reader displays each source scan beside a modern-English facsimile built
from page-specific OCR geometry. Translation requests are isolated to one
physical page and return text under stable source-region IDs. Accepted text is
written directly to those IDs, eliminating post-hoc proportional
redistribution; this contract does not itself guarantee semantic accuracy.
Readers can switch between modern and
diplomatic OCR, reveal layout boxes, deep-link to any page, and inspect the
sampled QA report.

## Repository layout

- `index.html`, `reader.html`, `method.html` — the GitHub Pages application;
- `assets/` — accessible, dependency-free CSS and JavaScript;
- `data/reader-config.json` — fail-closed reader/editor feature configuration;
- `data/region-settings.json` — sparse, validated presentation and text
  overrides applied without changing source OCR page data;
- `schemas/region-settings.schema.json` — machine-readable published-settings
  structure (the runtime validator additionally enforces value bounds);
- `docs/REGION_EDITOR.md` — region-settings precedence, editing safety,
  persistence, import/export, and publication contract;
- `pipeline/process.py` — resumable OCR, translation, scan, thumbnail, paper
  color, and non-generative artwork build;
- `pipeline/qa.py` — every-page validation plus fixed sample overlays;
- `pipeline/publish_aws.py` — dry-run-first private S3 + CloudFront OAC
  publication;
- `pipeline/books.json` — pinned sources, hashes, sample pages, and reviewed
  editorial overrides;
- `scripts/release_smoke.py` — fail-closed local, CloudFront/CORS, and deployed
  Pages verification;
- `pipeline/whl_selection.csv` — the three selected catalogue rows, paired
  with the checksum and byte count of the full catalogue in `books.json`;
- `tests/pipeline/`, `tests/release/`, `tests/web/` — pipeline, publication,
  and static reader contract tests.

The generated 1,623-page asset corpus is not committed to Git. It is stored
under an immutable S3 version prefix and served through CloudFront; the small
catalogue on GitHub Pages points to those manifests.

## Reproduce the build

See [`pipeline/README.md`](pipeline/README.md) for phase-by-phase commands and
the artifact contract. The build pins `mistral-ocr-4-0` and
`mistral-large-2512`, records SHA-256 source hashes, and keys accepted,
normalized translation caches to the exact prompt and page input. Raw OCR
responses and rejected translation response content are retained separately;
accepted translation files are normalized provenance wrappers, not raw
chat-completions responses. Every JSON object, including each model-returned
region map, is decoded with duplicate-key rejection instead of silently keeping
the final repeated value. Scan-reviewed full-region replacements are overlaid
before cache validation and listed in `reviewed_region_ids`, so a later
model omission cannot erase editorially verified text.

Credentials are read only from the normal environment or AWS credential
chain. They are never accepted as command-line values or written to public
artifacts.

## Validate

```powershell
node --test tests\web\static-reader.test.mjs tests\web\region-settings.test.mjs
python -m unittest discover -s tests\pipeline
python -m unittest discover -s tests\release
python -m compileall -q pipeline scripts tests
```

Run `pipeline/qa.py --strict` after processing. Model confidence and embedded
PDF text are diagnostic signals, not empirical accuracy or ground truth; the
site labels all modern text as machine-assisted and keeps the scan visible.

## Reader and region editor

The production project configuration defaults to reader-only mode. Region
editing is initialized only when `features.regionEditor` in
`data/reader-config.json` is the literal JSON boolean `true`; a missing,
malformed, or differently typed value fails closed. This public static flag is
a feature gate, not authentication. The browser stores only local drafts and
exports validated JSON. It contains no AWS credentials and cannot publish
directly to S3, CloudFront, GitHub, or this repository.

Approved settings in `data/region-settings.json` remain visible to ordinary
readers and overlay, rather than mutate, immutable OCR page JSON. Values resolve
from book to region type to page to page-specific region type to individual
region. See [`docs/REGION_EDITOR.md`](docs/REGION_EDITOR.md) for the schema,
validation rules, draft persistence, import/export, programmatic API, and
review workflow.

## Provenance and reuse

Every book manifest links to its World Herb Library record, source PDF,
checksum, byte count, an independent bibliographic record, and the processing
models. The underlying printed works are centuries old, but an exact
institutional scan can carry a separate reuse statement. Downstream publishers
should verify the terms associated with the linked source and bibliographic
records.

The MIT [`LICENSE`](LICENSE) covers repository software and documentation only
to the extent the named copyright holder and contributors have rights to
license them. It does not relicense the historical works, third-party scans,
catalog metadata, institutional marks, or generated derivatives of those
scans. See [`NOTICE.md`](NOTICE.md) for source-material, generated-artifact, and
service notices.
