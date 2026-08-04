#!/usr/bin/env python3
"""Stage the explicit, reader-only GitHub Pages artifact."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path


PUBLIC_FILES = (
    ".nojekyll",
    "index.html",
    "reader.html",
    "method.html",
    "LICENSE",
    "NOTICE.md",
    "assets/reader.css",
    "assets/reader.js",
    "assets/region-settings.js",
    "assets/site.css",
    "assets/site.js",
    "data/catalog.json",
    "data/reader-config.json",
    "data/region-settings.json",
)
PUBLIC_CONTAINER_DIRECTORIES = ("assets", "data")
WINDOWS_REPARSE_POINT = 0x400


class StagingError(RuntimeError):
    """Raised when the Pages artifact cannot be staged safely."""


def _is_link_or_reparse_point(path: Path) -> bool:
    if path.is_symlink():
        return True
    try:
        attributes = getattr(path.stat(follow_symlinks=False), "st_file_attributes", 0)
    except OSError as error:
        raise StagingError(f"Could not inspect {path}: {error}") from error
    return bool(attributes & WINDOWS_REPARSE_POINT)


def _validate_public_file(root: Path, relative: str) -> Path:
    source = root / relative
    current = root
    parts = Path(relative).parts
    for index, part in enumerate(parts):
        current /= part
        if _is_link_or_reparse_point(current):
            raise StagingError(
                f"Public path must not be a link or reparse point: {current}"
            )
        if not current.exists():
            raise StagingError(f"Required public path is missing: {current}")
        if index < len(parts) - 1 and not current.is_dir():
            raise StagingError(f"Required public parent is not a directory: {current}")
    if not source.is_file():
        raise StagingError(f"Required public path is not a regular file: {source}")
    try:
        source.resolve(strict=True).relative_to(root)
    except ValueError as error:
        raise StagingError(f"Public path escaped the repository root: {source}") from error
    return source


def stage_pages(root: Path, output: Path) -> list[str]:
    """Copy only allowlisted static-reader paths into a fresh output directory."""
    root = root.resolve(strict=True)
    output = output.resolve(strict=False)
    if output.exists():
        raise StagingError(f"Output must not already exist: {output}")
    if output == root:
        raise StagingError("Output must not be the repository root")

    sources = {
        relative: _validate_public_file(root, relative) for relative in PUBLIC_FILES
    }
    for relative in PUBLIC_CONTAINER_DIRECTORIES:
        public_container = (root / relative).resolve(strict=True)
        try:
            output.relative_to(public_container)
        except ValueError:
            pass
        else:
            raise StagingError(
                f"Output must not be inside a public source directory: {public_container}"
            )

    output.mkdir(parents=True)
    copied: list[str] = []
    for relative in PUBLIC_FILES:
        source = sources[relative]
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied.append(relative)
    return copied


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    copied = stage_pages(args.root, args.output)
    print("Staged reader-only Pages artifact:")
    for path in copied:
        print(f"- {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
