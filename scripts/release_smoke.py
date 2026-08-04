#!/usr/bin/env python3
"""Fail-closed, read-only smoke checks for the WHL static release."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen


EXPECTED_BOOK_COUNT = 3
DEFAULT_CDN_BASE = "https://d3hgn3a6vd7iau.cloudfront.net/v2"
DEFAULT_ORIGIN = "https://maj-6.github.io"
DEFAULT_SITE_URL = "https://maj-6.github.io/"
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
POSTDEPLOY_PATHS = (
    "index.html",
    "reader.html",
    "method.html",
    "assets/reader.js",
    "assets/reader.css",
    "data/catalog.json",
)
POSTDEPLOY_CONTENT_TYPES = {
    ".html": frozenset({"text/html"}),
    ".js": frozenset({"application/javascript", "text/javascript"}),
    ".css": frozenset({"text/css"}),
    ".json": frozenset({"application/json"}),
}


class SmokeCheckError(RuntimeError):
    """A release invariant was not satisfied."""


@dataclass(frozen=True)
class HttpResult:
    requested_url: str
    final_url: str
    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytes

    def header_values(self, name: str) -> list[str]:
        expected = name.casefold()
        return [value for key, value in self.headers if key.casefold() == expected]


Fetcher = Callable[[str, str | None], HttpResult]


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def load_json_object(path: Path) -> dict:
    if not path.is_file():
        raise SmokeCheckError(f"required committed file is missing: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SmokeCheckError(f"cannot read JSON object {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise SmokeCheckError(f"expected a JSON object in {path}")
    return value


def _book_ids(document: dict, label: str) -> list[str]:
    books = document.get("books")
    if not isinstance(books, list):
        raise SmokeCheckError(f"{label} must contain a books array")
    ids = [book.get("id") if isinstance(book, dict) else None for book in books]
    if any(not isinstance(book_id, str) or not book_id for book_id in ids):
        raise SmokeCheckError(f"{label} contains a book without a non-empty string id")
    if len(ids) != len(set(ids)):
        raise SmokeCheckError(f"{label} contains duplicate book ids: {ids}")
    return ids


def validate_local_release(root: Path) -> tuple[dict, dict]:
    """Validate committed release metadata without making network requests."""
    config = load_json_object(root / "pipeline" / "books.json")
    catalog = load_json_object(root / "data" / "catalog.json")
    configured_ids = _book_ids(config, "pipeline/books.json")
    catalog_ids = _book_ids(catalog, "data/catalog.json")

    if len(configured_ids) != EXPECTED_BOOK_COUNT:
        raise SmokeCheckError(
            f"pipeline/books.json must configure exactly {EXPECTED_BOOK_COUNT} books; "
            f"found {len(configured_ids)}"
        )
    if catalog_ids != configured_ids:
        raise SmokeCheckError(
            "data/catalog.json book ids/order do not match pipeline/books.json: "
            f"configured={configured_ids}, catalog={catalog_ids}"
        )

    config_by_id = {book["id"]: book for book in config["books"]}
    for entry in catalog["books"]:
        book_id = entry["id"]
        configured = config_by_id[book_id]
        for field in ("pages", "cover_page"):
            if entry.get(field) != configured.get(field):
                raise SmokeCheckError(
                    f"catalog {book_id!r} field {field!r} does not match configuration"
                )
        for field in ("manifest", "cover"):
            if not isinstance(entry.get(field), str) or not entry[field]:
                raise SmokeCheckError(f"catalog {book_id!r} has no valid {field} URL")
    return config, catalog


def _url_scope(url: str) -> tuple[str, str, str]:
    parsed = urlsplit(url)
    return parsed.scheme.casefold(), parsed.netloc.casefold(), parsed.path


def require_scoped_url(
    url: str,
    base_url: str,
    *,
    label: str,
    require_https: bool,
) -> None:
    scheme, authority, path = _url_scope(url)
    base_scheme, base_authority, base_path = _url_scope(base_url)
    if require_https and scheme != "https":
        raise SmokeCheckError(f"{label} is not HTTPS: {url}")
    if scheme != base_scheme or authority != base_authority:
        raise SmokeCheckError(f"{label} escaped the expected origin {base_url}: {url}")
    prefix = base_path.rstrip("/") + "/"
    if not path.startswith(prefix):
        raise SmokeCheckError(f"{label} escaped the expected path {base_url}: {url}")


def require_success(result: HttpResult, label: str) -> None:
    if not 200 <= result.status < 300:
        raise SmokeCheckError(
            f"{label} returned HTTP {result.status}: {result.requested_url}"
        )


def require_exact_cors(result: HttpResult, origin: str, label: str) -> None:
    values = [value.strip() for value in result.header_values("Access-Control-Allow-Origin")]
    if values != [origin]:
        shown = values if values else "missing"
        raise SmokeCheckError(
            f"{label} must return exactly Access-Control-Allow-Origin: {origin}; got {shown}"
        )


def json_from_result(result: HttpResult, label: str) -> dict:
    try:
        value = json.loads(result.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SmokeCheckError(f"{label} did not return valid UTF-8 JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise SmokeCheckError(f"{label} did not return a JSON object")
    return value


def default_fetch(url: str, origin: str | None, *, timeout: float = 20.0) -> HttpResult:
    headers = {
        "Accept": "*/*",
        "Cache-Control": "no-cache",
        "User-Agent": "whl-release-smoke/1",
    }
    if origin is not None:
        headers["Origin"] = origin
    request = Request(url, headers=headers, method="GET")
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise SmokeCheckError(
                    f"response exceeds {MAX_RESPONSE_BYTES} bytes: {url}"
                )
            return HttpResult(
                requested_url=url,
                final_url=response.geturl(),
                status=response.status,
                headers=tuple(response.headers.items()),
                body=body,
            )
    except HTTPError as exc:
        raise SmokeCheckError(f"HTTP {exc.code} while requesting {url}") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise SmokeCheckError(f"request failed for {url}: {exc}") from exc


def _render_pattern(pattern: object, page: int, label: str) -> str:
    if not isinstance(pattern, str) or pattern.count("{page}") != 1:
        raise SmokeCheckError(f"{label} must contain exactly one {{page}} placeholder")
    return pattern.replace("{page}", f"{page:04d}")


def _fetch_cdn_resource(
    fetch: Fetcher,
    url: str,
    *,
    origin: str,
    cdn_base: str,
    label: str,
    require_https: bool,
) -> HttpResult:
    require_scoped_url(url, cdn_base, label=label, require_https=require_https)
    result = fetch(url, origin)
    require_success(result, label)
    require_scoped_url(
        result.final_url,
        cdn_base,
        label=f"{label} final URL",
        require_https=require_https,
    )
    require_exact_cors(result, origin, label)
    return result


def validate_cdn_release(
    root: Path,
    *,
    origin: str = DEFAULT_ORIGIN,
    cdn_base: str = DEFAULT_CDN_BASE,
    fetch: Fetcher = default_fetch,
    require_https: bool = True,
) -> list[str]:
    """Validate every configured book's live manifest and representative assets."""
    config, catalog = validate_local_release(root)
    config_by_id = {book["id"]: book for book in config["books"]}
    checked: list[str] = []

    for entry in catalog["books"]:
        book_id = entry["id"]
        configured = config_by_id[book_id]
        manifest_result = _fetch_cdn_resource(
            fetch,
            entry["manifest"],
            origin=origin,
            cdn_base=cdn_base,
            label=f"{book_id} manifest",
            require_https=require_https,
        )
        manifest = json_from_result(manifest_result, f"{book_id} manifest")
        if manifest.get("id") != book_id:
            raise SmokeCheckError(f"{book_id} manifest returned id {manifest.get('id')!r}")
        if manifest.get("pages") != configured.get("pages"):
            raise SmokeCheckError(f"{book_id} manifest page count is stale or incorrect")

        representative_page = configured["cover_page"]
        data_url = _render_pattern(
            manifest.get("data_pattern"),
            representative_page,
            f"{book_id} data_pattern",
        )
        scan_url = _render_pattern(
            manifest.get("page_pattern"),
            representative_page,
            f"{book_id} page_pattern",
        )
        if scan_url != entry["cover"]:
            raise SmokeCheckError(
                f"{book_id} catalog cover does not match its manifest page pattern"
            )

        page_result = _fetch_cdn_resource(
            fetch,
            data_url,
            origin=origin,
            cdn_base=cdn_base,
            label=f"{book_id} representative page JSON",
            require_https=require_https,
        )
        page_data = json_from_result(page_result, f"{book_id} representative page JSON")
        if page_data.get("page") != representative_page:
            raise SmokeCheckError(
                f"{book_id} representative page JSON returned page {page_data.get('page')!r}"
            )

        scan_result = _fetch_cdn_resource(
            fetch,
            scan_url,
            origin=origin,
            cdn_base=cdn_base,
            label=f"{book_id} representative scan",
            require_https=require_https,
        )
        content_types = scan_result.header_values("Content-Type")
        if len(content_types) != 1 or content_types[0].split(";", 1)[0].strip() != "image/webp":
            raise SmokeCheckError(
                f"{book_id} representative scan must be served as image/webp"
            )
        if not (
            len(scan_result.body) >= 12
            and scan_result.body[:4] == b"RIFF"
            and scan_result.body[8:12] == b"WEBP"
        ):
            raise SmokeCheckError(f"{book_id} representative scan is not a WebP payload")
        checked.append(book_id)
    return checked


def _cache_bust(url: str, token: str, attempt: int) -> str:
    parsed = urlsplit(url)
    query = parse_qsl(parsed.query, keep_blank_values=True)
    query.append(("release-smoke", f"{token}-{attempt}"))
    return urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment)
    )


def _expected_site_files(root: Path) -> dict[str, bytes]:
    expected: dict[str, bytes] = {}
    for relative_path in POSTDEPLOY_PATHS:
        path = root / relative_path
        if not path.is_file():
            raise SmokeCheckError(f"required committed site file is missing: {path}")
        expected[relative_path] = path.read_bytes()
    return expected


def validate_deployed_pages(
    root: Path,
    *,
    site_url: str = DEFAULT_SITE_URL,
    attempts: int = 12,
    retry_delay: float = 10.0,
    cache_bust: str = "release",
    fetch: Fetcher = default_fetch,
    sleep: Callable[[float], None] = time.sleep,
    require_https: bool = True,
) -> list[str]:
    """Retry until all key Pages files exactly match the committed bytes."""
    validate_local_release(root)
    if attempts < 1:
        raise SmokeCheckError("postdeploy attempts must be at least 1")
    if retry_delay < 0:
        raise SmokeCheckError("postdeploy retry delay cannot be negative")
    expected = _expected_site_files(root)
    base = site_url.rstrip("/") + "/"
    last_errors: list[str] = []

    for attempt in range(1, attempts + 1):
        errors: list[str] = []
        for relative_path, expected_body in expected.items():
            canonical_url = urljoin(base, relative_path)
            requested_url = _cache_bust(canonical_url, cache_bust, attempt)
            try:
                require_scoped_url(
                    canonical_url,
                    base,
                    label=f"Pages {relative_path}",
                    require_https=require_https,
                )
                result = fetch(requested_url, None)
                require_success(result, f"Pages {relative_path}")
                require_scoped_url(
                    result.final_url,
                    base,
                    label=f"Pages {relative_path} final URL",
                    require_https=require_https,
                )
                suffix = Path(relative_path).suffix.lower()
                allowed_types = POSTDEPLOY_CONTENT_TYPES.get(suffix)
                content_types = result.header_values("Content-Type")
                media_type = (
                    content_types[0].split(";", 1)[0].strip().lower()
                    if len(content_types) == 1
                    else ""
                )
                if allowed_types and media_type not in allowed_types:
                    raise SmokeCheckError(
                        f"Pages {relative_path} has unsafe Content-Type {content_types!r}; "
                        f"expected one of {sorted(allowed_types)}"
                    )
                if result.body != expected_body:
                    raise SmokeCheckError(
                        f"Pages {relative_path} is stale: expected sha256 "
                        f"{sha256_bytes(expected_body)}, got {sha256_bytes(result.body)}"
                    )
            except SmokeCheckError as exc:
                errors.append(str(exc))
        if not errors:
            return list(expected)
        last_errors = errors
        if attempt < attempts:
            sleep(retry_delay)

    detail = "\n  - ".join(last_errors)
    raise SmokeCheckError(
        f"Pages did not converge after {attempts} attempts:\n  - {detail}"
    )


def _fetcher_with_timeout(timeout: float) -> Fetcher:
    return lambda url, origin: default_fetch(url, origin, timeout=timeout)


def _add_common_network_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument(
        "--allow-http",
        action="store_true",
        help="Allow HTTP test servers; never use this option in release CI.",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    subparsers = parser.add_subparsers(dest="command", required=True)

    local = subparsers.add_parser("local", help="Run committed-file checks only")
    local.set_defaults(action="local")

    predeploy = subparsers.add_parser(
        "predeploy", help="Validate committed metadata and read live CDN assets"
    )
    predeploy.add_argument("--origin", default=DEFAULT_ORIGIN)
    predeploy.add_argument("--cdn-base", default=DEFAULT_CDN_BASE)
    predeploy.add_argument(
        "--offline",
        action="store_true",
        help="Run only committed-file checks (for local/offline verification).",
    )
    _add_common_network_options(predeploy)
    predeploy.set_defaults(action="predeploy")

    postdeploy = subparsers.add_parser(
        "postdeploy", help="Retry-read the deployed GitHub Pages release"
    )
    postdeploy.add_argument("--site-url", default=DEFAULT_SITE_URL)
    postdeploy.add_argument("--attempts", type=int, default=12)
    postdeploy.add_argument("--retry-delay", type=float, default=10.0)
    postdeploy.add_argument(
        "--cache-bust",
        default=os.environ.get("GITHUB_SHA", str(time.time_ns())),
    )
    _add_common_network_options(postdeploy)
    postdeploy.set_defaults(action="postdeploy")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = args.root.resolve()
    try:
        if args.action == "local":
            _, catalog = validate_local_release(root)
            checked = _book_ids(catalog, "data/catalog.json")
            print(f"Local release metadata is valid for: {', '.join(checked)}")
        elif args.action == "predeploy" and args.offline:
            _, catalog = validate_local_release(root)
            checked = _book_ids(catalog, "data/catalog.json")
            print(f"Offline release metadata is valid for: {', '.join(checked)}")
        elif args.action == "predeploy":
            checked = validate_cdn_release(
                root,
                origin=args.origin,
                cdn_base=args.cdn_base,
                fetch=_fetcher_with_timeout(args.timeout),
                require_https=not args.allow_http,
            )
            print(f"CDN release smoke checks passed for: {', '.join(checked)}")
        else:
            checked = validate_deployed_pages(
                root,
                site_url=args.site_url,
                attempts=args.attempts,
                retry_delay=args.retry_delay,
                cache_bust=args.cache_bust,
                fetch=_fetcher_with_timeout(args.timeout),
                require_https=not args.allow_http,
            )
            print(f"GitHub Pages serves committed bytes for: {', '.join(checked)}")
    except SmokeCheckError as exc:
        print(f"release smoke check failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
