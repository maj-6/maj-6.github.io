# Electron publication and security specification

Status: draft implementation contract

## 1. Trust boundary

The Electron renderer is untrusted presentation code. It may display project
projections and request registered operators. It must never receive raw
filesystem, shell, GitHub, AWS, process, or credential access.

Required Electron settings:

- `nodeIntegration: false`;
- `contextIsolation: true`;
- `sandbox: true`;
- `webSecurity: true`;
- denied permissions by default;
- blocked arbitrary navigation and window creation;
- a restrictive Content Security Policy; and
- a narrow `contextBridge` API with validated request/response objects.

The main process validates the IPC sender, project/revision identity, payload
schema, source fingerprint, paths, and optimistic base revision. It uses fixed
argument arrays with `shell: false` for any approved subprocess. Project data
must never be interpolated into a shell command.

## 2. Product separation

GitHub Pages contains only:

- reader HTML/CSS;
- a read-only runtime and reader-safe renderers;
- the compiled reader publication and catalog metadata; and
- public, immutable source assets or URLs.

It excludes the Electron application, authoring schemas not needed at runtime,
mutation operators, persistence adapters, desktop IPC, publication clients,
and cloud SDKs. The Pages workflow stages an explicit allowlist instead of
uploading the repository root.

The existing web editor is transitional. When the Electron vertical slice is
usable, production `features.regionEditor` returns to `false`, and the browser
mutation surface is removed from the generated reader bundle.

## 3. Local persistence

An Electron workspace is the source of truth for unsubmitted edits. Main owns
all reads and writes. Each write:

1. validates the document and expected revision;
2. writes a sibling temporary file in the same filesystem;
3. flushes file content and necessary directory metadata;
4. atomically renames it over the target; and
5. appends a checksummed transaction journal entry.

Paths are resolved and constrained to the opened workspace. Symlinks, Windows
junctions/reparse points, traversal, device names, and unexpected file types
are rejected. Failed writes leave the prior valid snapshot intact and surface
a blocking status.

## 4. Compile and review

"Publish" always starts with a local, read-only compilation:

1. resolve and validate taxonomy, components, and source fingerprints;
2. validate renderer assets, fallbacks, and accessibility;
3. compile canonical `whl-reader-publication/1` bytes;
4. hash every artifact and build a manifest;
5. compare against the selected base revision;
6. render a human-readable settings/text/asset diff and QA sample; and
7. require explicit confirmation for the named destination and revision.

The reader projection serializes reader-safe page-target components once on
each page object and region-target components on individual regions. Page
appearance accepts only validated opaque colors and fixed procedural texture
tokens; it never carries file paths, URLs, arbitrary CSS, or altered scan
pixels into the Pages bundle.

The authoring project is never uploaded as the reader publication. Credentials,
workspaces, local paths, history, private labels, and optional editor-only
extensions are excluded by construction.

## 5. GitHub publication

The initial production path is review-first:

1. Main stages the compiled settings in a validated local repository clone.
2. It invokes an authenticated `gh` executable with fixed arguments and
   `shell: false`, or calls a narrowly scoped publishing service.
3. It creates a branch and draft pull request containing the canonical reader
   projection, asset manifest, source-fingerprint report, and QA summary.
4. Required CI validates migration, schema, reader output, assets, and visual
   samples.
5. Merge deploys GitHub Pages through the existing protected workflow.

No personal token is stored in a project. The application uses the user's
credential manager-backed `gh` session or an external OAuth/service flow.

## 6. AWS responsibilities

AWS is appropriate for large immutable assets and optional draft/review sync,
not for embedding long-lived credentials in Electron.

Recommended production design:

- S3 versioning and immutable content-addressed prefixes for scans, page data,
  addressable capital crops/masks, and compiled revisions;
- CloudFront for public immutable delivery;
- GitHub Actions OIDC with a least-privilege AWS role for final asset upload;
- an optional API Gateway/Lambda validation service for team draft submission;
- short-lived user authentication for that service (for example, Cognito or
  organization SSO); and
- Secrets Manager for a server-side GitHub App credential if the service
  creates pull requests.

Electron may upload only to a server-issued, revision-scoped staging target.
Server-side code revalidates hashes, schemas, size/count limits, authorization,
and base revision. Promotion copies or points to immutable verified content; it
does not overwrite existing immutable keys.

## 7. Concurrency and audit

Every publish request includes:

- project ID;
- local revision and base publication revision;
- canonical content hash;
- source library fingerprints;
- author identity supplied by the authenticated publisher;
- validation/QA report hash; and
- requested channel/destination.

Promotion uses an ETag/base-revision comparison. A stale base fails with a
merge/review workflow; last-write-wins is forbidden. The service records an
append-only audit event for submission, validation, review, promotion, and
rollback.

## 8. Rollback and recovery

Reader publications and assets are immutable. A channel pointer or Git commit
selects the active revision. Rollback selects a previously validated revision;
it does not mutate or reconstruct assets. Local editor recovery replays the
checksummed journal from the last valid checkpoint and reports any truncated or
invalid tail without discarding the checkpoint.

## 9. Required security and publication tests

- malformed IPC, wrong sender, stale revision, and oversized payload rejection;
- workspace path traversal, symlink/junction, device path, and extension checks;
- navigation, new-window, permission, CSP, sandbox, and context-isolation tests;
- renderer bundle contains no Node/Electron/AWS/GitHub capability;
- reader artifact contains no editor source or mutation API;
- deterministic compilation and content hashing;
- required-extension, taxonomy-reference, asset-hash, source-drift, and
  accessibility blockers;
- publication dry run with no external mutation;
- fixed-argument `gh` invocation and explicit destination confirmation;
- stale ETag/base revision rejection; and
- immutable-key refusal and previous-revision rollback.
