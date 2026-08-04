#!/usr/bin/env python3
"""Reproducible QA for World Herb Library reading facsimiles.

This tool checks every normalized page record and published asset, produces
machine-readable reports, and renders fixed sample overlays for visual review.
The source PDF's embedded text layer is used only as an independent
disagreement baseline. It is not ground truth, so this tool intentionally does
not report character error rate, word error rate, or bounding-box IoU.
"""

from __future__ import annotations

import argparse
import difflib
import io
import json
import math
import os
import re
import tempfile
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import fitz
import numpy as np
from PIL import Image, ImageDraw, ImageFont

try:
    from . import process as pipeline_process
except ImportError:
    import process as pipeline_process


REPORT_SCHEMA = "whl-facsimile-qa/1"
EXPECTED_OCR_MODEL = "mistral-ocr-4-0"
EXPECTED_TRANSLATION_MODEL = pipeline_process.TRANSLATION_MODEL
EXPECTED_TRANSLATION_SCHEMA = pipeline_process.TRANSLATION_SCHEMA
EXPECTED_TRANSLATION_STRATEGY = pipeline_process.TRANSLATION_STRATEGY
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
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
WORD = re.compile(r"[^\W_]+", re.UNICODE)
OVERLAY_COLORS: dict[str, tuple[int, int, int, int]] = {
    "body": (23, 133, 150, 235),
    "title": (230, 126, 34, 245),
    "caption": (142, 68, 173, 240),
    "marginalia": (54, 162, 88, 240),
    "header": (45, 105, 190, 230),
    "footer": (45, 105, 190, 230),
    "page-number": (45, 105, 190, 230),
    "catch-word": (85, 80, 185, 230),
    "figure": (206, 46, 99, 245),
    "ornament": (206, 46, 99, 245),
    "drop-capital": (206, 46, 99, 245),
}


def read_json(path: Path) -> Any:
    return pipeline_process.read_json(path)


def atomic_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def atomic_json(path: Path, value: Any) -> None:
    data = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    atomic_bytes(path, data)


def load_books(config_path: Path, wanted: set[str]) -> list[dict[str, Any]]:
    config = read_json(config_path)
    if config.get("schema") != "whl-facsimile-books/1":
        raise SystemExit(f"Unsupported config schema: {config_path}")
    books = list(config.get("books") or [])
    known = {str(book.get("id")) for book in books}
    unknown = wanted - known
    if unknown:
        raise SystemExit(f"Unknown book id(s): {', '.join(sorted(unknown))}")
    for book in books:
        pipeline_process.validate_book_config(book)
    return [book for book in books if not wanted or book["id"] in wanted]


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return round(ordered[lower], 6)
    weight = position - lower
    return round(ordered[lower] * (1 - weight) + ordered[upper] * weight, 6)


def distribution(values: Iterable[float]) -> dict[str, Any]:
    clean = [float(value) for value in values if math.isfinite(float(value))]
    if not clean:
        return {
            "count": 0,
            "minimum": None,
            "p05": None,
            "p10": None,
            "median": None,
            "p90": None,
            "p95": None,
            "maximum": None,
            "mean": None,
        }
    return {
        "count": len(clean),
        "minimum": round(min(clean), 6),
        "p05": percentile(clean, 0.05),
        "p10": percentile(clean, 0.10),
        "median": percentile(clean, 0.50),
        "p90": percentile(clean, 0.90),
        "p95": percentile(clean, 0.95),
        "maximum": round(max(clean), 6),
        "mean": round(sum(clean) / len(clean), 6),
    }


def page_ranges(pages: Iterable[int]) -> list[str]:
    ordered = sorted(set(int(page) for page in pages))
    if not ordered:
        return []
    ranges: list[str] = []
    start = previous = ordered[0]
    for page in ordered[1:]:
        if page == previous + 1:
            previous = page
            continue
        ranges.append(str(start) if start == previous else f"{start}-{previous}")
        start = previous = page
    ranges.append(str(start) if start == previous else f"{start}-{previous}")
    return ranges


def page_list(pages: Iterable[int], limit: int = 50) -> dict[str, Any]:
    ordered = sorted(set(int(page) for page in pages))
    return {
        "count": len(ordered),
        "ranges": page_ranges(ordered),
        "first_pages": ordered[:limit],
        "truncated": len(ordered) > limit,
    }


def hex_rgb(value: Any) -> tuple[int, int, int] | None:
    if not isinstance(value, str) or not HEX_COLOR.fullmatch(value):
        return None
    return tuple(int(value[index : index + 2], 16) for index in (1, 3, 5))


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    values = []
    for component in rgb:
        channel = component / 255
        values.append(
            channel / 12.92
            if channel <= 0.04045
            else ((channel + 0.055) / 1.055) ** 2.4
        )
    return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2]


def contrast_ratio(first: tuple[int, int, int], second: tuple[int, int, int]) -> float:
    high, low = sorted(
        (relative_luminance(first), relative_luminance(second)), reverse=True
    )
    return (high + 0.05) / (low + 0.05)


def valid_box(box: Any) -> tuple[bool, str | None]:
    if not isinstance(box, list) or len(box) != 4:
        return False, "box must be a four-item list"
    try:
        x0, y0, x1, y1 = (float(value) for value in box)
    except (TypeError, ValueError):
        return False, "box contains a non-numeric coordinate"
    if not all(math.isfinite(value) for value in (x0, y0, x1, y1)):
        return False, "box contains a non-finite coordinate"
    if min(x0, y0) < 0 or max(x1, y1) > 1:
        return False, "box is outside normalized page bounds"
    if x1 <= x0 or y1 <= y0:
        return False, "box has zero or negative area"
    return True, None


def inspect_raw_ocr(root: Path, book: dict[str, Any]) -> dict[str, Any]:
    covered: list[int] = []
    errors: list[dict[str, Any]] = []
    models: Counter[str] = Counter()
    chunk_paths = sorted((root / "raw" / "ocr").glob("*.json"))
    for path in chunk_paths:
        try:
            wrapper = read_json(path)
            if wrapper.get("schema") != "whl-facsimile-ocr-chunk/1":
                errors.append({"file": path.name, "issue": "unexpected schema"})
            if wrapper.get("book_id") != book["id"]:
                errors.append({"file": path.name, "issue": "book id mismatch"})
            if wrapper.get("source_sha256") != book["source_sha256"]:
                errors.append({"file": path.name, "issue": "source checksum mismatch"})
            model = str(wrapper.get("model") or "missing")
            models[model] += 1
            if model != EXPECTED_OCR_MODEL:
                errors.append(
                    {
                        "file": path.name,
                        "issue": f"expected {EXPECTED_OCR_MODEL}, found {model}",
                    }
                )
            request = wrapper.get("request") or {}
            if request.get("include_blocks") is not True:
                errors.append(
                    {"file": path.name, "issue": "OCR blocks were not requested"}
                )
            for page in (wrapper.get("response") or {}).get("pages") or []:
                covered.append(int(page["index"]) + 1)
        except (
            OSError,
            KeyError,
            TypeError,
            ValueError,
            json.JSONDecodeError,
        ) as error:
            errors.append({"file": path.name, "issue": f"unreadable: {error}"})
    counter = Counter(covered)
    duplicate_pages = sorted(page for page, count in counter.items() if count > 1)
    expected = set(range(1, int(book["pages"]) + 1))
    actual = set(covered)
    return {
        "chunk_count": len(chunk_paths),
        "models": dict(sorted(models.items())),
        "covered_pages": len(actual & expected),
        "missing_pages": page_list(expected - actual),
        "unexpected_pages": page_list(actual - expected),
        "duplicate_pages": page_list(duplicate_pages),
        "errors": errors[:100],
        "error_count": len(errors),
        "complete": actual == expected and not duplicate_pages and not errors,
    }


def inspect_translation_cache(
    root: Path,
    book: dict[str, Any],
    pages: dict[int, dict[str, Any]],
) -> dict[str, Any]:
    expected_pages = set(range(1, int(book["pages"]) + 1))
    expected_names = {f"{page:04}.json" for page in expected_pages}
    directory = root / "raw" / "page_translation"
    paths = sorted(directory.glob("*.json"))
    actual_names = {path.name for path in paths}
    valid_pages: set[int] = set()
    translated_pages: set[int] = set()
    expected_text_pages: set[int] = set()
    errors: list[dict[str, Any]] = []
    prompt_hash = pipeline_process.sha256_json(
        {
            "model": EXPECTED_TRANSLATION_MODEL,
            "strategy": EXPECTED_TRANSLATION_STRATEGY,
            "instruction": pipeline_process.translation_instruction(book),
        }
    )
    for page_number in sorted(expected_pages):
        page = pages.get(page_number)
        path = directory / f"{page_number:04}.json"
        if page is None:
            errors.append(
                {"file": path.name, "issue": "normalized page record unavailable"}
            )
            continue
        records = pipeline_process.translation_records([page])
        if records:
            expected_text_pages.add(page_number)
        if not path.is_file():
            continue
        try:
            wrapper = read_json(path)
            input_hash = pipeline_process.sha256_json(records)
            if not pipeline_process.valid_translation_batch(
                path,
                book,
                input_hash,
                prompt_hash,
                records,
                [page_number],
            ):
                errors.append(
                    {
                        "file": path.name,
                        "issue": "cache failed exact schema, model, hash, ID, or semantic validation",
                    }
                )
                continue
            valid_pages.add(page_number)
            if records:
                translated_pages.add(page_number)
            if wrapper.get("pages") != [page_number]:
                errors.append(
                    {"file": path.name, "issue": "cache is not isolated to one page"}
                )
        except (
            OSError,
            KeyError,
            TypeError,
            ValueError,
            json.JSONDecodeError,
        ) as error:
            errors.append({"file": path.name, "issue": f"unreadable: {error}"})
    missing_cache_pages = {
        page for page in expected_pages if f"{page:04}.json" not in actual_names
    }
    invalid_cache_pages = expected_pages - valid_pages - missing_cache_pages
    unexpected_files = sorted(actual_names - expected_names)
    rejected_paths = sorted((root / "raw" / "rejected_page_translation").glob("*.json"))
    legacy_paths = sorted((root / "raw" / "translation").glob("*.json"))
    complete = (
        valid_pages == expected_pages
        and translated_pages == expected_text_pages
        and not unexpected_files
        and not errors
    )
    return {
        "schema": EXPECTED_TRANSLATION_SCHEMA,
        "strategy": EXPECTED_TRANSLATION_STRATEGY,
        "model": EXPECTED_TRANSLATION_MODEL,
        "request_boundary": "exactly one physical page per API/cache record",
        "cache_count": len(paths),
        "valid_cache_pages": len(valid_pages),
        "missing_cache_pages": page_list(missing_cache_pages),
        "invalid_cache_pages": page_list(invalid_cache_pages),
        "unexpected_cache_files": unexpected_files,
        "translated_text_pages": len(translated_pages & expected_text_pages),
        "missing_text_pages": page_list(expected_text_pages - translated_pages),
        "unexpected_text_pages": page_list(translated_pages - expected_text_pages),
        "rejected_attempts_retained": len(rejected_paths),
        "legacy_batched_caches_excluded": len(legacy_paths),
        "errors": errors[:100],
        "error_count": len(errors),
        "complete": complete,
    }


def normalized_text(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(WORD.findall(value))


def diplomatic_page_text(page: dict[str, Any]) -> str:
    regions = sorted(
        page.get("regions") or [], key=lambda region: region.get("order", 0)
    )
    values = []
    for region in regions:
        if str(region.get("source_type") or "").lower() == "image":
            continue
        text = str((region.get("text") or {}).get("diplomatic") or "").strip()
        if text:
            values.append(text)
    return "\n".join(values)


def text_disagreement_baseline(
    pdf_path: Path | None,
    pages: dict[int, dict[str, Any]],
    sample_pages: list[int],
) -> dict[str, Any]:
    caveat = (
        "The PDF's hidden text layer is an independent OCR disagreement baseline, "
        "not ground truth. Similarity can reveal pages worth inspecting but cannot "
        "establish which OCR is correct. No CER, WER, or accuracy claim is derived "
        "from it."
    )
    if pdf_path is None or not pdf_path.is_file():
        return {
            "status": "unavailable",
            "source": str(pdf_path) if pdf_path else None,
            "caveat": caveat,
            "pages_compared": 0,
        }
    similarities: list[float] = []
    length_agreements: list[float] = []
    results: dict[int, dict[str, Any]] = {}
    try:
        with fitz.open(pdf_path) as document:
            for page_number, page in sorted(pages.items()):
                if page_number < 1 or page_number > document.page_count:
                    continue
                embedded = normalized_text(document[page_number - 1].get_text("text"))
                mistral = normalized_text(diplomatic_page_text(page))
                if len(embedded) < 20 or len(mistral) < 20:
                    continue
                similarity = difflib.SequenceMatcher(
                    None, embedded, mistral, autojunk=True
                ).ratio()
                agreement = min(len(embedded), len(mistral)) / max(
                    len(embedded), len(mistral)
                )
                similarities.append(similarity)
                length_agreements.append(agreement)
                results[page_number] = {
                    "page": page_number,
                    "sequence_similarity": round(similarity, 6),
                    "length_agreement": round(agreement, 6),
                    "embedded_characters": len(embedded),
                    "mistral_characters": len(mistral),
                }
    except (OSError, RuntimeError, ValueError) as error:
        return {
            "status": "error",
            "source": str(pdf_path),
            "caveat": caveat,
            "pages_compared": len(similarities),
            "error": str(error),
        }
    lowest = sorted(results.values(), key=lambda item: item["sequence_similarity"])[:20]
    sample = [results[page] for page in sample_pages if page in results]
    return {
        "status": "available",
        "source": pdf_path.name,
        "caveat": caveat,
        "pages_compared": len(similarities),
        "sequence_similarity": distribution(similarities),
        "length_agreement": distribution(length_agreements),
        "lowest_similarity_pages": lowest,
        "fixed_sample_pages": sample,
    }


def image_header(path: Path) -> tuple[tuple[int, int] | None, str | None]:
    try:
        if path.stat().st_size <= 16:
            return None, "file is empty or truncated"
        with Image.open(path) as image:
            return (int(image.width), int(image.height)), None
    except (OSError, ValueError) as error:
        return None, str(error)


def image_texture_metrics(path: Path) -> dict[str, float] | None:
    """Measure sparse, near-blank thumbnails without interpreting their content."""
    try:
        with Image.open(path) as source:
            pixels = np.asarray(source.convert("L"), dtype=np.float32)
    except (OSError, ValueError):
        return None
    if pixels.size < 4:
        return None
    vertical = np.abs(np.diff(pixels, axis=0))
    horizontal = np.abs(np.diff(pixels, axis=1))
    edge_fraction = (
        float((vertical > 14).mean()) + float((horizontal > 14).mean())
    ) / 2
    return {
        "luma_standard_deviation": round(float(pixels.std()), 6),
        "edge_fraction": round(edge_fraction, 6),
    }


def scan_visual_metrics(path: Path, page: dict[str, Any]) -> dict[str, float] | None:
    """Estimate unboxed dark content; this is triage, not image recognition."""
    paper = hex_rgb(page.get("paper"))
    if paper is None:
        return None
    try:
        with Image.open(path) as source:
            image = source.convert("RGB")
        image.thumbnail((420, 620), Image.Resampling.BILINEAR)
    except (OSError, ValueError):
        return None
    pixels = np.asarray(image, dtype=np.int32)
    paper_array = np.asarray(paper, dtype=np.int32)
    paper_luma = float(np.dot(paper_array, [0.2126, 0.7152, 0.0722]))
    luma = np.dot(pixels, [0.2126, 0.7152, 0.0722])
    distance = np.sqrt(np.sum((pixels - paper_array) ** 2, axis=2))
    dark = (luma < paper_luma - 24) & (distance > 42)
    text_mask = np.zeros(dark.shape, dtype=bool)
    height, width = dark.shape
    for region in page.get("regions") or []:
        if (
            region.get("role") in ART_ROLES
            or str(region.get("source_type") or "").lower() == "image"
        ):
            continue
        valid, _ = valid_box(region.get("box"))
        if not valid:
            continue
        x0, y0, x1, y1 = (float(value) for value in region["box"])
        left = max(0, int(x0 * width) - 3)
        top = max(0, int(y0 * height) - 3)
        right = min(width, math.ceil(x1 * width) + 3)
        bottom = min(height, math.ceil(y1 * height) + 3)
        text_mask[top:bottom, left:right] = True
    total = max(1, dark.size)
    return {
        "dark_fraction": round(float(dark.sum()) / total, 6),
        "text_box_fraction": round(float(text_mask.sum()) / total, 6),
        "unboxed_dark_fraction": round(float((dark & ~text_mask).sum()) / total, 6),
    }


def load_font(size: int) -> ImageFont.ImageFont:
    for name in ("arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size=size)
        except OSError:
            pass
    return ImageFont.load_default()


def render_overlay(
    scan_path: Path,
    output_path: Path,
    page: dict[str, Any],
    book: dict[str, Any],
    image_format: str,
) -> None:
    with Image.open(scan_path) as source:
        image = source.convert("RGB")
    if image.width > 1100:
        height = round(image.height * 1100 / image.width)
        image = image.resize((1100, height), Image.Resampling.LANCZOS)
    header_height = max(38, round(image.width * 0.042))
    canvas = Image.new("RGB", (image.width, image.height + header_height), "#171916")
    canvas.paste(image, (0, header_height))
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = load_font(max(11, round(image.width * 0.012)))
    header_font = load_font(max(15, round(image.width * 0.017)))
    draw.text(
        (12, max(4, (header_height - header_font.size) // 2)),
        f"{book['short_title']}  ·  page {page['page']}  ·  OCR region overlay",
        fill=(248, 244, 233, 255),
        font=header_font,
    )
    line_width = max(2, round(image.width / 480))
    for index, region in enumerate(page.get("regions") or [], start=1):
        valid, _ = valid_box(region.get("box"))
        if not valid:
            continue
        x0, y0, x1, y1 = (float(value) for value in region["box"])
        rectangle = (
            round(x0 * image.width),
            header_height + round(y0 * image.height),
            round(x1 * image.width),
            header_height + round(y1 * image.height),
        )
        role = str(region.get("role") or "unknown")
        color = OVERLAY_COLORS.get(role, (96, 96, 96, 235))
        draw.rectangle(rectangle, outline=color, width=line_width)
        label = f"{index} {role}"
        label_box = draw.textbbox((rectangle[0], rectangle[1]), label, font=font)
        label_width = label_box[2] - label_box[0] + 8
        label_height = label_box[3] - label_box[1] + 5
        top = max(header_height, rectangle[1] - label_height)
        draw.rectangle(
            (rectangle[0], top, rectangle[0] + label_width, top + label_height),
            fill=(color[0], color[1], color[2], 225),
        )
        draw.text(
            (rectangle[0] + 4, top + 1), label, fill=(255, 255, 255, 255), font=font
        )
    canvas = Image.alpha_composite(canvas.convert("RGBA"), overlay).convert("RGB")
    buffer = io.BytesIO()
    if image_format == "png":
        canvas.save(buffer, "PNG", optimize=True)
    else:
        canvas.save(buffer, "WEBP", quality=88, method=5)
    atomic_bytes(output_path, buffer.getvalue())


def load_annotations(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    decoded = read_json(path)
    if decoded.get("schema") != "whl-facsimile-qa-annotations/1":
        raise SystemExit(f"Unsupported annotations schema: {path}")
    return decoded


def annotation_for(
    annotations: dict[str, Any], book_id: str, page_number: int
) -> dict[str, Any] | None:
    value = (
        ((annotations.get("books") or {}).get(book_id) or {}).get("pages") or {}
    ).get(str(page_number))
    return value if isinstance(value, dict) else None


def qa_book(
    book: dict[str, Any],
    work_dir: Path,
    public_dir: Path,
    source_dir: Path | None,
    annotations: dict[str, Any],
    overlay_format: str,
) -> tuple[dict[str, Any], bool]:
    expected_count = int(book["pages"])
    expected_pages = set(range(1, expected_count + 1))
    root = work_dir / str(book["id"])
    pages_dir = root / "pages"
    public_book = public_dir / "books" / str(book["id"])
    pdf_path = (
        source_dir / str(book["source_filename"]) if source_dir is not None else None
    )
    source_verification: dict[str, Any] = {
        "status": "not_verified",
        "filename": str(book["source_filename"]),
        "expected_bytes": int(book["source_bytes"]),
        "actual_bytes": (
            pdf_path.stat().st_size if pdf_path is not None and pdf_path.is_file() else None
        ),
    }
    if pdf_path is not None:
        try:
            pipeline_process.verify_source(pdf_path, book)
            source_verification["status"] = "verified"
        except (OSError, RuntimeError, ValueError):
            source_verification["status"] = "failed"
    parsed_pages: dict[int, dict[str, Any]] = {}
    parse_errors: list[dict[str, str]] = []
    unexpected_files: list[str] = []
    for path in sorted(pages_dir.glob("*.json")) if pages_dir.is_dir() else []:
        try:
            page = read_json(path)
            page_number = int(page["page"])
            if page_number in parsed_pages:
                parse_errors.append(
                    {"file": path.name, "issue": f"duplicate page number {page_number}"}
                )
            else:
                parsed_pages[page_number] = page
            expected_name = f"{page_number:04}.json"
            if path.name != expected_name:
                unexpected_files.append(path.name)
        except (
            OSError,
            KeyError,
            TypeError,
            ValueError,
            json.JSONDecodeError,
        ) as error:
            parse_errors.append({"file": path.name, "issue": str(error)})

    actual_pages = set(parsed_pages)
    missing_pages = expected_pages - actual_pages
    extra_pages = actual_pages - expected_pages
    geometry_errors: list[dict[str, Any]] = []
    page_record_errors: list[dict[str, Any]] = []
    role_counts: Counter[str] = Counter()
    source_type_counts: Counter[str] = Counter()
    page_confidences: list[float] = []
    minimum_confidences: list[float] = []
    low_confidence_pages: list[int] = []
    capture_ratios: list[float] = []
    low_capture_pages: list[int] = []
    eligible_modern = 0
    populated_modern = 0
    diplomatic_chars = 0
    modern_chars = 0
    incomplete_modern_pages: list[int] = []
    reviewed_modern_overrides: list[dict[str, Any]] = []
    possible_ocr_hallucinations: dict[int, set[str]] = {}
    suppressed_ocr_pages: list[dict[str, Any]] = []
    suppressed_ocr_regions: list[dict[str, Any]] = []
    page_text_characters: dict[int, int] = {}
    color_errors: list[dict[str, Any]] = []
    low_contrast_pages: list[dict[str, Any]] = []
    color_contrasts: list[float] = []
    paper_colors: Counter[str] = Counter()
    ink_colors: Counter[str] = Counter()

    for page_number, page in sorted(parsed_pages.items()):
        suppression = page.get("ocr_suppression")
        is_suppressed = isinstance(suppression, dict) and bool(
            str(suppression.get("reason") or "").strip()
        )
        if is_suppressed:
            suppressed_ocr_pages.append(
                {
                    "page": page_number,
                    "reason": str(suppression["reason"]),
                    "region_count": int(suppression.get("region_count") or 0),
                    "block_characters": int(suppression.get("block_chars") or 0),
                    "raw_response_retained": bool(
                        suppression.get("raw_response_retained")
                    ),
                }
            )
        for item in page.get("ocr_region_suppressions") or []:
            suppressed_ocr_regions.append(
                {
                    "page": page_number,
                    "region": str(item.get("id") or ""),
                    "reason": str(item.get("reason") or ""),
                    "block_characters": int(item.get("block_chars") or 0),
                    "raw_response_retained": bool(item.get("raw_response_retained")),
                }
            )
        if page.get("schema") != "whl-facsimile-page/1":
            page_record_errors.append(
                {"page": page_number, "issue": "unexpected schema"}
            )
        if page.get("book_id") != book["id"]:
            page_record_errors.append(
                {"page": page_number, "issue": "book id mismatch"}
            )
        if int(page.get("page") or -1) != page_number:
            page_record_errors.append(
                {"page": page_number, "issue": "page field mismatch"}
            )
        if int(page.get("width") or 0) <= 0 or int(page.get("height") or 0) <= 0:
            page_record_errors.append(
                {"page": page_number, "issue": "invalid dimensions"}
            )
        confidence = page.get("confidence")
        if confidence is not None:
            try:
                numeric_confidence = float(confidence)
                page_confidences.append(numeric_confidence)
                if numeric_confidence < 0.80:
                    low_confidence_pages.append(page_number)
            except (TypeError, ValueError):
                page_record_errors.append(
                    {"page": page_number, "issue": "non-numeric page confidence"}
                )
        minimum = page.get("minimum_confidence")
        if minimum is not None:
            try:
                minimum_confidences.append(float(minimum))
            except (TypeError, ValueError):
                page_record_errors.append(
                    {"page": page_number, "issue": "non-numeric minimum confidence"}
                )
        markdown_chars = int(page.get("markdown_chars") or 0)
        block_chars = int(page.get("block_chars") or 0)
        if markdown_chars > 0:
            ratio = block_chars / markdown_chars
            capture_ratios.append(ratio)
            if ratio < 0.80:
                low_capture_pages.append(page_number)

        seen_ids: set[str] = set()
        seen_orders: set[int] = set()
        diplomatic_region_values: list[str] = []
        page_eligible = page_populated = page_translatable = 0
        for region_index, region in enumerate(page.get("regions") or [], start=1):
            region_id = str(region.get("id") or "")
            if not region_id or region_id in seen_ids:
                geometry_errors.append(
                    {
                        "page": page_number,
                        "region": region_id,
                        "issue": "missing or duplicate id",
                    }
                )
            seen_ids.add(region_id)
            try:
                order = int(region.get("order"))
                if order in seen_orders:
                    geometry_errors.append(
                        {
                            "page": page_number,
                            "region": region_id,
                            "issue": "duplicate order",
                        }
                    )
                seen_orders.add(order)
            except (TypeError, ValueError):
                geometry_errors.append(
                    {"page": page_number, "region": region_id, "issue": "invalid order"}
                )
            box_ok, box_issue = valid_box(region.get("box"))
            if not box_ok:
                geometry_errors.append(
                    {"page": page_number, "region": region_id, "issue": box_issue}
                )
            role = str(region.get("role") or "unknown")
            source_type = str(region.get("source_type") or "unknown")
            role_counts[role] += 1
            source_type_counts[source_type] += 1
            text = region.get("text") or {}
            diplomatic = str(text.get("diplomatic") or "").strip()
            modern = str(text.get("modern") or "").strip()
            if diplomatic:
                diplomatic_region_values.append(normalized_text(diplomatic))
            if diplomatic and role in TEXT_ROLES:
                eligible_modern += 1
                page_eligible += 1
                if role in pipeline_process.TRANSLATABLE_ROLES:
                    page_translatable += 1
                diplomatic_chars += len(diplomatic)
                if modern:
                    populated_modern += 1
                    page_populated += 1
                    modern_chars += len(modern)
            override = region.get("modern_override")
            if isinstance(override, dict) and override.get("reviewed") is True:
                reviewed_modern_overrides.append(
                    {
                        "page": page_number,
                        "region": region_id,
                        "operation": override.get("operation"),
                        "reason": override.get("reason"),
                    }
                )
        if page_eligible != page_populated:
            incomplete_modern_pages.append(page_number)
        translation_records = pipeline_process.translation_records([page])
        if page_translatable:
            translation = page.get("translation") or {}
            if translation.get("schema") != EXPECTED_TRANSLATION_SCHEMA:
                page_record_errors.append(
                    {"page": page_number, "issue": "translation schema mismatch"}
                )
            if translation.get("strategy") != EXPECTED_TRANSLATION_STRATEGY:
                page_record_errors.append(
                    {
                        "page": page_number,
                        "issue": "missing independent-page region translation provenance",
                    }
                )
            if translation.get("model") != EXPECTED_TRANSLATION_MODEL:
                page_record_errors.append(
                    {"page": page_number, "issue": "translation model mismatch"}
                )
            if translation.get("allocation") != "stable-region-id-direct":
                page_record_errors.append(
                    {"page": page_number, "issue": "translation allocation mismatch"}
                )
            if translation.get("source_sha256") != pipeline_process.sha256_json(
                translation_records
            ):
                page_record_errors.append(
                    {"page": page_number, "issue": "translation source hash mismatch"}
                )
        elif page.get("translation"):
            page_record_errors.append(
                {
                    "page": page_number,
                    "issue": "translation provenance exists without translatable regions",
                }
            )
        page_text_characters[page_number] = sum(
            len(str((region.get("text") or {}).get("diplomatic") or "").strip())
            for region in page.get("regions") or []
            if region.get("role") in TEXT_ROLES
        )
        repeated = Counter(value for value in diplomatic_region_values if value)
        if not is_suppressed and len(diplomatic_region_values) >= 8 and repeated:
            _, repeated_count = repeated.most_common(1)[0]
            if repeated_count / len(diplomatic_region_values) >= 0.60:
                possible_ocr_hallucinations.setdefault(page_number, set()).add(
                    "at least 60% of eight or more regions repeat the same text"
                )

        paper = hex_rgb(page.get("paper"))
        ink = hex_rgb(page.get("ink"))
        if paper is None:
            color_errors.append({"page": page_number, "issue": "invalid paper color"})
        else:
            paper_colors[str(page["paper"]).lower()] += 1
        if ink is None:
            color_errors.append({"page": page_number, "issue": "invalid ink color"})
        else:
            ink_colors[str(page["ink"]).lower()] += 1
        if paper is not None and ink is not None:
            contrast = contrast_ratio(paper, ink)
            color_contrasts.append(contrast)
            if contrast < 2.5:
                low_contrast_pages.append(
                    {
                        "page": page_number,
                        "issue": "sampled paper/ink contrast below 2.5:1",
                        "contrast": round(contrast, 3),
                        "block_characters": block_chars,
                    }
                )

    missing_scans: list[int] = []
    missing_thumbs: list[int] = []
    unreadable_scans: list[dict[str, Any]] = []
    unreadable_thumbs: list[dict[str, Any]] = []
    scan_dimension_mismatches: list[dict[str, Any]] = []
    art_state_mismatches: list[dict[str, Any]] = []
    unreadable_art: list[dict[str, Any]] = []
    declared_art_pages: list[int] = []
    published_art_pages: list[int] = []
    likely_illustration_without_art: list[dict[str, Any]] = []

    for page_number in sorted(expected_pages):
        page = parsed_pages.get(page_number)
        scan_path = public_book / "scan" / f"{page_number:04}.webp"
        thumb_path = public_book / "thumb" / f"{page_number:04}.webp"
        art_path = public_book / "art" / f"{page_number:04}.webp"
        if not scan_path.is_file():
            missing_scans.append(page_number)
        else:
            dimensions, error = image_header(scan_path)
            if error:
                unreadable_scans.append({"page": page_number, "issue": error})
            elif page and dimensions != (
                int(page.get("width") or 0),
                int(page.get("height") or 0),
            ):
                scan_dimension_mismatches.append(
                    {
                        "page": page_number,
                        "page_record": [page.get("width"), page.get("height")],
                        "scan": list(dimensions or ()),
                    }
                )
        if not thumb_path.is_file():
            missing_thumbs.append(page_number)
        else:
            _, error = image_header(thumb_path)
            if error:
                unreadable_thumbs.append({"page": page_number, "issue": error})
            elif page is not None and not page.get("ocr_suppression"):
                texture = image_texture_metrics(thumb_path)
                if (
                    texture
                    and page_text_characters.get(page_number, 0) > 10
                    and texture["luma_standard_deviation"] < 8
                    and texture["edge_fraction"] < 0.01
                ):
                    possible_ocr_hallucinations.setdefault(page_number, set()).add(
                        "substantial OCR text appears on a visually near-blank, low-edge thumbnail"
                    )
        if page is None:
            continue
        source_declares_art = any(
            region.get("role") in ART_ROLES
            or str(region.get("source_type") or "").lower() == "image"
            for region in page.get("regions") or []
        )
        if source_declares_art:
            declared_art_pages.append(page_number)
        record_has_art = bool(page.get("has_art"))
        file_has_art = art_path.is_file()
        if file_has_art:
            published_art_pages.append(page_number)
            _, error = image_header(art_path)
            if error:
                unreadable_art.append({"page": page_number, "issue": error})
        if record_has_art != file_has_art:
            art_state_mismatches.append(
                {
                    "page": page_number,
                    "record_has_art": record_has_art,
                    "file_has_art": file_has_art,
                }
            )
        if scan_path.is_file() and not file_has_art:
            visual = scan_visual_metrics(scan_path, page)
            reasons = []
            if source_declares_art:
                reasons.append("OCR returned an image-like region")
            if (
                visual
                and visual["unboxed_dark_fraction"] >= 0.055
                and visual["text_box_fraction"] <= 0.42
            ):
                reasons.append("high dark-content fraction outside text boxes")
            if reasons:
                likely_illustration_without_art.append(
                    {"page": page_number, "reasons": reasons, "visual": visual}
                )

    samples: list[dict[str, Any]] = []
    overlay_formats = ("webp", "png") if overlay_format == "both" else (overlay_format,)
    for page_number in [int(value) for value in book.get("qa_pages") or []]:
        page = parsed_pages.get(page_number)
        scan_path = public_book / "scan" / f"{page_number:04}.webp"
        overlays: list[str] = []
        overlay_error = None
        if page is not None and scan_path.is_file():
            try:
                for image_format in overlay_formats:
                    destination = (
                        public_book / "qa" / f"overlay-{page_number:04}.{image_format}"
                    )
                    render_overlay(
                        scan_path, destination, page, book, image_format=image_format
                    )
                    overlays.append(f"qa/{destination.name}")
            except (OSError, ValueError) as error:
                overlay_error = str(error)
        else:
            overlay_error = "page record or scan asset is unavailable"
        sample_regions = len(page.get("regions") or []) if page else 0
        sample_declared_art = (
            sum(
                1
                for region in page.get("regions") or []
                if region.get("role") in ART_ROLES
                or str(region.get("source_type") or "").lower() == "image"
            )
            if page
            else 0
        )
        samples.append(
            {
                "page": page_number,
                "overlays": overlays,
                "overlay_error": overlay_error,
                "automated": {
                    "regions": sample_regions,
                    "ocr_image_regions": sample_declared_art,
                    "confidence": page.get("confidence") if page else None,
                    "has_art_remainder": bool(page and page.get("has_art")),
                },
                "qualitative_annotation": annotation_for(
                    annotations, str(book["id"]), page_number
                ),
            }
        )

    sample_overlay_failures = [
        int(sample["page"]) for sample in samples if sample.get("overlay_error")
    ]
    sample_annotation_failures = [
        int(sample["page"])
        for sample in samples
        if not isinstance(sample.get("qualitative_annotation"), dict)
        or str(sample["qualitative_annotation"].get("status") or "").lower()
        != "observed"
    ]

    pdf_baseline = text_disagreement_baseline(
        pdf_path, parsed_pages, [int(value) for value in book.get("qa_pages") or []]
    )
    raw_ocr = inspect_raw_ocr(root, book)
    raw_translation = inspect_translation_cache(
        root,
        book,
        parsed_pages,
    )
    modern_coverage = populated_modern / eligible_modern if eligible_modern else 1.0
    normalized_pages_sha256 = pipeline_process.sha256_json(
        [
            {
                "page": page_number,
                "sha256": pipeline_process.sha256_json(page),
            }
            for page_number, page in sorted(parsed_pages.items())
        ]
    )
    release_fingerprint = pipeline_process.release_qa_fingerprint(
        book,
        public_book,
        annotations,
        normalized_pages_sha256,
    )
    blocking_conditions: list[str] = []
    if source_verification["status"] != "verified":
        blocking_conditions.append("source PDF was not verified against bytes, checksum, and page count")
    if sample_overlay_failures:
        blocking_conditions.append("configured sample overlay rendering failed")
    if sample_annotation_failures:
        blocking_conditions.append("configured human-review annotations are incomplete")
    if missing_pages or extra_pages or parse_errors:
        blocking_conditions.append("normalized page set is incomplete or unreadable")
    if geometry_errors or page_record_errors:
        blocking_conditions.append("page or region geometry validation failed")
    if not raw_ocr["complete"]:
        blocking_conditions.append("raw OCR provenance is incomplete")
    if not raw_translation["complete"]:
        blocking_conditions.append("translation cache provenance is incomplete")
    if missing_scans or missing_thumbs or unreadable_scans or unreadable_thumbs:
        blocking_conditions.append("scan or thumbnail assets are incomplete")
    if scan_dimension_mismatches:
        blocking_conditions.append("scan dimensions disagree with page records")
    if art_state_mismatches or unreadable_art:
        blocking_conditions.append("art assets disagree with page records")
    if eligible_modern and modern_coverage < 1:
        blocking_conditions.append("modern-English layer is incomplete")
    if possible_ocr_hallucinations:
        blocking_conditions.append(
            "possible OCR hallucination is present on a visually blank or highly repetitive page"
        )
    if color_errors:
        blocking_conditions.append("page color syntax validation failed")
    warnings: list[str] = []
    if low_confidence_pages:
        warnings.append("some pages have Mistral page confidence below 0.80")
    if low_capture_pages:
        warnings.append(
            "some block text captures under 80% of Markdown character count"
        )
    if likely_illustration_without_art:
        warnings.append(
            "illustration heuristic found pages without a published art layer"
        )
    if low_contrast_pages:
        warnings.append(
            "some pages have little sampled separation between paper and ink; blank-page OCR or color sampling should be reviewed"
        )
    if pdf_baseline.get("status") != "available":
        warnings.append("embedded-PDF disagreement baseline is unavailable")

    book_annotation = (annotations.get("books") or {}).get(str(book["id"])) or {}
    status = (
        "incomplete"
        if blocking_conditions
        else ("ready_with_warnings" if warnings else "ready")
    )
    report = {
        "schema": REPORT_SCHEMA,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "book": {
            "id": book["id"],
            "title": book["title"],
            "language": book["language"],
            "expected_pages": expected_count,
            "source_sha256": book["source_sha256"],
            "source_bytes": int(book["source_bytes"]),
            "normalized_pages_sha256": normalized_pages_sha256,
        },
        "source_verification": source_verification,
        "release_fingerprint": release_fingerprint,
        "result": {
            "status": status,
            "blocking_conditions": blocking_conditions,
            "warnings": warnings,
        },
        "methodology": {
            "scope": "Every normalized page record and expected published asset is checked; configured pages receive visual overlays.",
            "translation_isolation": "Each Mistral request contains exactly one physical page and returns modern text keyed directly to stable OCR region IDs; no post-hoc text redistribution is permitted.",
            "automated_checks_are_not_ground_truth": True,
            "limitations": [
                "Mistral confidence is model-reported confidence, not measured accuracy on this corpus.",
                "Block-to-Markdown character capture is a completeness signal, not a transcription-accuracy score.",
                "The embedded PDF text layer is a disagreement baseline, not ground truth; it may itself contain OCR errors.",
                "No character error rate, word error rate, or bounding-box IoU is claimed without manually prepared transcription and polygon ground truth.",
                "Illustration detection is a conservative triage heuristic and requires visual review of flagged pages.",
                "Qualitative sample notes are observations from prior overlay inspection, not exhaustive validation.",
            ],
        },
        "raw_ocr_provenance": raw_ocr,
        "translation_provenance": raw_translation,
        "page_completeness": {
            "expected": expected_count,
            "parsed": len(actual_pages & expected_pages),
            "missing": page_list(missing_pages),
            "unexpected": page_list(extra_pages),
            "parse_errors": parse_errors[:100],
            "parse_error_count": len(parse_errors),
            "unexpected_filenames": unexpected_files[:100],
            "complete": not missing_pages and not extra_pages and not parse_errors,
        },
        "layout_geometry": {
            "regions": sum(role_counts.values()),
            "role_counts": dict(sorted(role_counts.items())),
            "source_type_counts": dict(sorted(source_type_counts.items())),
            "invalid_region_count": len(geometry_errors),
            "invalid_regions": geometry_errors[:200],
            "page_record_error_count": len(page_record_errors),
            "page_record_errors": page_record_errors[:100],
        },
        "ocr_confidence": {
            "interpretation": "Model-reported diagnostic confidence; not empirical OCR accuracy.",
            "page_average": distribution(page_confidences),
            "page_minimum": distribution(minimum_confidences),
            "below_0_80": page_list(low_confidence_pages),
            "possible_hallucinations": [
                {"page": page, "reasons": sorted(reasons)}
                for page, reasons in sorted(possible_ocr_hallucinations.items())
            ],
            "suppressed_after_sample_review": suppressed_ocr_pages,
            "suppressed_regions_after_sample_review": suppressed_ocr_regions,
        },
        "block_markdown_capture": {
            "interpretation": "Diplomatic block-character count divided by Markdown-character count; Markdown syntax and image references can move this ratio away from 1.0.",
            "ratio": distribution(capture_ratios),
            "below_0_80": page_list(low_capture_pages),
        },
        "modern_layer": {
            "eligible_regions": eligible_modern,
            "populated_regions": populated_modern,
            "region_coverage": round(modern_coverage, 6),
            "diplomatic_characters": diplomatic_chars,
            "modern_characters": modern_chars,
            "incomplete_pages": page_list(incomplete_modern_pages),
            "reviewed_override_count": len(reviewed_modern_overrides),
            "reviewed_overrides": reviewed_modern_overrides,
        },
        "page_colors": {
            "interpretation": "Colors are sampled from each rendered scan; contrast checks validate usability, not historical colorimetry.",
            "valid_pages": len(parsed_pages)
            - len({item["page"] for item in color_errors}),
            "error_count": len(color_errors),
            "errors": color_errors[:100],
            "low_contrast_pages": low_contrast_pages[:100],
            "paper_ink_contrast": distribution(color_contrasts),
            "most_common_paper_colors": paper_colors.most_common(10),
            "most_common_ink_colors": ink_colors.most_common(10),
        },
        "assets": {
            "missing_scans": page_list(missing_scans),
            "missing_thumbnails": page_list(missing_thumbs),
            "unreadable_scans": unreadable_scans[:100],
            "unreadable_thumbnails": unreadable_thumbs[:100],
            "scan_dimension_mismatches": scan_dimension_mismatches[:100],
            "declared_art_pages": len(set(declared_art_pages)),
            "published_art_pages": len(set(published_art_pages)),
            "art_state_mismatches": art_state_mismatches[:100],
            "unreadable_art": unreadable_art[:100],
        },
        "illustration_triage": {
            "interpretation": "A page is flagged when it has an OCR image region or substantial dark scan content outside text boxes but no published art layer. Flags require visual review.",
            "likely_illustration_without_art": likely_illustration_without_art,
        },
        "embedded_pdf_text_disagreement": pdf_baseline,
        "sample_review": {
            "selection": "Fixed pages configured before the full run, spanning early, middle, and late book positions plus known layout challenges.",
            "annotation_method_note": annotations.get("method_note"),
            "book_observation": book_annotation.get("book_observation"),
            "pages": samples,
        },
    }
    destination = public_book / "qa" / "report.json"
    atomic_json(destination, report)
    print(
        f"{book['id']}: {status}; {len(parsed_pages)}/{expected_count} page records; "
        f"{len(expected_pages) - len(missing_scans)}/{expected_count} scans; "
        f"modern {modern_coverage:.1%}"
    )
    return report, bool(blocking_conditions)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config", type=Path, default=Path(__file__).with_name("books.json")
    )
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--public-dir", type=Path, required=True)
    parser.add_argument(
        "--source-dir",
        type=Path,
        help="Directory containing source PDFs; defaults to a source sibling of work-dir.",
    )
    parser.add_argument("--book", action="append", default=[])
    parser.add_argument(
        "--annotations",
        type=Path,
        default=Path(__file__).with_name("qa_annotations.json"),
    )
    parser.add_argument(
        "--overlay-format", choices=("webp", "png", "both"), default="webp"
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit with status 2 when a book has a blocking QA condition.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    books = load_books(args.config, set(args.book))
    if not books:
        raise SystemExit("No books selected")
    source_dir = args.source_dir
    if source_dir is None:
        candidate = args.work_dir.parent / "source"
        source_dir = candidate if candidate.is_dir() else None
    annotations = load_annotations(args.annotations)
    blocked = False
    for book in books:
        _, book_blocked = qa_book(
            book,
            args.work_dir,
            args.public_dir,
            source_dir,
            annotations,
            args.overlay_format,
        )
        blocked = blocked or book_blocked
    if args.strict and blocked:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
