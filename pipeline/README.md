# World Herb Library facsimile pipeline

This directory contains the reproducible build used by the three public demo
books. It treats OCR output as evidence, never as a replacement for the scan.
Raw OCR responses, normalized page records, accepted translation caches,
rejected translation response content, scan derivatives, and QA summaries
remain separate artifacts.

## What the build records

- the catalog row, source URL, byte count, page count, and source SHA-256,
  plus a three-row selection snapshot and checksum/byte count for the full
  `whl_catalog.csv` used to select it;
- the exact OCR model (`mistral-ocr-4-0`) and translation model
  (`mistral-large-2512`);
- one raw, resumable OCR response per 50-page range;
- paragraph-level boxes normalized to the page, their reading order, role,
  and confidence;
- diplomatic OCR and a separate translated/normalized text layer: every API
  request is isolated to one physical page, and every result is keyed directly
  to the stable ID of its source OCR region;
- one normalized, accepted translation cache per physical page, keyed by stable
  source-region ID and bound to the exact model, strategy, prompt hash, input
  hash, and source checksum;
- rejected translation response content and usage metadata retained separately
  for audit;
- page-matched WebP scans, thumbnails, sampled paper/ink colors, and a
  transparent art layer that retains unboxed woodcuts and ornaments;
- automated QA plus a fixed, stratified visual-review sample.

Strict QA verifies the source PDF's byte count, SHA-256, and page count, then
records a release fingerprint over the current book config, annotations,
normalized page records, and every scan, thumbnail, and art-layer byte. Final
assembly accepts only a current `ready` or `ready_with_warnings` report whose
reported sample pages exactly match configuration.

The processing scripts read credentials only from environment variables. Keys
are never accepted as command-line options and never written to artifacts.

`whl_selection.csv` preserves the catalogue's own author cells as evidence.
The reading-edition metadata follows the linked bibliographic records instead:
Hans Schönsperger is identified as the German edition's printer and Johannes
von Cuba as its attributed compiler, while the 1552 English herbal is treated
as anonymous rather than attributed to Richard Banckes.

## Accepted page-translation cache

For page `NNNN`, the source regions live in `pages/NNNN.json`, the accepted
cache lives in `raw/page_translation/NNNN.json`, and rejected attempts live in
`raw/rejected_page_translation/`. The accepted cache is deliberately not a raw
chat-completions response. It is a normalized
`whl-facsimile-independent-page-region-translation/3` wrapper containing the
validated `region-id -> modern text` map, provenance hashes, and usage
metadata. If a page required focused repair calls, their usage is recorded as
supplemental usage in the same accepted wrapper. An unsuccessful focused
repair response is retained beside the rejected page attempts rather than
discarded.

Before reuse and again before modern text is applied to normalized page
records, the pipeline recomputes the page input and prompt hashes and validates
the cache's schema, model, strategy, source checksum, physical page, and exact
region-ID set. Structural catchwords, footers, and signature marks are excluded
from Mistral and copied verbatim. Reviewed `modern_text_overrides` are applied
only after the accepted cache has been written into the normalized page
records.

Acceptance guards reject missing or extra IDs, duplicate output, gross text
conservation failures, unchanged long source-language prose, protected numeral
or authority loss, and some incorrectly closed fragments. A long region is
also rejected when its canonical target length is below 0.40 or above 2.0
times its source length, as are distinct neighboring sources when one modern
target wholly swallows the other. These are qualified allocation guards, not
proof of translation accuracy. They cannot reliably detect every
mistranslation, OCR-induced error, omission, or clause moved between
neighboring regions; sampled review and documented overrides remain part of
the process.

## Run

The recorded reference toolchain is CPython 3.11.2 and Node 22.16.0. The
requirements file pins the direct and transitive Python packages observed in
that environment. The tests use only standard-library `unittest` and Node's
built-in test runner, so there is no separate test dependency set. Always use
`python -m pip` so installation uses the same interpreter as the pipeline.

```powershell
python -m pip install -r pipeline/requirements.txt
$env:MISTRAL_API_KEY = "..."
python pipeline/process.py all `
  --config pipeline/books.json `
  --source-dir C:\path\to\source-pdfs `
  --work-dir C:\path\to\work `
  --public-dir C:\path\to\public-assets `
  --workers 6
```

This `all` example intentionally omits `--assets-base-url` and is for a local
build and QA run only. Its generated URLs are relative, and it does not write
the GitHub Pages `data/catalog.json`; do not upload it as the final CloudFront
release. The hosting sequence below performs the publish-ready assembly after
CloudFront exists and strict QA has passed.

Every phase can run independently: `download`, `ocr`, `assets`, `translate`,
`assemble`, or `all`. Add `--book fuchs-1542` to run one book. Re-running is
safe: valid source files, OCR ranges, translations, and page derivatives are
reused. `--force` invalidates phase outputs deliberately.

Run QA after assembly:

```powershell
python pipeline/qa.py `
  --config pipeline/books.json `
  --source-dir C:\path\to\source-pdfs `
  --work-dir C:\path\to\work `
  --public-dir C:\path\to\public-assets `
  --strict
```

`--strict` writes the same reports and overlays as the normal QA run, then
exits with status 2 if any book has a blocking condition. A strict pass means
the expected normalized records, accepted-cache provenance, and published
assets are complete and structurally valid; it is not a claim of empirical OCR
or translation accuracy.

## Why the illustration layer is not generative

OCR 4 detects many woodcuts, but not all: a full-page Fuchs plant can return
only its tiny labels. The build therefore makes an **art remainder** from the
source scan. It removes padded OCR text boxes, converts only paper-like pixels
to transparency, and leaves the remaining ink and color untouched. The reader
composites that layer over the page's sampled paper color with multiply blend.
This preserves the original mark-making and avoids inventing botanical detail.

## Hosting with AWS

`publish_aws.py` provisions a private, encrypted S3 origin and CloudFront
Origin Access Control, then uploads immutable book assets. Only the small
catalog/manifest files receive short cache lifetimes. The bucket remains
private; GitHub Pages is allowed by CORS, while CloudFront is the only read
path. Mutation commands are dry runs unless `--apply` is present.
The upload command also fails closed unless the local catalog, book
directories, complete page assets, manifests, QA reports, ready statuses,
current QA contract, exact QA implementation hashes, annotations, and book
configuration form one consistent release tree.

CloudFront must be bootstrapped before the final assembly because the
distribution URL and immutable version prefix are embedded in the catalog and
book manifests. Strict QA must run against the local assembly first. The final
assembly then validates the QA report against the source provenance and release
fingerprint before it emits reviewed status and a report URL. Upload only after
that final assembly:

```powershell
$AwsState = "C:\safe\whl-aws.json"
$SourceDir = "C:\path\to\source-pdfs"
$WorkDir = "C:\path\to\work"
$PublicDir = "C:\path\to\public-assets"
$VersionPrefix = "v1"

# 1. Inspect the AWS plan, apply it deliberately, and verify deployment state.
python pipeline/publish_aws.py bootstrap `
  --state $AwsState `
  --version-prefix $VersionPrefix
python pipeline/publish_aws.py bootstrap `
  --state $AwsState `
  --version-prefix $VersionPrefix `
  --apply
python pipeline/publish_aws.py status --state $AwsState

# 2. Read the exact CloudFront/version URL written by bootstrap.
$AssetsBaseUrl = (
  Get-Content -LiteralPath $AwsState -Raw | ConvertFrom-Json
).assets_base_url
if (-not $AssetsBaseUrl) { throw "AWS state has no assets_base_url" }

# 3. Block publication unless the local assembly passes strict QA.
python pipeline/qa.py `
  --config pipeline/books.json `
  --source-dir $SourceDir `
  --work-dir $WorkDir `
  --public-dir $PublicDir `
  --strict
if ($LASTEXITCODE -ne 0) { throw "Strict QA failed" }

# 4. Reassemble with absolute URLs; this incorporates the validated QA report.
New-Item -ItemType Directory -Path data -Force | Out-Null
python pipeline/process.py assemble `
  --config pipeline/books.json `
  --source-dir $SourceDir `
  --work-dir $WorkDir `
  --public-dir $PublicDir `
  --assets-base-url $AssetsBaseUrl `
  --require-ready-qa `
  --catalog-output data/catalog.json

# 5. Inspect the upload plan, upload that exact directory, and verify AWS state.
python pipeline/publish_aws.py upload `
  --state $AwsState `
  --public-dir $PublicDir
python pipeline/publish_aws.py upload `
  --state $AwsState `
  --public-dir $PublicDir `
  --apply
python pipeline/publish_aws.py status --state $AwsState

# 6. Verify all three live CDN manifests, representative data, scans, and CORS.
python scripts/release_smoke.py --root . predeploy
```

Keep `$VersionPrefix`, the state file's `assets_base_url`, assembly, and upload
in one release sequence. If source provenance, configuration, annotations,
normalized pages, scans, thumbnails, or art layers change after QA, the final
assembly drops reviewed status; rerun strict QA and assembly before uploading.
If a changed object would overwrite an immutable key, use a new version prefix
rather than `--allow-version-overwrite`. See `python pipeline/publish_aws.py
--help` for optional profile and bucket flags.

## Limits and review policy

Mistral boxes are paragraph-level, not word- or line-level. A sentence may be
split at a column turn. The translator therefore receives all reading-ordered
regions from one page as context, but must return modern text under each
region's original ID and preserve unfinished fragment boundaries. There is no
post-hoc proportional redistribution. This retains the region architecture and
makes some structural omissions, duplicates, and shifted protected anchors
mechanically detectable, but the model can still mistranslate or move meaning
across a region boundary. Historical role labels are treated as hints and
refined with geometry. Model confidence and agreement with a pre-existing OCR
layer are diagnostic signals, not ground truth. The demo therefore labels its
text as machine-assisted and links its QA report; readers can always compare
the scan beside the facsimile.

The facsimile font stacks use broadly available book serifs and preserve the
source page's measured scale, alignment, hierarchy, and sampled paper tone.
Sampled ink is used when it provides at least 4.5:1 text contrast; otherwise
the reader shifts only the facsimile text toward black or white until that
floor is reached. It does not download a blackletter webfont or claim a
glyph-for-glyph type reconstruction; the adjacent scan remains the record of
the original type.
