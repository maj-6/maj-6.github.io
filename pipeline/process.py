#!/usr/bin/env python3
"""Resumable OCR, translation, and facsimile-asset build.

The public demo uses stable document URLs, so OCR is sent in explicit page
ranges instead of uploading the same PDF for every page. Local PDFs remain the
authority for checksums and rendering. Credentials are environment-only.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import random
import re
import tempfile
import time
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

import fitz
import numpy as np
import requests
from PIL import Image


PIPELINE_VERSION = "1.3.5"
ART_PIPELINE_VERSION = "1.2.0"
QA_CONTRACT_VERSION = "1.1.1"
RELEASE_QA_STATUSES = frozenset({"ready", "ready_with_warnings"})
OCR_MODEL = "mistral-ocr-4-0"
TRANSLATION_MODEL = "mistral-large-2512"
TRANSLATION_SCHEMA = "whl-facsimile-independent-page-region-translation/3"
TRANSLATION_STRATEGY = "independent-page-region-v3"
OCR_ENDPOINT = "https://api.mistral.ai/v1/ocr"
CHAT_ENDPOINT = "https://api.mistral.ai/v1/chat/completions"
TEXT_ROLES = frozenset(
    {
        "body",
        "title",
        "caption",
        "marginalia",
        "header",
        "footer",
        "catch-word",
        "footnote",
        "signature-mark",
        "table",
    }
)
ART_ROLES = frozenset({"figure", "ornament", "drop-capital"})
STRUCTURAL_TEXT_ROLES = frozenset({"catch-word", "footer", "signature-mark"})
TRANSLATABLE_ROLES = TEXT_ROLES - STRUCTURAL_TEXT_ROLES


def atomic_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        try:
            os.unlink(name)
        except FileNotFoundError:
            pass


def atomic_json(path: Path, value: Any, *, compact: bool = False) -> None:
    separators = (",", ":") if compact else None
    data = json.dumps(
        value,
        ensure_ascii=False,
        indent=None if compact else 2,
        separators=separators,
    ).encode("utf-8")
    atomic_bytes(path, data + (b"" if compact else b"\n"))


def unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Build a JSON object while rejecting keys a normal decoder would hide."""
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path: Path) -> Any:
    return json.loads(
        path.read_text(encoding="utf-8"), object_pairs_hook=unique_json_object
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_json(value: Any) -> str:
    canonical = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def release_qa_fingerprint(
    book: dict[str, Any],
    public_book_dir: Path,
    annotations: dict[str, Any],
    normalized_pages_sha256: str,
) -> dict[str, Any]:
    """Bind release QA to config, reviewed notes, page JSON, and visual assets."""
    artifact_records: list[dict[str, Any]] = []
    for directory_name in ("scan", "thumb", "art"):
        directory = public_book_dir / directory_name
        paths = sorted(path for path in directory.rglob("*") if path.is_file()) if directory.is_dir() else []
        for path in paths:
            artifact_records.append(
                {
                    "path": path.relative_to(public_book_dir).as_posix(),
                    "bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
            )
    annotation_scope = {
        "method_note": annotations.get("method_note"),
        "book": (annotations.get("books") or {}).get(str(book["id"])),
    }
    assets_sha256 = sha256_json(artifact_records)
    implementation_files = {
        "process.py": sha256_file(Path(__file__).resolve()),
        "qa.py": sha256_file(Path(__file__).with_name("qa.py").resolve()),
    }
    implementation_sha256 = sha256_json(implementation_files)
    qa_input = {
        "qa_contract_version": QA_CONTRACT_VERSION,
        "pipeline_version": PIPELINE_VERSION,
        "book_config_sha256": sha256_json(book),
        "source_sha256": book["source_sha256"],
        "source_bytes": int(book["source_bytes"]),
        "normalized_pages_sha256": normalized_pages_sha256,
        "annotations_sha256": sha256_json(annotation_scope),
        "assets_sha256": assets_sha256,
        "implementation_sha256": implementation_sha256,
    }
    return {
        "sha256": sha256_json(qa_input),
        "contract_version": QA_CONTRACT_VERSION,
        "pipeline_version": PIPELINE_VERSION,
        "book_config_sha256": qa_input["book_config_sha256"],
        "annotations_sha256": qa_input["annotations_sha256"],
        "assets_sha256": assets_sha256,
        "implementation_sha256": implementation_sha256,
        "asset_files": len(artifact_records),
        "asset_bytes": sum(int(item["bytes"]) for item in artifact_records),
    }


def reported_qa_sample_pages(report: dict[str, Any]) -> list[int]:
    return [
        int(item["page"])
        for item in ((report.get("sample_review") or {}).get("pages") or [])
        if isinstance(item, dict) and item.get("page") is not None
    ]


def validate_book_config(book: dict[str, Any]) -> None:
    book_id = str(book.get("id") or "<missing id>")
    try:
        page_count = int(book["pages"])
    except (KeyError, TypeError, ValueError) as error:
        raise SystemExit(f"{book_id}: pages must be a positive integer") from error
    if page_count < 1:
        raise SystemExit(f"{book_id}: pages must be a positive integer")
    raw_samples = book.get("qa_pages")
    if not isinstance(raw_samples, list) or not raw_samples:
        raise SystemExit(f"{book_id}: qa_pages must be a non-empty list")
    try:
        samples = [int(page) for page in raw_samples]
    except (TypeError, ValueError) as error:
        raise SystemExit(f"{book_id}: qa_pages must contain integers") from error
    if len(samples) != len(set(samples)):
        raise SystemExit(f"{book_id}: qa_pages must not contain duplicates")
    outside_book = [page for page in samples if page < 1 or page > page_count]
    if outside_book:
        raise SystemExit(
            f"{book_id}: qa_pages outside 1..{page_count}: "
            + ", ".join(str(page) for page in outside_book)
        )


def release_qa_report_is_current(
    report: dict[str, Any],
    book: dict[str, Any],
    normalized_pages_sha256: str,
    qa_fingerprint: dict[str, Any],
) -> bool:
    report_book = report.get("book") or {}
    result = report.get("result") or {}
    return (
        report.get("schema") == "whl-facsimile-qa/1"
        and report_book.get("id") == book["id"]
        and report_book.get("source_sha256") == book["source_sha256"]
        and report_book.get("source_bytes") == book["source_bytes"]
        and report_book.get("normalized_pages_sha256") == normalized_pages_sha256
        and report.get("release_fingerprint") == qa_fingerprint
        and result.get("status") in RELEASE_QA_STATUSES
        and reported_qa_sample_pages(report)
        == [int(page) for page in book["qa_pages"]]
    )


def load_books(config_path: Path, wanted: set[str]) -> list[dict[str, Any]]:
    config = read_json(config_path)
    if config.get("schema") != "whl-facsimile-books/1":
        raise SystemExit(f"Unsupported config schema in {config_path}")
    books = list(config.get("books") or [])
    known = {str(book.get("id")) for book in books}
    unknown = wanted - known
    if unknown:
        raise SystemExit(f"Unknown book id(s): {', '.join(sorted(unknown))}")
    for book in books:
        validate_book_config(book)
    return [book for book in books if not wanted or book["id"] in wanted]


def book_root(work_dir: Path, book: dict[str, Any]) -> Path:
    return work_dir / str(book["id"])


def source_path(source_dir: Path, book: dict[str, Any]) -> Path:
    return source_dir / str(book["source_filename"])


def require_mistral_key() -> str:
    key = str(os.environ.get("MISTRAL_API_KEY") or "").strip()
    if not key:
        raise SystemExit("Set MISTRAL_API_KEY in the environment")
    return key


def verify_source(path: Path, book: dict[str, Any]) -> None:
    if not path.is_file():
        raise RuntimeError(f"Missing source PDF: {path}")
    expected_bytes = int(book.get("source_bytes") or 0)
    if expected_bytes and path.stat().st_size != expected_bytes:
        raise RuntimeError(
            f"Source byte-count mismatch for {book['id']}: "
            f"expected {expected_bytes}, got {path.stat().st_size}"
        )
    actual_hash = sha256_file(path)
    expected_hash = str(book["source_sha256"]).lower()
    if actual_hash != expected_hash:
        raise RuntimeError(
            f"Source checksum mismatch for {book['id']}: "
            f"expected {expected_hash}, got {actual_hash}"
        )
    with fitz.open(path) as document:
        actual_pages = document.page_count
    if actual_pages != int(book["pages"]):
        raise RuntimeError(
            f"Page-count mismatch for {book['id']}: "
            f"expected {book['pages']}, got {actual_pages}"
        )


def download_book(
    source_dir: Path, book: dict[str, Any], *, force: bool = False
) -> Path:
    destination = source_path(source_dir, book)
    if destination.is_file() and not force:
        verify_source(destination, book)
        print(f"{book['id']}: source verified")
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    part = destination.with_suffix(destination.suffix + ".part")
    headers: dict[str, str] = {}
    mode = "wb"
    if part.is_file() and part.stat().st_size:
        headers["Range"] = f"bytes={part.stat().st_size}-"
        mode = "ab"
    with requests.get(
        str(book["source_url"]), headers=headers, stream=True, timeout=(30, 300)
    ) as response:
        if mode == "ab" and response.status_code != 206:
            mode = "wb"
        response.raise_for_status()
        with part.open(mode) as handle:
            for chunk in response.iter_content(1024 * 1024):
                if chunk:
                    handle.write(chunk)
    os.replace(part, destination)
    verify_source(destination, book)
    print(f"{book['id']}: downloaded and verified")
    return destination


def api_post(
    endpoint: str,
    payload: dict[str, Any],
    key: str,
    *,
    attempts: int = 12,
    timeout: tuple[int, int] = (30, 900),
) -> dict[str, Any]:
    retryable = {408, 409, 425, 429, 500, 502, 503, 504}
    for attempt in range(1, attempts + 1):
        try:
            response = requests.post(
                endpoint,
                headers={"Authorization": f"Bearer {key}"},
                json=payload,
                timeout=timeout,
            )
            if response.status_code in retryable:
                if attempt == attempts:
                    response.raise_for_status()
                retry_after = response.headers.get("Retry-After")
                delay = float(retry_after) if retry_after else min(45, 2**attempt)
                time.sleep(delay + random.random())
                continue
            response.raise_for_status()
            decoded = response.json()
            if not isinstance(decoded, dict):
                raise RuntimeError("API returned a non-object JSON response")
            return decoded
        except (requests.Timeout, requests.ConnectionError):
            if attempt == attempts:
                raise
            time.sleep(min(45, 2**attempt) + random.random())
    raise AssertionError("unreachable")


def chunk_ranges(page_count: int, chunk_size: int) -> list[tuple[int, int]]:
    return [
        (start, min(page_count - 1, start + chunk_size - 1))
        for start in range(0, page_count, chunk_size)
    ]


def valid_ocr_chunk(path: Path, start: int, end: int, book: dict[str, Any]) -> bool:
    if not path.is_file():
        return False
    try:
        wrapper = read_json(path)
        response = wrapper["response"]
        indexes = [int(page["index"]) for page in response["pages"]]
        return (
            wrapper.get("schema") == "whl-facsimile-ocr-chunk/1"
            and wrapper.get("model") == OCR_MODEL
            and wrapper.get("source_sha256") == book["source_sha256"]
            and indexes == list(range(start, end + 1))
        )
    except (OSError, KeyError, TypeError, ValueError):
        return False


def ocr_chunk(
    root: Path,
    book: dict[str, Any],
    start: int,
    end: int,
    key: str,
    force: bool,
) -> Path:
    destination = root / "raw" / "ocr" / f"{start + 1:04}-{end + 1:04}.json"
    if not force and valid_ocr_chunk(destination, start, end, book):
        return destination
    payload = {
        "model": OCR_MODEL,
        "document": {
            "type": "document_url",
            "document_url": book["source_url"],
        },
        "pages": f"{start}-{end}",
        "include_blocks": True,
        "include_image_base64": False,
        "confidence_scores_granularity": "page",
    }
    started = time.time()
    response = api_post(OCR_ENDPOINT, payload, key)
    pages = response.get("pages") or []
    indexes = [int(page.get("index", -1)) for page in pages]
    expected = list(range(start, end + 1))
    if indexes != expected:
        raise RuntimeError(
            f"{book['id']} OCR range {start}-{end} returned indexes {indexes[:3]}…"
        )
    wrapper = {
        "schema": "whl-facsimile-ocr-chunk/1",
        "pipeline_version": PIPELINE_VERSION,
        "book_id": book["id"],
        "source_sha256": book["source_sha256"],
        "model": OCR_MODEL,
        "request": {
            "pages": payload["pages"],
            "include_blocks": True,
            "include_image_base64": False,
            "confidence_scores_granularity": "page",
        },
        "elapsed_seconds": round(time.time() - started, 3),
        "response": response,
    }
    atomic_json(destination, wrapper)
    print(f"{book['id']}: OCR pages {start + 1}-{end + 1}")
    return destination


def page_confidence(page: dict[str, Any]) -> tuple[float | None, float | None]:
    scores = page.get("confidence_scores") or {}
    average = scores.get("average_page_confidence_score")
    minimum = scores.get("minimum_page_confidence_score")
    try:
        average = round(float(average), 6)
    except (TypeError, ValueError):
        average = None
    try:
        minimum = round(float(minimum), 6)
    except (TypeError, ValueError):
        minimum = None
    return average, minimum


def block_confidence(block: dict[str, Any]) -> float | None:
    scores = block.get("confidence_scores") or {}
    for key in ("average_block_confidence_score", "average_page_confidence_score"):
        try:
            return round(float(scores[key]), 6)
        except (KeyError, TypeError, ValueError):
            pass
    values = scores.get("word_confidence_scores") or []
    numeric = []
    for value in values:
        if isinstance(value, dict):
            value = value.get("confidence") or value.get("score")
        try:
            numeric.append(float(value))
        except (TypeError, ValueError):
            pass
    return round(sum(numeric) / len(numeric), 6) if numeric else None


_PAGE_NUMBER_RE = re.compile(r"^[\s\[\](){}.,:;·•\-–—0-9ivxlcdmIVXLCDM]+$")


def infer_role(block: dict[str, Any], box: list[float]) -> str:
    kind = str(block.get("type") or "text").strip().lower()
    content = str(block.get("content") or "").strip()
    x0, y0, x1, y1 = box
    width, height = x1 - x0, y1 - y0
    area = width * height
    words = content.split()
    if kind == "image":
        return "ornament" if area < 0.018 and width < 0.18 else "figure"
    direct = {
        "title": "title",
        "caption": "caption",
        "table": "table",
        "aside_text": "marginalia",
        "header": "header",
        "footer": "footer",
        "signature": "signature-mark",
    }
    if kind in direct:
        role = direct[kind]
    else:
        role = "body"
    if content and len(content) <= 14 and _PAGE_NUMBER_RE.fullmatch(content):
        if y0 < 0.13 or y1 > 0.87:
            return "page-number"
    if y1 > 0.92 and len(words) <= 3 and width < 0.35:
        return "catch-word" if x0 > 0.48 else "footer"
    if y0 < 0.07 and height < 0.09 and role == "body":
        return "header"
    if y1 > 0.94 and height < 0.08 and role == "body":
        return "footer"
    if role == "body" and width < 0.23 and (x1 < 0.23 or x0 > 0.77):
        return "marginalia"
    return role


def normalized_box(block: dict[str, Any], width: float, height: float) -> list[float]:
    raw = [
        float(block.get("top_left_x") or 0),
        float(block.get("top_left_y") or 0),
        float(block.get("bottom_right_x") or 0),
        float(block.get("bottom_right_y") or 0),
    ]
    box = [raw[0] / width, raw[1] / height, raw[2] / width, raw[3] / height]
    box = [round(max(0.0, min(1.0, value)), 7) for value in box]
    if box[2] <= box[0] or box[3] <= box[1]:
        raise ValueError(f"invalid OCR box: {raw}")
    return box


def normalize_ocr_pages(root: Path, book: dict[str, Any]) -> None:
    pages_by_index: dict[int, dict[str, Any]] = {}
    for chunk_path in sorted((root / "raw" / "ocr").glob("*.json")):
        wrapper = read_json(chunk_path)
        for page in wrapper["response"]["pages"]:
            pages_by_index[int(page["index"])] = page
    expected = set(range(int(book["pages"])))
    if set(pages_by_index) != expected:
        missing = sorted(expected - set(pages_by_index))
        raise RuntimeError(f"{book['id']}: missing OCR pages {missing[:20]}")
    pages_dir = root / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    for index in sorted(pages_by_index):
        source = pages_by_index[index]
        dimensions = source.get("dimensions") or {}
        width = float(dimensions.get("width") or 1)
        height = float(dimensions.get("height") or 1)
        regions = []
        previous_modern: dict[str, str] = {}
        destination = pages_dir / f"{index + 1:04}.json"
        if destination.is_file():
            try:
                old = read_json(destination)
                previous_modern = {
                    region["id"]: str((region.get("text") or {}).get("modern") or "")
                    for region in old.get("regions") or []
                }
            except (OSError, KeyError, TypeError, ValueError):
                previous_modern = {}
        for order, block in enumerate(source.get("blocks") or []):
            try:
                box = normalized_box(block, width, height)
            except (TypeError, ValueError):
                continue
            region_id = f"p{index + 1:04}-r{order + 1:03}"
            role = infer_role(block, box)
            regions.append(
                {
                    "id": region_id,
                    "role": role,
                    "source_type": str(block.get("type") or "text"),
                    "box": box,
                    "order": order,
                    "text": {
                        "diplomatic": str(block.get("content") or "").strip(),
                        "modern": previous_modern.get(region_id, ""),
                    },
                    "confidence": block_confidence(block),
                }
            )
        markdown = str(source.get("markdown") or "").strip()
        if not regions and markdown:
            regions.append(
                {
                    "id": f"p{index + 1:04}-r001",
                    "role": "body",
                    "source_type": "markdown-fallback",
                    "box": [0.08, 0.08, 0.92, 0.92],
                    "order": 0,
                    "text": {
                        "diplomatic": markdown,
                        "modern": previous_modern.get(f"p{index + 1:04}-r001", ""),
                    },
                    "confidence": None,
                }
            )
        average, minimum = page_confidence(source)
        block_chars = sum(
            len((region.get("text") or {}).get("diplomatic") or "")
            for region in regions
        )
        page_record = {
            "schema": "whl-facsimile-page/1",
            "pipeline_version": PIPELINE_VERSION,
            "book_id": book["id"],
            "page": index + 1,
            "ocr_dimensions": {
                "width": int(width),
                "height": int(height),
                "dpi": dimensions.get("dpi"),
            },
            "width": int(width),
            "height": int(height),
            "paper": "#e9dfcb",
            "ink": "#28241f",
            "confidence": average,
            "minimum_confidence": minimum,
            "markdown_chars": len(markdown),
            "block_chars": block_chars,
            "regions": regions,
        }
        atomic_json(destination, page_record, compact=True)
    apply_page_overrides(root, book)


def apply_page_overrides(root: Path, book: dict[str, Any]) -> None:
    """Apply auditable, book-level QA overrides while retaining raw OCR responses."""
    overrides = book.get("suppress_ocr_pages") or {}
    if not isinstance(overrides, dict):
        raise RuntimeError(f"{book['id']}: suppress_ocr_pages must be an object")
    for raw_page, raw_reason in overrides.items():
        page_number = int(raw_page)
        if page_number < 1 or page_number > int(book["pages"]):
            raise RuntimeError(
                f"{book['id']}: invalid suppressed OCR page {page_number}"
            )
        page_path = root / "pages" / f"{page_number:04}.json"
        if not page_path.is_file():
            continue
        page = read_json(page_path)
        regions = page.get("regions") or []
        prior = page.get("ocr_suppression") or {}
        suppressed_count = int(prior.get("region_count") or len(regions))
        suppressed_chars = int(
            prior.get("block_chars")
            or sum(
                len(str((region.get("text") or {}).get("diplomatic") or ""))
                for region in regions
            )
        )
        page["regions"] = []
        page["ocr_suppression"] = {
            "reason": str(raw_reason),
            "region_count": suppressed_count,
            "block_chars": suppressed_chars,
            "raw_response_retained": True,
        }
        atomic_json(page_path, page, compact=True)

    region_overrides = book.get("suppress_ocr_regions") or {}
    if not isinstance(region_overrides, dict):
        raise RuntimeError(f"{book['id']}: suppress_ocr_regions must be an object")
    pages: dict[int, dict[str, Any]] = {}
    for region_id, raw_reason in region_overrides.items():
        match = re.fullmatch(r"p(\d{4})-r\d{3}", str(region_id))
        if not match:
            raise RuntimeError(
                f"{book['id']}: invalid suppressed OCR region {region_id}"
            )
        page_number = int(match.group(1))
        page_path = root / "pages" / f"{page_number:04}.json"
        if not page_path.is_file():
            continue
        page = pages.get(page_number) or read_json(page_path)
        regions = list(page.get("regions") or [])
        target = next(
            (region for region in regions if region.get("id") == region_id), None
        )
        if target is None:
            prior = page.get("ocr_region_suppressions") or []
            if any(item.get("id") == region_id for item in prior):
                pages[page_number] = page
                continue
            raise RuntimeError(
                f"{book['id']}: suppressed OCR region not found: {region_id}"
            )
        page["regions"] = [
            region for region in regions if region.get("id") != region_id
        ]
        suppressions = list(page.get("ocr_region_suppressions") or [])
        suppressions.append(
            {
                "id": str(region_id),
                "reason": str(raw_reason),
                "block_chars": len(
                    str((target.get("text") or {}).get("diplomatic") or "")
                ),
                "raw_response_retained": True,
            }
        )
        page["ocr_region_suppressions"] = suppressions
        pages[page_number] = page
    for page_number, page in pages.items():
        atomic_json(root / "pages" / f"{page_number:04}.json", page, compact=True)


def run_ocr(
    work_dir: Path,
    book: dict[str, Any],
    *,
    workers: int,
    chunk_size: int,
    force: bool,
) -> None:
    key = require_mistral_key()
    root = book_root(work_dir, book)
    root.mkdir(parents=True, exist_ok=True)
    ranges = chunk_ranges(int(book["pages"]), chunk_size)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = [
            pool.submit(ocr_chunk, root, book, start, end, key, force)
            for start, end in ranges
        ]
        for future in concurrent.futures.as_completed(futures):
            future.result()
    normalize_ocr_pages(root, book)
    print(f"{book['id']}: normalized {book['pages']} OCR pages")


def estimate_colors(image: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    array = np.asarray(image.convert("RGB"), dtype=np.uint8)
    height, width = array.shape[:2]
    edge = max(2, int(min(width, height) * 0.055))
    border = np.concatenate(
        [
            array[:edge].reshape(-1, 3),
            array[-edge:].reshape(-1, 3),
            array[:, :edge].reshape(-1, 3),
            array[:, -edge:].reshape(-1, 3),
        ],
        axis=0,
    )
    border16 = border.astype(np.int16)
    luma = border16 @ np.array([0.2126, 0.7152, 0.0722])
    chroma = border16.max(axis=1) - border16.min(axis=1)
    candidates = border[(luma > 125) & (luma < 252) & (chroma < 105)]
    if len(candidates) < 100:
        candidates = border[luma > 110]
    if len(candidates) < 20:
        candidates = border
    paper = np.median(candidates, axis=0).astype(np.uint8)
    flat = array.reshape(-1, 3)
    flat_luma = flat.astype(np.int16) @ np.array([0.2126, 0.7152, 0.0722])
    dark = flat[flat_luma < np.percentile(flat_luma, 12)]
    ink = (
        np.median(dark, axis=0).astype(np.uint8)
        if len(dark)
        else np.array([40, 35, 30])
    )
    return paper, ink


def rgb_hex(rgb: Iterable[int]) -> str:
    return "#" + "".join(f"{int(value):02x}" for value in rgb)


def art_remainder(
    image: Image.Image,
    page_record: dict[str, Any],
    paper: np.ndarray,
) -> tuple[Image.Image | None, float]:
    rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    color = rgb.astype(np.float32)
    paper_float = paper.astype(np.float32)
    difference = np.sqrt(np.mean(np.square(color - paper_float), axis=2))
    luma = color @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    paper_luma = float(
        paper_float @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    )
    darkness = np.maximum(0.0, paper_luma - luma)
    strength = np.maximum(difference * 1.25, darkness * 1.05)
    alpha = np.clip((strength - 10.0) * 4.1, 0, 255).astype(np.uint8)
    height, width = alpha.shape
    pad = max(3, int(min(width, height) * 0.006))
    for region in page_record.get("regions") or []:
        if region.get("role") in ART_ROLES:
            continue
        x0, y0, x1, y1 = region["box"]
        left = max(0, int(math.floor(x0 * width)) - pad)
        top = max(0, int(math.floor(y0 * height)) - pad)
        right = min(width, int(math.ceil(x1 * width)) + pad)
        bottom = min(height, int(math.ceil(y1 * height)) + pad)
        alpha[top:bottom, left:right] = 0
    fraction = float(np.count_nonzero(alpha > 18)) / float(width * height)
    if fraction < 0.0007:
        return None, fraction
    visible_rgb = rgb.copy()
    visible_rgb[alpha == 0] = paper
    rgba = np.dstack([visible_rgb, alpha])
    return Image.fromarray(rgba, "RGBA"), fraction


def render_page_assets(
    pdf_path: Path,
    page_number: int,
    page_path: Path,
    public_book_dir: Path,
    scan_width: int,
    force: bool,
) -> tuple[int, str, str, bool, float]:
    scan_path = public_book_dir / "scan" / f"{page_number:04}.webp"
    thumb_path = public_book_dir / "thumb" / f"{page_number:04}.webp"
    art_path = public_book_dir / "art" / f"{page_number:04}.webp"
    page_record = read_json(page_path)
    assets_current = page_record.get("art_pipeline_version") == ART_PIPELINE_VERSION
    if scan_path.is_file() and thumb_path.is_file() and not force and assets_current:
        return (
            page_number,
            str(page_record.get("paper") or "#e9dfcb"),
            str(page_record.get("ink") or "#28241f"),
            art_path.is_file(),
            float(page_record.get("art_fraction") or 0),
        )
    if scan_path.is_file() and thumb_path.is_file() and not force:
        image = Image.open(scan_path).convert("RGB")
    else:
        with fitz.open(pdf_path) as document:
            page = document[page_number - 1]
            zoom = scan_width / max(1.0, float(page.rect.width))
            pixmap = page.get_pixmap(
                matrix=fitz.Matrix(zoom, zoom), alpha=False, colorspace=fitz.csRGB
            )
            image = Image.frombytes(
                "RGB", (pixmap.width, pixmap.height), pixmap.samples
            )
        scan_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(scan_path, "WEBP", quality=79, method=4)
        thumbnail = image.copy()
        thumbnail.thumbnail((250, 360), Image.Resampling.LANCZOS)
        thumb_path.parent.mkdir(parents=True, exist_ok=True)
        thumbnail.save(thumb_path, "WEBP", quality=68, method=4)
    paper, ink = estimate_colors(image)
    art, art_fraction = art_remainder(image, page_record, paper)
    if art is not None:
        art_path.parent.mkdir(parents=True, exist_ok=True)
        art.save(art_path, "WEBP", quality=82, method=4, exact=False)
    elif art_path.exists():
        art_path.unlink()
    page_record.update(
        {
            "width": image.width,
            "height": image.height,
            "paper": rgb_hex(paper),
            "ink": rgb_hex(ink),
            "art_fraction": round(art_fraction, 7),
            "has_art": art is not None,
            "art_pipeline_version": ART_PIPELINE_VERSION,
        }
    )
    atomic_json(page_path, page_record, compact=True)
    return (
        page_number,
        page_record["paper"],
        page_record["ink"],
        art is not None,
        art_fraction,
    )


def run_assets(
    source_dir: Path,
    work_dir: Path,
    public_dir: Path,
    book: dict[str, Any],
    *,
    workers: int,
    scan_width: int,
    force: bool,
) -> None:
    pdf_path = source_path(source_dir, book)
    verify_source(pdf_path, book)
    root = book_root(work_dir, book)
    pages_dir = root / "pages"
    if not pages_dir.is_dir():
        raise RuntimeError(f"Run OCR before assets for {book['id']}")
    apply_page_overrides(root, book)
    public_book_dir = public_dir / "books" / str(book["id"])
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = [
            pool.submit(
                render_page_assets,
                pdf_path,
                page_number,
                pages_dir / f"{page_number:04}.json",
                public_book_dir,
                scan_width,
                force,
            )
            for page_number in range(1, int(book["pages"]) + 1)
        ]
        completed = 0
        for future in concurrent.futures.as_completed(futures):
            future.result()
            completed += 1
            if completed % 50 == 0 or completed == int(book["pages"]):
                print(f"{book['id']}: assets {completed}/{book['pages']}")


def translation_instruction(book: dict[str, Any]) -> str:
    common = (
        "Return a JSON object with one key, translations. Its value must be an "
        "object mapping every supplied region id to modern English for that same "
        "region. The input contains the reading-ordered OCR regions from exactly "
        "one physical page. Return every supplied region id exactly once. Use "
        "neighboring regions as context, but never move, borrow, duplicate, or omit "
        "their content. When a region begins or ends mid-sentence, preserve that "
        "fragment boundary instead of completing it with words from another region. "
        "Do not add notes, invent missing text, repeat region ids in the prose, or emit "
        "Markdown heading markers. Preserve botanical names, named authorities, "
        "cross-references, quantities, headings, running matter, and uncertainty. Copy "
        "Roman numerals without converting them to words or Arabic digits. Retain the "
        "supplied spelling of named authorities, even when it appears unusual; never "
        "silently substitute a different authority. "
        "Translate only what the OCR actually says; obvious OCR damage may be "
        "silently repaired when the intended reading is clear. Separate natural "
        "headings and paragraphs with blank lines. Do not emit Markdown of any "
        "kind, including emphasis asterisks."
    )
    if book.get("mode") == "normalize":
        return (
            "You are a conservative editor of sixteenth-century English. "
            "Modernize spelling, punctuation, obsolete letterforms, pronouns, verb "
            "forms, and word order for immediate comprehension. Replace opaque "
            "obsolete vocabulary with its current equivalent; do not retain -eth "
            "endings or imitate sixteenth-century English. Preserve every claim, "
            "recipe, plant name, unit, blunt expression, and ambiguity; do not "
            "sanitize historical medical advice. Use contemporary readable English "
            "without commentary. " + common
        )
    return (
        f"You are translating a {book['year']} {book['language']} herbal into "
        "clear modern English for a reading facsimile. Preserve the author's "
        "distinctions and period medical claims without endorsing or expanding "
        "them. Translate prose, headings, and vernacular plant names; retain "
        "Latin binomials, Greek forms, and short source-language synonyms when "
        "they function as names. " + common
    )


def translation_source_text(value: Any) -> str:
    """Remove OCR transport markup without altering the stored diplomatic layer."""
    text = str(value or "").strip()
    return re.sub(r"^\s{0,3}#{1,6}\s+", "", text)


def clean_modern_text(value: Any) -> str:
    text = str(value or "").strip()
    text = re.sub(r"^\s{0,3}#{1,6}\s+", "", text)
    return re.sub(r"\*([^*\n]+)\*", r"\1", text).strip()


def overlay_reviewed_translations(
    book: dict[str, Any], translations: dict[str, Any], expected_ids: set[str]
) -> dict[str, Any]:
    """Make scan-reviewed full replacements authoritative in accepted caches."""
    merged = dict(translations)
    overrides = book.get("modern_text_overrides") or {}
    if not isinstance(overrides, dict):
        return merged
    for region_id in expected_ids:
        override = overrides.get(region_id)
        if isinstance(override, dict):
            text = str(override.get("text") or "").strip()
            if text:
                merged[region_id] = text
    return merged


def translation_records(page_records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Build stable region units while keeping each API request page-bounded."""
    records: list[dict[str, Any]] = []
    for page in page_records:
        for region in page.get("regions") or []:
            text = translation_source_text((region.get("text") or {}).get("diplomatic"))
            role = str(region.get("role") or "body")
            if text and role in TRANSLATABLE_ROLES:
                records.append(
                    {
                        "id": str(region["id"]),
                        "page": int(page["page"]),
                        "order": int(region.get("order") or 0),
                        "role": role,
                        "text": text,
                    }
                )
    return records


def canonical_alnum(value: Any) -> str:
    return "".join(
        character.casefold() for character in str(value) if character.isalnum()
    )


def unchanged_source_prose(book: dict[str, Any], source: str, target_key: str) -> bool:
    if book.get("mode") == "normalize" or canonical_alnum(source) != target_key:
        return False
    words = re.findall(r"[^\W_]+", source.casefold(), flags=re.UNICODE)
    markers = {
        "la": {
            "ad",
            "cum",
            "de",
            "enim",
            "est",
            "et",
            "ex",
            "in",
            "non",
            "quod",
            "sed",
            "ut",
        },
        "de": {
            "auf",
            "das",
            "dem",
            "den",
            "der",
            "die",
            "ein",
            "ist",
            "mit",
            "und",
            "von",
            "zu",
        },
    }.get(str(book.get("language_code") or ""), set())
    return len(words) >= 30 and sum(word in markers for word in words) >= 4


PROTECTED_NAME_STEMS = frozenset(
    {
        "apule",
        "blatocid",
        "cassius",
        "dioscor",
        "felix",
        "hesiod",
        "homer",
        "mesue",
        "moses",
        "oribasi",
        "platear",
        "serap",
    }
)
OPEN_END_WORDS = frozenset(
    {
        "ac",
        "als",
        "and",
        "atque",
        "auf",
        "auff",
        "aut",
        "cum",
        "das",
        "de",
        "dem",
        "den",
        "der",
        "die",
        "et",
        "ex",
        "for",
        "in",
        "mit",
        "ne",
        "nec",
        "of",
        "oder",
        "quae",
        "qui",
        "quod",
        "quo",
        "that",
        "the",
        "to",
        "und",
        "ut",
        "vnd",
        "von",
        "which",
        "with",
        "zu",
    }
)


def protected_anchor_issues(record: dict[str, Any], target: str) -> list[str]:
    """Find high-confidence anchors that left their source region."""
    source = str(record.get("text") or "")
    source_key = canonical_alnum(source)
    target_key = canonical_alnum(target)
    issues: list[str] = []
    number_pattern = r"(?<!\w)\d+(?!\w)"
    source_numbers = Counter(re.findall(number_pattern, source))
    target_numbers = Counter(re.findall(number_pattern, target))
    if source_numbers and source_numbers != target_numbers:
        issues.append("Arabic numeral mismatch")
    roman_pattern = r"(?<![A-Za-z])[IVXLCDMJ]{2,}(?![A-Za-z])"
    source_romans = Counter(
        item.upper().replace("J", "I") for item in re.findall(roman_pattern, source)
    )
    target_romans = Counter(
        item.upper().replace("J", "I") for item in re.findall(roman_pattern, target)
    )
    role = str(record.get("role") or "body")
    if role in {"title", "header", "caption"}:
        single_pattern = r"(?<![A-Za-z])[IVX](?![A-Za-z])"
        source_romans.update(
            item.upper() for item in re.findall(single_pattern, source)
        )
        target_romans.update(
            item.upper() for item in re.findall(single_pattern, target)
        )
    if source_romans != target_romans:
        issues.append("Roman numeral mismatch")
    for stem in PROTECTED_NAME_STEMS:
        if stem in source_key and stem not in target_key:
            issues.append(f"protected authority/name stem omitted: {stem}")
    return issues


def source_requires_open_end(record: dict[str, Any]) -> bool:
    if str(record.get("role") or "body") not in {"body", "footnote", "table"}:
        return False
    source = str(record.get("text") or "").rstrip()
    if source.endswith(("-", "¬")):
        return True
    if source.endswith((".", "!", "?", ";", ":")):
        return False
    words = re.findall(r"[^\W_]+", source.casefold(), flags=re.UNICODE)
    return bool(words and words[-1] in OPEN_END_WORDS)


def translation_issues(
    book: dict[str, Any],
    records: list[dict[str, Any]],
    translations: Any,
) -> tuple[set[str], set[str]]:
    """Return missing and semantically suspect region ids.

    These deliberately broad checks catch catastrophic truncation, expansion,
    untranslated prose, duplicate output, moved anchors, and closed source
    fragments. They are guards, not accuracy scores.
    """
    expected = {str(record["id"]) for record in records}
    if not isinstance(translations, dict):
        return expected, set()
    missing = expected - set(translations)
    invalid: set[str] = set()
    if set(translations) - expected:
        invalid.update(expected)
    sources = {str(record["id"]): str(record["text"]) for record in records}
    records_by_id = {str(record["id"]): record for record in records}
    duplicate_targets: dict[str, list[str]] = {}
    reviewed_full_overrides = set((book.get("modern_text_overrides") or {}).keys())
    for item in expected - missing:
        value = translations.get(item)
        cleaned = clean_modern_text(value)
        if not isinstance(value, str) or not cleaned:
            invalid.add(item)
            continue
        if item in reviewed_full_overrides:
            continue
        source_key = canonical_alnum(sources[item])
        target_key = canonical_alnum(cleaned)
        source_length = len(source_key)
        target_length = len(target_key)
        if source_length >= 80:
            ratio = target_length / source_length
            if ratio < 0.40 or ratio > 2.0:
                invalid.add(item)
        if unchanged_source_prose(book, sources[item], target_key):
            invalid.add(item)
        if not re.search(r"\w", cleaned, flags=re.UNICODE):
            invalid.add(item)
        if protected_anchor_issues(records_by_id[item], cleaned):
            invalid.add(item)
        if source_requires_open_end(records_by_id[item]) and cleaned.rstrip().endswith(
            (".", "!", "?")
        ):
            invalid.add(item)
        if target_length >= 80:
            duplicate_targets.setdefault(target_key, []).append(item)
    for ids in duplicate_targets.values():
        if len(ids) > 1 and len({canonical_alnum(sources[item]) for item in ids}) > 1:
            invalid.update(ids)
    ordered_ids = [str(record["id"]) for record in records]
    for first, second in zip(ordered_ids, ordered_ids[1:]):
        if first in reviewed_full_overrides or second in reviewed_full_overrides:
            continue
        first_target = canonical_alnum(clean_modern_text(translations.get(first)))
        second_target = canonical_alnum(clean_modern_text(translations.get(second)))
        shorter_target, longer_target = sorted(
            (first_target, second_target), key=len
        )
        if len(shorter_target) < 100 or shorter_target not in longer_target:
            continue
        first_source = canonical_alnum(sources[first])
        second_source = canonical_alnum(sources[second])
        shorter_source, longer_source = sorted((first_source, second_source), key=len)
        if shorter_source not in longer_source:
            invalid.update((first, second))
    source_total = sum(len(canonical_alnum(value)) for value in sources.values())
    target_total = sum(
        len(canonical_alnum(clean_modern_text(translations[item])))
        for item in expected - missing
        if isinstance(translations.get(item), str)
    )
    if source_total >= 200 and (
        target_total / source_total < 0.35 or target_total / source_total > 2.75
    ):
        invalid.update(expected - missing)
    return missing, invalid


def valid_translation_batch(
    path: Path,
    book: dict[str, Any],
    input_hash: str,
    prompt_hash: str,
    records: list[dict[str, Any]],
    page_numbers: list[int],
) -> bool:
    if not path.is_file():
        return False
    try:
        wrapper = read_json(path)
        translations = wrapper["translations"]
        missing, invalid = translation_issues(book, records, translations)
        return (
            wrapper.get("schema") == TRANSLATION_SCHEMA
            and wrapper.get("strategy") == TRANSLATION_STRATEGY
            and wrapper.get("book_id") == book["id"]
            and wrapper.get("model") == TRANSLATION_MODEL
            and wrapper.get("source_sha256") == book["source_sha256"]
            and wrapper.get("input_sha256") == input_hash
            and wrapper.get("prompt_sha256") == prompt_hash
            and wrapper.get("pages") == page_numbers
            and not missing
            and not invalid
        )
    except (OSError, KeyError, TypeError, ValueError):
        return False


def translate_batch(
    root: Path,
    book: dict[str, Any],
    page_numbers: list[int],
    key: str,
    force: bool,
) -> Path:
    if len(page_numbers) != 1:
        raise RuntimeError(
            "Translation isolation requires exactly one page per API request"
        )
    page_records = [
        read_json(root / "pages" / f"{page:04}.json") for page in page_numbers
    ]
    records = translation_records(page_records)
    destination = root / "raw" / "page_translation" / f"{page_numbers[0]:04}.json"
    input_hash = sha256_json(records)
    prompt_hash = sha256_json(
        {
            "model": TRANSLATION_MODEL,
            "strategy": TRANSLATION_STRATEGY,
            "instruction": translation_instruction(book),
        }
    )
    if not records:
        wrapper = {
            "schema": TRANSLATION_SCHEMA,
            "pipeline_version": PIPELINE_VERSION,
            "book_id": book["id"],
            "source_sha256": book["source_sha256"],
            "model": TRANSLATION_MODEL,
            "input_sha256": input_hash,
            "prompt_sha256": prompt_hash,
            "strategy": TRANSLATION_STRATEGY,
            "pages": page_numbers,
            "translations": {},
            "usage": {},
        }
        atomic_json(destination, wrapper)
        return destination
    ids = {record["id"] for record in records}
    if not force and valid_translation_batch(
        destination, book, input_hash, prompt_hash, records, page_numbers
    ):
        return destination
    payload = {
        "model": TRANSLATION_MODEL,
        "temperature": 0,
        "random_seed": 1542,
        "max_tokens": 8192,
        "response_format": {"type": "json_object"},
        "prompt_cache_key": f"whl-facsimile-{book['id']}-{TRANSLATION_STRATEGY}",
        "messages": [
            {"role": "system", "content": translation_instruction(book)},
            {
                "role": "user",
                "content": (
                    "Translate or normalize these reading-ordered regions from one "
                    "independent physical page. Return the required JSON object.\n\n"
                    + json.dumps(records, ensure_ascii=False, separators=(",", ":"))
                ),
            },
        ],
    }
    response: dict[str, Any] = {}
    translations: dict[str, Any] = {}
    missing = set(ids)
    invalid_values: set[str] = set()
    supplemental_usage: list[dict[str, Any]] = []
    for semantic_attempt in range(1, 4):
        payload["random_seed"] = 1541 + semantic_attempt
        if semantic_attempt > 1:
            payload["messages"][-1]["content"] = (
                "The previous response was incomplete or semantically suspect. "
                "Return a fresh JSON object containing every required region id "
                "exactly once, without sharing text between regions.\n\n"
                + json.dumps(records, ensure_ascii=False, separators=(",", ":"))
            )
        response = api_post(CHAT_ENDPOINT, payload, key)
        try:
            content = response["choices"][0]["message"]["content"]
            decoded = json.loads(content, object_pairs_hook=unique_json_object)
            candidate = decoded["translations"]
            if not isinstance(candidate, dict):
                raise TypeError("translations is not an object")
            translations = {
                item: (
                    value.get("text")
                    if isinstance(value, dict) and isinstance(value.get("text"), str)
                    else value
                )
                for item, value in candidate.items()
            }
        except (KeyError, IndexError, TypeError, ValueError):
            translations = {}
        translations = overlay_reviewed_translations(book, translations, ids)
        missing, invalid_values = translation_issues(book, records, translations)
        if not missing and not invalid_values:
            break
        atomic_json(
            root
            / "raw"
            / "rejected_page_translation"
            / f"{page_numbers[0]:04}-attempt-{semantic_attempt}.json",
            {
                "schema": "whl-facsimile-rejected-translation/1",
                "book_id": book["id"],
                "page": page_numbers[0],
                "model": str(response.get("model") or TRANSLATION_MODEL),
                "input_sha256": input_hash,
                "prompt_sha256": prompt_hash,
                "missing_ids": sorted(missing),
                "invalid_ids": sorted(invalid_values),
                "response_content": (
                    response.get("choices", [{}])[0].get("message", {}).get("content")
                    if isinstance(response.get("choices"), list)
                    and response.get("choices")
                    else None
                ),
                "usage": response.get("usage") or {},
            },
        )
        repairable = missing | invalid_values
        if repairable and len(repairable) <= 8 and not (set(translations) - ids):
            break
    repair_ids = sorted(missing | invalid_values)
    if repair_ids and len(repair_ids) <= 8:
        by_id = {record["id"]: record for record in records}
        for repair_index, item in enumerate(repair_ids, start=1):
            repair_record = by_id[item]
            prior_value = clean_modern_text(translations.get(item))
            repair_reasons = protected_anchor_issues(repair_record, prior_value)
            if source_requires_open_end(repair_record) and prior_value.endswith(
                (".", "!", "?")
            ):
                repair_reasons.append("source fragment was incorrectly closed")
            feedback = (
                " Automated validation found: " + "; ".join(repair_reasons) + "."
                if repair_reasons
                else ""
            )
            for repair_attempt in range(1, 3):
                repair_payload = dict(payload)
                repair_payload["random_seed"] = (
                    2600 + repair_index * 10 + repair_attempt
                )
                repair_payload["messages"] = [
                    payload["messages"][0],
                    {
                        "role": "user",
                        "content": (
                            "Repair this omitted or suspect region. Return the required "
                            "JSON object with this one region id and translate only that "
                            "region's source content exactly once. Preserve an open start "
                            "or ending exactly as printed; do not complete it from context."
                            + feedback
                            + "\n\n"
                            + json.dumps(
                                [repair_record],
                                ensure_ascii=False,
                                separators=(",", ":"),
                            )
                        ),
                    },
                ]
                repair_response = api_post(CHAT_ENDPOINT, repair_payload, key)
                repair_content: Any = None
                repair_missing = {item}
                repair_invalid: set[str] = set()
                try:
                    repair_content = repair_response["choices"][0]["message"][
                        "content"
                    ]
                    repair_decoded = json.loads(
                        repair_content, object_pairs_hook=unique_json_object
                    )
                    repair_value = repair_decoded["translations"][item]
                    if isinstance(repair_value, dict) and isinstance(
                        repair_value.get("text"), str
                    ):
                        repair_value = repair_value["text"]
                    repair_missing, repair_invalid = translation_issues(
                        book, [by_id[item]], {item: repair_value}
                    )
                    if not repair_missing and not repair_invalid:
                        translations[item] = repair_value
                except (KeyError, IndexError, TypeError, ValueError):
                    pass
                supplemental_usage.append(repair_response.get("usage") or {})
                if not repair_missing and not repair_invalid:
                    break
                atomic_json(
                    root
                    / "raw"
                    / "rejected_page_translation"
                    / (
                        f"{page_numbers[0]:04}-repair-{repair_index}"
                        f"-attempt-{repair_attempt}.json"
                    ),
                    {
                        "schema": "whl-facsimile-rejected-translation/1",
                        "book_id": book["id"],
                        "page": page_numbers[0],
                        "region_id": item,
                        "model": str(
                            repair_response.get("model") or TRANSLATION_MODEL
                        ),
                        "input_sha256": input_hash,
                        "prompt_sha256": prompt_hash,
                        "missing_ids": sorted(repair_missing),
                        "invalid_ids": sorted(repair_invalid),
                        "response_content": repair_content,
                        "usage": repair_response.get("usage") or {},
                    },
                )
        missing, invalid_values = translation_issues(book, records, translations)
    if missing or invalid_values:
        raise RuntimeError(
            f"Translation response for {book['id']} remained invalid after three "
            f"semantic attempts ({len(missing)} missing, {len(invalid_values)} "
            "semantically suspect)"
        )
    clean = {item: clean_modern_text(translations[item]) for item in sorted(ids)}
    wrapper = {
        "schema": TRANSLATION_SCHEMA,
        "pipeline_version": PIPELINE_VERSION,
        "book_id": book["id"],
        "source_sha256": book["source_sha256"],
        "model": str(response.get("model") or TRANSLATION_MODEL),
        "input_sha256": input_hash,
        "prompt_sha256": prompt_hash,
        "strategy": TRANSLATION_STRATEGY,
        "pages": page_numbers,
        "translations": clean,
        "reviewed_region_ids": sorted(
            ids & set((book.get("modern_text_overrides") or {}).keys())
        ),
        "usage": response.get("usage") or {},
        "supplemental_usage": supplemental_usage,
    }
    atomic_json(destination, wrapper)
    print(f"{book['id']}: modern text pages {page_numbers[0]}-{page_numbers[-1]}")
    return destination


def apply_translations(root: Path, book: dict[str, Any]) -> None:
    prompt_hash = sha256_json(
        {
            "model": TRANSLATION_MODEL,
            "strategy": TRANSLATION_STRATEGY,
            "instruction": translation_instruction(book),
        }
    )
    pages: dict[int, dict[str, Any]] = {}
    page_records: dict[int, list[dict[str, Any]]] = {}
    translations: dict[int, dict[str, str]] = {}
    for page_number in range(1, int(book["pages"]) + 1):
        path = root / "pages" / f"{page_number:04}.json"
        page = read_json(path)
        pages[page_number] = page
        records = translation_records([page])
        page_records[page_number] = records
        cache_path = root / "raw" / "page_translation" / f"{page_number:04}.json"
        if not valid_translation_batch(
            cache_path,
            book,
            sha256_json(records),
            prompt_hash,
            records,
            [page_number],
        ):
            raise RuntimeError(
                f"{book['id']}: page {page_number} lacks a valid independent-page "
                "translation cache"
            )
        if records:
            wrapper = read_json(cache_path)
            translations[page_number] = {
                str(region_id): str(value)
                for region_id, value in wrapper["translations"].items()
            }

    for page_number, page in pages.items():
        active_regions: list[dict[str, Any]] = []
        for region in page.get("regions") or []:
            text = translation_source_text((region.get("text") or {}).get("diplomatic"))
            region.setdefault("text", {})["modern"] = ""
            region.pop("modern_override", None)
            role = str(region.get("role") or "body")
            if text and role in STRUCTURAL_TEXT_ROLES:
                region["text"]["modern"] = text
            elif text and role in TRANSLATABLE_ROLES:
                active_regions.append(region)
        if active_regions:
            for region in active_regions:
                region["text"]["modern"] = translations[page_number][region["id"]]
            page["translation"] = {
                "schema": TRANSLATION_SCHEMA,
                "strategy": TRANSLATION_STRATEGY,
                "allocation": "stable-region-id-direct",
                "model": TRANSLATION_MODEL,
                "source_sha256": sha256_json(page_records[page_number]),
            }
        else:
            page.pop("translation", None)
        atomic_json(root / "pages" / f"{page_number:04}.json", page, compact=True)
    apply_modern_text_overrides(root, book)


def apply_modern_text_overrides(root: Path, book: dict[str, Any]) -> None:
    overrides = book.get("modern_text_overrides") or {}
    if not isinstance(overrides, dict):
        raise RuntimeError(f"{book['id']}: modern_text_overrides must be an object")
    pages: dict[int, dict[str, Any]] = {}

    def target_region(region_id: str) -> tuple[int, dict[str, Any]]:
        match = re.fullmatch(r"p(\d{4})-r\d{3}", region_id)
        if not match:
            raise RuntimeError(f"{book['id']}: malformed modern override {region_id}")
        page_number = int(match.group(1))
        page = pages.get(page_number)
        if page is None:
            page_path = root / "pages" / f"{page_number:04}.json"
            page = read_json(page_path)
            pages[page_number] = page
        target = next(
            (
                region
                for region in page.get("regions") or []
                if region.get("id") == region_id
            ),
            None,
        )
        if target is None:
            raise RuntimeError(f"{book['id']}: unknown override region {region_id}")
        return page_number, target

    for region_id, override in overrides.items():
        if not isinstance(override, dict):
            raise RuntimeError(f"{book['id']}: malformed modern override {region_id}")
        _, target = target_region(str(region_id))
        text = str(override.get("text") or "").strip()
        reason = str(override.get("reason") or "").strip()
        if not text or not reason:
            raise RuntimeError(f"{book['id']}: invalid modern override {region_id}")
        target["text"]["modern"] = text
        target["modern_override"] = {
            "operation": "full-region replacement",
            "reason": reason,
            "reviewed": True,
        }

    replacements = book.get("modern_text_replacements") or {}
    if not isinstance(replacements, dict):
        raise RuntimeError(f"{book['id']}: modern_text_replacements must be an object")
    for region_id, operations in replacements.items():
        if not isinstance(operations, list) or not operations:
            raise RuntimeError(f"{book['id']}: invalid replacements for {region_id}")
        _, target = target_region(str(region_id))
        reasons: list[str] = []
        for operation in operations:
            if not isinstance(operation, dict):
                raise RuntimeError(
                    f"{book['id']}: malformed replacement for {region_id}"
                )
            find = str(operation.get("find") or "")
            replacement = str(operation.get("replace") or "")
            reason = str(operation.get("reason") or "").strip()
            current = str(target["text"].get("modern") or "")
            if not find or not replacement or not reason or current.count(find) != 1:
                raise RuntimeError(
                    f"{book['id']}: replacement for {region_id} did not match exactly once"
                )
            target["text"]["modern"] = current.replace(find, replacement, 1)
            reasons.append(reason)
        target["modern_override"] = {
            "operation": "reviewed phrase replacement",
            "reason": "; ".join(reasons),
            "reviewed": True,
        }
    for page_number, page in pages.items():
        atomic_json(root / "pages" / f"{page_number:04}.json", page, compact=True)


def run_translation(
    work_dir: Path,
    book: dict[str, Any],
    *,
    workers: int,
    pages_per_batch: int,
    force: bool,
) -> None:
    if pages_per_batch != 1:
        raise RuntimeError(
            "Translation isolation requires --translation-pages 1; batching physical "
            "pages can contaminate adjacent outputs"
        )
    key = require_mistral_key()
    root = book_root(work_dir, book)
    apply_page_overrides(root, book)
    pages = list(range(1, int(book["pages"]) + 1))
    batches = [[page] for page in pages]
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = [
            pool.submit(translate_batch, root, book, batch, key, force)
            for batch in batches
        ]
        for future in concurrent.futures.as_completed(futures):
            future.result()
    apply_translations(root, book)
    print(f"{book['id']}: modern layer complete")


def url_join(base: str, path: str) -> str:
    return f"{base.rstrip('/')}/{path.lstrip('/')}" if base else path


def book_styles(book: dict[str, Any]) -> dict[str, Any]:
    if book["id"] == "herbarius-1488":
        return {
            "theme": "incunable",
            "body_family": "'Palatino Linotype', 'Book Antiqua', Georgia, serif",
            "heading_family": "'Palatino Linotype', 'Book Antiqua', Georgia, serif",
            "body_scale": 1.0,
        }
    if book["id"] == "banckes-1552":
        return {
            "theme": "blackletter",
            "body_family": "'Book Antiqua', Georgia, 'Times New Roman', serif",
            "heading_family": "'Book Antiqua', Georgia, 'Times New Roman', serif",
            "body_scale": 1.03,
        }
    return {
        "theme": "renaissance",
        "body_family": "Garamond, Baskerville, Georgia, serif",
        "heading_family": "Garamond, Baskerville, Georgia, serif",
        "body_scale": 1.0,
    }


def assemble_book(
    work_dir: Path,
    public_dir: Path,
    book: dict[str, Any],
    *,
    assets_base_url: str,
    qa_annotations: dict[str, Any],
) -> dict[str, Any]:
    root = book_root(work_dir, book)
    public_book_dir = public_dir / "books" / str(book["id"])
    data_dir = public_book_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    confidence_values: list[float] = []
    page_record_hashes: list[dict[str, Any]] = []
    public_page_hashes: list[dict[str, Any]] = []
    art_pages = 0
    region_count = 0
    translated_count = 0
    for page_number in range(1, int(book["pages"]) + 1):
        page = read_json(root / "pages" / f"{page_number:04}.json")
        page_record_hashes.append(
            {"page": page_number, "sha256": sha256_json(page)}
        )
        public_page = {
            key: page[key]
            for key in (
                "page",
                "width",
                "height",
                "paper",
                "ink",
                "confidence",
                "minimum_confidence",
                "regions",
            )
        }
        if page.get("has_art"):
            public_page["art"] = url_join(
                assets_base_url, f"books/{book['id']}/art/{page_number:04}.webp"
            )
            art_pages += 1
        if page.get("confidence") is not None:
            confidence_values.append(float(page["confidence"]))
        region_count += len(page.get("regions") or [])
        translated_count += sum(
            1
            for region in page.get("regions") or []
            if str((region.get("text") or {}).get("modern") or "").strip()
        )
        public_page_hashes.append(
            {"page": page_number, "sha256": sha256_json(public_page)}
        )
        atomic_json(data_dir / f"{page_number:04}.json", public_page, compact=True)
    base = f"books/{book['id']}"
    qa_url = url_join(assets_base_url, f"{base}/qa/report.json")
    normalized_pages_sha256 = sha256_json(page_record_hashes)
    qa_fingerprint = release_qa_fingerprint(
        book,
        public_book_dir,
        qa_annotations,
        normalized_pages_sha256,
    )
    qa_report_path = public_book_dir / "qa" / "report.json"
    qa_report: dict[str, Any] | None = None
    qa_sample_pages: list[int] = []
    if qa_report_path.is_file():
        try:
            candidate = read_json(qa_report_path)
            if release_qa_report_is_current(
                candidate,
                book,
                normalized_pages_sha256,
                qa_fingerprint,
            ):
                qa_report = candidate
                qa_sample_pages = reported_qa_sample_pages(candidate)
        except (OSError, ValueError, TypeError):
            qa_report = None
    qa_details: dict[str, Any] = {
        "status": (
            str((qa_report.get("result") or {}).get("status"))
            if qa_report
            else "not_run"
        ),
        "sample_pages": qa_sample_pages,
        "average_confidence": (
            round(sum(confidence_values) / len(confidence_values), 5)
            if confidence_values
            else None
        ),
    }
    if qa_report:
        qa_details["report"] = qa_url
    manifest = {
        "schema": "whl-facsimile-manifest/1",
        "pipeline_version": PIPELINE_VERSION,
        "id": book["id"],
        "title": book["title"],
        "short_title": book["short_title"],
        "creator": book["creator"],
        "imprint": book["imprint"],
        "year": book["year"],
        "language": book["language"],
        "pages": book["pages"],
        "page_pattern": url_join(assets_base_url, f"{base}/scan/{{page}}.webp"),
        "thumb_pattern": url_join(assets_base_url, f"{base}/thumb/{{page}}.webp"),
        "data_pattern": url_join(assets_base_url, f"{base}/data/{{page}}.json"),
        "styles": book_styles(book),
        "qa": qa_details,
        "source": {
            "catalog_permalink": book["catalog_permalink"],
            "catalog_line": book["catalog_line"],
            "pdf_url": book["source_url"],
            "sha256": book["source_sha256"],
            "bytes": book["source_bytes"],
            "bibliographic_record": book["bibliographic_record"],
            "bibliographic_label": book["bibliographic_label"],
            "reuse_note": "The historical text is out of copyright; terms for this exact digital scan may be separate. Verify the linked source and bibliographic records before redistribution.",
            "ocr_model": OCR_MODEL,
            "translation_model": TRANSLATION_MODEL,
            "translation_strategy": TRANSLATION_STRATEGY,
        },
        "statistics": {
            "regions": region_count,
            "modern_regions": translated_count,
            "art_pages": art_pages,
            "page_data_sha256": sha256_json(public_page_hashes),
        },
    }
    atomic_json(public_book_dir / "manifest.json", manifest)
    return manifest


def assemble_catalog(
    config_path: Path,
    books: list[dict[str, Any]],
    manifests: dict[str, dict[str, Any]],
    *,
    assets_base_url: str,
) -> dict[str, Any]:
    config = read_json(config_path)
    rows = []
    for book in config["books"]:
        if book["id"] not in manifests:
            continue
        base = f"books/{book['id']}"
        cover_page = int(book.get("cover_page") or 1)
        if cover_page < 1 or cover_page > int(book["pages"]):
            cover_page = 1
        rows.append(
            {
                key: book[key]
                for key in (
                    "id",
                    "title",
                    "short_title",
                    "subtitle",
                    "creator",
                    "year",
                    "language",
                    "pages",
                    "description",
                    "significance",
                    "accent",
                )
            }
            | {
                "cover_page": cover_page,
                "cover": url_join(
                    assets_base_url,
                    f"{base}/scan/{cover_page:04d}.webp",
                ),
                "manifest": url_join(assets_base_url, f"{base}/manifest.json"),
            }
        )
    return {
        "schema": "whl-facsimile-catalog/1",
        "project": {
            "title": "The Living Herbal",
            "subtitle": "Three early herbals, newly readable",
            "method": "Mistral OCR 4 paragraph geometry, conservative English reading layers, and non-generative source artwork",
            "pipeline_version": PIPELINE_VERSION,
            "source_catalog": config.get("catalog"),
        },
        "books": rows,
    }


def run_assemble(
    config_path: Path,
    work_dir: Path,
    public_dir: Path,
    books: list[dict[str, Any]],
    *,
    assets_base_url: str,
    catalog_output: Path | None,
    require_ready_qa: bool,
) -> None:
    config = read_json(config_path)
    qa_config = config.get("qa") or {}
    if qa_config.get("contract_version") != QA_CONTRACT_VERSION:
        raise RuntimeError(
            f"QA contract mismatch: expected {QA_CONTRACT_VERSION}, "
            f"got {qa_config.get('contract_version')}"
        )
    annotations_path = config_path.parent / str(
        qa_config.get("annotations") or "qa_annotations.json"
    )
    qa_annotations = read_json(annotations_path)
    if qa_annotations.get("schema") != "whl-facsimile-qa-annotations/1":
        raise RuntimeError(f"Unsupported QA annotations in {annotations_path}")
    manifests = {
        book["id"]: assemble_book(
            work_dir,
            public_dir,
            book,
            assets_base_url=assets_base_url,
            qa_annotations=qa_annotations,
        )
        for book in books
    }
    if require_ready_qa:
        unready = [
            book_id
            for book_id, manifest in manifests.items()
            if (manifest.get("qa") or {}).get("status") not in RELEASE_QA_STATUSES
        ]
        if unready:
            raise RuntimeError(
                "Release assembly requires current ready QA for: "
                + ", ".join(sorted(unready))
            )
    catalog = assemble_catalog(
        config_path, books, manifests, assets_base_url=assets_base_url
    )
    atomic_json(public_dir / "catalog.json", catalog)
    if catalog_output:
        atomic_json(catalog_output, catalog)
    print(f"assembled {len(books)} book manifest(s)")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "phase",
        choices=("download", "ocr", "assets", "translate", "assemble", "all"),
    )
    parser.add_argument(
        "--config", type=Path, default=Path(__file__).with_name("books.json")
    )
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--public-dir", type=Path, required=True)
    parser.add_argument("--book", action="append", default=[])
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--chunk-pages", type=int, default=50)
    parser.add_argument("--translation-pages", type=int, default=1)
    parser.add_argument("--scan-width", type=int, default=1400)
    parser.add_argument("--assets-base-url", default="")
    parser.add_argument("--catalog-output", type=Path)
    parser.add_argument(
        "--require-ready-qa",
        action="store_true",
        help="fail assembly unless every selected manifest has current release-ready QA",
    )
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    books = load_books(args.config, set(args.book))
    if not books:
        raise SystemExit("No books selected")
    phases = (
        ["download", "ocr", "assets", "translate", "assemble"]
        if args.phase == "all"
        else [args.phase]
    )
    for phase in phases:
        if phase == "download":
            for book in books:
                download_book(args.source_dir, book, force=args.force)
        elif phase == "ocr":
            for book in books:
                verify_source(source_path(args.source_dir, book), book)
                run_ocr(
                    args.work_dir,
                    book,
                    workers=args.workers,
                    chunk_size=args.chunk_pages,
                    force=args.force,
                )
        elif phase == "assets":
            for book in books:
                run_assets(
                    args.source_dir,
                    args.work_dir,
                    args.public_dir,
                    book,
                    workers=args.workers,
                    scan_width=args.scan_width,
                    force=args.force,
                )
        elif phase == "translate":
            for book in books:
                run_translation(
                    args.work_dir,
                    book,
                    workers=args.workers,
                    pages_per_batch=args.translation_pages,
                    force=args.force,
                )
        elif phase == "assemble":
            for book in books:
                verify_source(source_path(args.source_dir, book), book)
            run_assemble(
                args.config,
                args.work_dir,
                args.public_dir,
                books,
                assets_base_url=args.assets_base_url,
                catalog_output=args.catalog_output,
                require_ready_qa=args.require_ready_qa,
            )


if __name__ == "__main__":
    main()
