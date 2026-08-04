#!/usr/bin/env python3
"""Publish generated facsimile assets through private S3 and CloudFront.

The CLI is deliberately dry-run-first: ``bootstrap`` and ``upload`` make no
changes unless ``--apply`` is supplied. AWS credentials are obtained only from
the normal boto3 credential chain; they are never accepted as arguments or
written to the state file.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import json
import mimetypes
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


STATE_SCHEMA = "whl-aws-publication/1"
REGION = "us-west-1"
SITE_ORIGIN = "https://maj-6.github.io"
PROJECT_TAG = "world-herb-library-facsimiles"
MANAGED_BY_TAG = "whl-publish-aws-v1"
LONG_CACHE = "public,max-age=31536000,immutable"
SHORT_CACHE = "public,max-age=300,must-revalidate"
FORWARDED_HEADERS = {
    "Origin",
    "Access-Control-Request-Headers",
    "Access-Control-Request-Method",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Cannot read state file {path}: {error}") from error
    if not isinstance(value, dict) or value.get("schema") != STATE_SCHEMA:
        raise SystemExit(f"Unsupported or malformed state file: {path}")
    return value


def read_artifact_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Cannot read release artifact {path}: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"Unsupported or malformed release artifact: {path}")
    return value


def read_release_json(path: Path, schema: str) -> dict[str, Any]:
    value = read_artifact_json(path)
    if value.get("schema") != schema:
        raise RuntimeError(f"Unsupported or malformed release artifact: {path}")
    return value


def sha256_json(value: Any) -> str:
    canonical = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def current_release_policy() -> dict[str, Any]:
    pipeline_dir = Path(__file__).resolve().parent
    config = read_artifact_json(pipeline_dir / "books.json")
    annotations = read_artifact_json(
        pipeline_dir / str((config.get("qa") or {}).get("annotations") or "qa_annotations.json")
    )
    implementation_files = {
        name: hashlib.sha256((pipeline_dir / name).read_bytes()).hexdigest()
        for name in ("process.py", "qa.py")
    }
    books = {
        str(book.get("id")): book
        for book in config.get("books") or []
        if isinstance(book, dict) and book.get("id")
    }
    return {
        "contract_version": (config.get("qa") or {}).get("contract_version"),
        "implementation_sha256": sha256_json(implementation_files),
        "annotations": annotations,
        "books": books,
    }


def verify_release_fingerprint(
    book_id: str,
    report: dict[str, Any],
    fingerprint: dict[str, Any],
    policy: dict[str, Any],
) -> None:
    book = policy["books"].get(book_id)
    if not isinstance(book, dict):
        raise RuntimeError(f"{book_id} is not present in the current book config")
    annotation_scope = {
        "method_note": policy["annotations"].get("method_note"),
        "book": (policy["annotations"].get("books") or {}).get(book_id),
    }
    expected_fields = {
        "contract_version": policy["contract_version"],
        "book_config_sha256": sha256_json(book),
        "annotations_sha256": sha256_json(annotation_scope),
        "implementation_sha256": policy["implementation_sha256"],
    }
    mismatches = [
        key for key, expected in expected_fields.items() if fingerprint.get(key) != expected
    ]
    if mismatches:
        raise RuntimeError(
            f"Release QA policy is stale for {book_id}: {', '.join(mismatches)}"
        )
    report_book = report.get("book") or {}
    if (
        report_book.get("source_sha256") != book.get("source_sha256")
        or report_book.get("source_bytes") != book.get("source_bytes")
    ):
        raise RuntimeError(f"Release source binding is stale for {book_id}")
    sample_pages = [
        int(item.get("page"))
        for item in ((report.get("sample_review") or {}).get("pages") or [])
        if isinstance(item, dict) and item.get("page") is not None
    ]
    if sample_pages != [int(page) for page in book.get("qa_pages") or []]:
        raise RuntimeError(f"Release QA sample set is stale for {book_id}")
    qa_input = {
        "qa_contract_version": fingerprint.get("contract_version"),
        "pipeline_version": fingerprint.get("pipeline_version"),
        "book_config_sha256": fingerprint.get("book_config_sha256"),
        "source_sha256": report_book.get("source_sha256"),
        "source_bytes": report_book.get("source_bytes"),
        "normalized_pages_sha256": report_book.get("normalized_pages_sha256"),
        "annotations_sha256": fingerprint.get("annotations_sha256"),
        "assets_sha256": fingerprint.get("assets_sha256"),
        "implementation_sha256": fingerprint.get("implementation_sha256"),
    }
    if fingerprint.get("sha256") != sha256_json(qa_input):
        raise RuntimeError(f"Release fingerprint digest is invalid for {book_id}")


def release_visual_assets(book_dir: Path) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    for directory_name in ("scan", "thumb", "art"):
        directory = book_dir / directory_name
        paths = sorted(path for path in directory.rglob("*") if path.is_file()) if directory.is_dir() else []
        for path in paths:
            checksum, _, stat = sha256_file(path)
            records.append(
                {
                    "path": path.relative_to(book_dir).as_posix(),
                    "bytes": stat.st_size,
                    "sha256": checksum,
                }
            )
    return {
        "assets_sha256": sha256_json(records),
        "asset_files": len(records),
        "asset_bytes": sum(int(item["bytes"]) for item in records),
    }


def verify_release_tree(public_dir: Path) -> list[str]:
    """Fail closed unless the local upload tree is a complete reviewed release."""
    catalog = read_release_json(
        public_dir / "catalog.json", "whl-facsimile-catalog/1"
    )
    rows = catalog.get("books") or []
    book_ids = [str(row.get("id") or "") for row in rows if isinstance(row, dict)]
    if not book_ids or len(book_ids) != len(set(book_ids)):
        raise RuntimeError("Release catalog has missing or duplicate book IDs")
    if any(not re.fullmatch(r"[a-z0-9][a-z0-9-]*", book_id) for book_id in book_ids):
        raise RuntimeError("Release catalog contains an unsafe book ID")
    policy = current_release_policy()
    if set(book_ids) != set(policy["books"]):
        raise RuntimeError("Release catalog differs from the current book config")
    books_dir = public_dir / "books"
    actual_book_ids = {
        path.name for path in books_dir.iterdir() if path.is_dir()
    } if books_dir.is_dir() else set()
    if actual_book_ids != set(book_ids):
        raise RuntimeError(
            "Release catalog/book directories differ: "
            f"catalog={sorted(book_ids)}, directories={sorted(actual_book_ids)}"
        )
    expected_names: dict[int, set[str]] = {}
    for book_id in book_ids:
        book_dir = books_dir / book_id
        manifest = read_release_json(
            book_dir / "manifest.json", "whl-facsimile-manifest/1"
        )
        if manifest.get("id") != book_id:
            raise RuntimeError(f"Manifest ID mismatch for {book_id}")
        qa = manifest.get("qa") or {}
        if qa.get("status") not in {"ready", "ready_with_warnings"}:
            raise RuntimeError(f"Release QA is not ready for {book_id}")
        report = read_release_json(
            book_dir / "qa" / "report.json", "whl-facsimile-qa/1"
        )
        if (report.get("result") or {}).get("status") != qa.get("status"):
            raise RuntimeError(f"Manifest/report QA status mismatch for {book_id}")
        fingerprint = report.get("release_fingerprint")
        if not isinstance(fingerprint, dict):
            raise RuntimeError(f"Release fingerprint is missing for {book_id}")
        verify_release_fingerprint(book_id, report, fingerprint, policy)
        visual_assets = release_visual_assets(book_dir)
        if any(
            fingerprint.get(key) != visual_assets[key]
            for key in ("assets_sha256", "asset_files", "asset_bytes")
        ):
            raise RuntimeError(f"Reviewed visual assets changed for {book_id}")
        page_count = int(manifest.get("pages") or 0)
        if page_count < 1:
            raise RuntimeError(f"Manifest page count is invalid for {book_id}")
        names = expected_names.setdefault(
            page_count, {f"{page:04}.webp" for page in range(1, page_count + 1)}
        )
        for directory_name in ("scan", "thumb"):
            directory = book_dir / directory_name
            actual = {path.name for path in directory.glob("*.webp") if path.is_file()}
            if actual != names:
                raise RuntimeError(
                    f"{book_id} {directory_name} set is incomplete or unexpected"
                )
        data_names = {
            f"{page:04}.json" for page in range(1, page_count + 1)
        }
        data_dir = book_dir / "data"
        actual_data = {
            path.name for path in data_dir.glob("*.json") if path.is_file()
        }
        if actual_data != data_names:
            raise RuntimeError(f"{book_id} page-data set is incomplete or unexpected")
        public_page_hashes = [
            {
                "page": page,
                "sha256": sha256_json(
                    read_artifact_json(data_dir / f"{page:04}.json")
                ),
            }
            for page in range(1, page_count + 1)
        ]
        if (manifest.get("statistics") or {}).get("page_data_sha256") != sha256_json(
            public_page_hashes
        ):
            raise RuntimeError(f"Published page data changed for {book_id}")
    return book_ids


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def aws_session(profile: str | None, region: str) -> tuple[Any, Any]:
    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:
        raise SystemExit("Install boto3 first: python -m pip install boto3") from error
    session = boto3.Session(profile_name=profile or None, region_name=region)
    config = Config(retries={"mode": "standard", "max_attempts": 10})
    return session, config


def error_code(error: Exception) -> str:
    response = getattr(error, "response", {})
    return str((response.get("Error") or {}).get("Code") or "")


def identity(session: Any, config: Any) -> tuple[str, str]:
    response = session.client("sts", config=config).get_caller_identity()
    account_id = str(response["Account"])
    arn = str(response.get("Arn") or "arn:aws:iam::")
    parts = arn.split(":", 2)
    partition = parts[1] if len(parts) > 1 and parts[1] else "aws"
    if not re.fullmatch(r"\d{12}", account_id):
        raise RuntimeError("STS returned an unexpected AWS account id")
    return account_id, partition


def validate_bucket_name(value: str) -> str:
    name = value.strip().lower()
    reserved_prefixes = ("xn--", "sthree-", "amzn_s3_demo_")
    reserved_suffixes = ("-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3")
    if (
        not 3 <= len(name) <= 63
        or not re.fullmatch(r"[a-z0-9][a-z0-9.-]*[a-z0-9]", name)
        or ".." in name
        or re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", name)
        or name.startswith(reserved_prefixes)
        or name.endswith(reserved_suffixes)
    ):
        raise SystemExit(f"Invalid or reserved S3 bucket name: {value!r}")
    return name


def validate_prefix(value: str) -> str:
    prefix = value.strip().strip("/")
    if not prefix or "\\" in prefix or "//" in prefix or len(prefix) > 128:
        raise SystemExit("The version prefix must be a non-empty POSIX path")
    path = PurePosixPath(prefix)
    if any(part in {"", ".", ".."} for part in path.parts):
        raise SystemExit("The version prefix may not contain empty, . or .. segments")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", prefix):
        raise SystemExit(f"Unsafe version prefix: {value!r}")
    return prefix


def state_value(state: dict[str, Any], key: str, supplied: str | None) -> str | None:
    stored = str(state.get(key) or "") or None
    if supplied and stored and supplied != stored:
        raise SystemExit(
            f"{key.replace('_', ' ').title()} conflicts with the existing state file: "
            f"{supplied!r} != {stored!r}"
        )
    return supplied or stored


def desired_tags() -> dict[str, str]:
    return {
        "Project": PROJECT_TAG,
        "ManagedBy": MANAGED_BY_TAG,
    }


def cors_is_desired(rules: list[dict[str, Any]]) -> bool:
    if len(rules) != 1:
        return False
    rule = rules[0]
    return all(
        (
            set(rule.get("AllowedOrigins") or []) == {SITE_ORIGIN},
            set(rule.get("AllowedMethods") or []) == {"GET", "HEAD"},
            set(rule.get("AllowedHeaders") or []) == {"Range"},
            set(rule.get("ExposeHeaders") or [])
            == {"Accept-Ranges", "Content-Length", "Content-Range", "ETag"},
            int(rule.get("MaxAgeSeconds", -1)) == 86400,
        )
    )


def get_bucket_tags(s3: Any, bucket: str, account_id: str) -> dict[str, str]:
    try:
        response = s3.get_bucket_tagging(Bucket=bucket, ExpectedBucketOwner=account_id)
    except Exception as error:  # botocore is intentionally a lazy dependency
        if error_code(error) in {"NoSuchTagSet", "NoSuchTagSetError"}:
            return {}
        raise
    return {
        str(item["Key"]): str(item["Value"]) for item in response.get("TagSet") or []
    }


def bucket_exists(s3: Any, bucket: str, account_id: str) -> bool:
    try:
        s3.head_bucket(Bucket=bucket, ExpectedBucketOwner=account_id)
        return True
    except Exception as error:
        if error_code(error) in {"404", "NoSuchBucket", "NotFound"}:
            return False
        raise RuntimeError(
            f"Cannot safely inspect bucket {bucket!r}; it may belong to another "
            "account or be in another region"
        ) from error


def ensure_bucket(
    s3: Any,
    bucket: str,
    account_id: str,
    *,
    region: str,
    state_trusts_bucket: bool,
    adopt_existing: bool,
) -> None:
    exists = bucket_exists(s3, bucket, account_id)
    if not exists:
        options: dict[str, Any] = {"Bucket": bucket}
        if region != "us-east-1":
            options["CreateBucketConfiguration"] = {"LocationConstraint": region}
        s3.create_bucket(**options)
        s3.get_waiter("bucket_exists").wait(
            Bucket=bucket, ExpectedBucketOwner=account_id
        )
        print(f"created private origin bucket {bucket}")
    else:
        tags = get_bucket_tags(s3, bucket, account_id)
        managed = all(tags.get(key) == value for key, value in desired_tags().items())
        if not managed and not (state_trusts_bucket or adopt_existing):
            raise RuntimeError(
                f"Refusing to adopt existing unmarked bucket {bucket!r}. "
                "Choose a new name or explicitly pass --adopt-existing-bucket."
            )

    current_tags = get_bucket_tags(s3, bucket, account_id)
    merged_tags = {**current_tags, **desired_tags()}
    if current_tags != merged_tags:
        s3.put_bucket_tagging(
            Bucket=bucket,
            ExpectedBucketOwner=account_id,
            Tagging={
                "TagSet": [
                    {"Key": key, "Value": value}
                    for key, value in sorted(merged_tags.items())
                ]
            },
        )

    desired_public_block = {
        "BlockPublicAcls": True,
        "IgnorePublicAcls": True,
        "BlockPublicPolicy": True,
        "RestrictPublicBuckets": True,
    }
    try:
        current_public_block = s3.get_public_access_block(
            Bucket=bucket, ExpectedBucketOwner=account_id
        )["PublicAccessBlockConfiguration"]
    except Exception as error:
        if error_code(error) not in {
            "NoSuchPublicAccessBlockConfiguration",
            "NoSuchPublicAccessBlock",
        }:
            raise
        current_public_block = {}
    if current_public_block != desired_public_block:
        s3.put_public_access_block(
            Bucket=bucket,
            ExpectedBucketOwner=account_id,
            PublicAccessBlockConfiguration=desired_public_block,
        )

    desired_encryption = {
        "Rules": [
            {
                "ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"},
                "BucketKeyEnabled": False,
            }
        ]
    }
    try:
        current_encryption = s3.get_bucket_encryption(
            Bucket=bucket, ExpectedBucketOwner=account_id
        )["ServerSideEncryptionConfiguration"]
    except Exception as error:
        if error_code(error) not in {
            "ServerSideEncryptionConfigurationNotFoundError",
            "NoSuchEncryptionConfiguration",
        }:
            raise
        current_encryption = {}
    current_rules = current_encryption.get("Rules") or []
    encrypted_with_aes = (
        len(current_rules) == 1
        and (current_rules[0].get("ApplyServerSideEncryptionByDefault") or {}).get(
            "SSEAlgorithm"
        )
        == "AES256"
    )
    if not encrypted_with_aes:
        s3.put_bucket_encryption(
            Bucket=bucket,
            ExpectedBucketOwner=account_id,
            ServerSideEncryptionConfiguration=desired_encryption,
        )

    versioning = s3.get_bucket_versioning(Bucket=bucket, ExpectedBucketOwner=account_id)
    if versioning.get("Status") != "Enabled":
        s3.put_bucket_versioning(
            Bucket=bucket,
            ExpectedBucketOwner=account_id,
            VersioningConfiguration={"Status": "Enabled"},
        )

    try:
        ownership = s3.get_bucket_ownership_controls(
            Bucket=bucket, ExpectedBucketOwner=account_id
        )["OwnershipControls"]
    except Exception as error:
        if error_code(error) not in {
            "OwnershipControlsNotFoundError",
            "NoSuchOwnershipControls",
        }:
            raise
        ownership = {}
    owner_enforced = any(
        rule.get("ObjectOwnership") == "BucketOwnerEnforced"
        for rule in ownership.get("Rules") or []
    )
    if not owner_enforced:
        s3.put_bucket_ownership_controls(
            Bucket=bucket,
            ExpectedBucketOwner=account_id,
            OwnershipControls={"Rules": [{"ObjectOwnership": "BucketOwnerEnforced"}]},
        )

    desired_cors = {
        "CORSRules": [
            {
                "AllowedHeaders": ["Range"],
                "AllowedMethods": ["GET", "HEAD"],
                "AllowedOrigins": [SITE_ORIGIN],
                "ExposeHeaders": [
                    "Accept-Ranges",
                    "Content-Length",
                    "Content-Range",
                    "ETag",
                ],
                "MaxAgeSeconds": 86400,
            }
        ]
    }
    try:
        current_cors = s3.get_bucket_cors(Bucket=bucket, ExpectedBucketOwner=account_id)
    except Exception as error:
        if error_code(error) not in {"NoSuchCORSConfiguration", "NoSuchCORS"}:
            raise
        current_cors = {}
    if not cors_is_desired(current_cors.get("CORSRules") or []):
        s3.put_bucket_cors(
            Bucket=bucket,
            ExpectedBucketOwner=account_id,
            CORSConfiguration=desired_cors,
        )


def oac_name(account_id: str, bucket: str) -> str:
    suffix = hashlib.sha256(bucket.encode("utf-8")).hexdigest()[:12]
    return f"whl-{account_id}-{suffix}"


def list_oacs(cloudfront: Any) -> Iterable[dict[str, Any]]:
    marker: str | None = None
    while True:
        options = {"Marker": marker} if marker else {}
        result = (
            cloudfront.list_origin_access_controls(**options).get(
                "OriginAccessControlList"
            )
            or {}
        )
        yield from result.get("Items") or []
        if not result.get("IsTruncated"):
            return
        marker = str(result.get("NextMarker") or "") or None


def get_oac(cloudfront: Any, oac_id: str) -> dict[str, Any] | None:
    try:
        return cloudfront.get_origin_access_control(Id=oac_id)
    except Exception as error:
        if error_code(error) in {"NoSuchOriginAccessControl", "404"}:
            return None
        raise


def ensure_oac(
    cloudfront: Any,
    account_id: str,
    bucket: str,
    stored_id: str | None,
) -> str:
    name = oac_name(account_id, bucket)
    existing = get_oac(cloudfront, stored_id) if stored_id else None
    if existing:
        actual_name = str(
            (
                existing["OriginAccessControl"].get("OriginAccessControlConfig") or {}
            ).get("Name")
            or ""
        )
        if actual_name != name:
            raise RuntimeError(
                f"State points to OAC {stored_id!r}, but it is not owned by this deployment"
            )
    if not existing:
        matches = [item for item in list_oacs(cloudfront) if item.get("Name") == name]
        if len(matches) > 1:
            raise RuntimeError(
                f"Multiple CloudFront OACs share the managed name {name!r}"
            )
        if matches:
            existing = get_oac(cloudfront, str(matches[0]["Id"]))

    desired = {
        "Name": name,
        "Description": f"Private S3 origin for {PROJECT_TAG}",
        "SigningProtocol": "sigv4",
        "SigningBehavior": "always",
        "OriginAccessControlOriginType": "s3",
    }
    if not existing:
        response = cloudfront.create_origin_access_control(
            OriginAccessControlConfig=desired
        )
        created_id = str(response["OriginAccessControl"]["Id"])
        print(f"created CloudFront origin access control {created_id}")
        return created_id

    item = existing["OriginAccessControl"]
    existing_config = item.get("OriginAccessControlConfig") or {}
    if existing_config != desired:
        response = cloudfront.update_origin_access_control(
            Id=str(item["Id"]),
            IfMatch=str(existing["ETag"]),
            OriginAccessControlConfig=desired,
        )
        item = response["OriginAccessControl"]
    return str(item["Id"])


def distribution_comment(account_id: str, bucket: str) -> str:
    return f"whl-facsimiles:{account_id}:{bucket}"


def origin_domain(bucket: str, region: str) -> str:
    return f"{bucket}.s3.{region}.amazonaws.com"


def forwarded_values() -> dict[str, Any]:
    return {
        "QueryString": False,
        "Cookies": {"Forward": "none"},
        "Headers": {
            "Quantity": len(FORWARDED_HEADERS),
            "Items": sorted(FORWARDED_HEADERS),
        },
        "QueryStringCacheKeys": {"Quantity": 0},
    }


def default_cache_behavior(origin_id: str) -> dict[str, Any]:
    methods = ["GET", "HEAD", "OPTIONS"]
    return {
        "TargetOriginId": origin_id,
        "TrustedSigners": {"Enabled": False, "Quantity": 0},
        "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {
            "Quantity": len(methods),
            "Items": methods,
            "CachedMethods": {"Quantity": len(methods), "Items": methods},
        },
        "SmoothStreaming": False,
        "Compress": True,
        "LambdaFunctionAssociations": {"Quantity": 0},
        "FunctionAssociations": {"Quantity": 0},
        "FieldLevelEncryptionId": "",
        "ForwardedValues": forwarded_values(),
        "MinTTL": 0,
        "DefaultTTL": 31536000,
        "MaxTTL": 31536000,
    }


def new_distribution_config(
    account_id: str,
    bucket: str,
    region: str,
    oac_id: str,
    caller_reference: str,
) -> dict[str, Any]:
    origin_id = f"s3-{bucket}"
    return {
        "CallerReference": caller_reference,
        "Aliases": {"Quantity": 0},
        "DefaultRootObject": "",
        "Origins": {
            "Quantity": 1,
            "Items": [
                {
                    "Id": origin_id,
                    "DomainName": origin_domain(bucket, region),
                    "OriginPath": "",
                    "CustomHeaders": {"Quantity": 0},
                    "S3OriginConfig": {"OriginAccessIdentity": ""},
                    "ConnectionAttempts": 3,
                    "ConnectionTimeout": 10,
                    "OriginShield": {"Enabled": False},
                    "OriginAccessControlId": oac_id,
                }
            ],
        },
        "OriginGroups": {"Quantity": 0},
        "DefaultCacheBehavior": default_cache_behavior(origin_id),
        "CacheBehaviors": {"Quantity": 0},
        "CustomErrorResponses": {"Quantity": 0},
        "Comment": distribution_comment(account_id, bucket),
        "Logging": {
            "Enabled": False,
            "IncludeCookies": False,
            "Bucket": "",
            "Prefix": "",
        },
        "PriceClass": "PriceClass_100",
        "Enabled": True,
        "ViewerCertificate": {"CloudFrontDefaultCertificate": True},
        "Restrictions": {"GeoRestriction": {"RestrictionType": "none", "Quantity": 0}},
        "WebACLId": "",
        "HttpVersion": "http2and3",
        "IsIPV6Enabled": True,
        "Staging": False,
    }


def list_distributions(cloudfront: Any) -> Iterable[dict[str, Any]]:
    marker: str | None = None
    while True:
        options = {"Marker": marker} if marker else {}
        listing = cloudfront.list_distributions(**options).get("DistributionList") or {}
        yield from listing.get("Items") or []
        if not listing.get("IsTruncated"):
            return
        marker = str(listing.get("NextMarker") or "") or None


def get_distribution(cloudfront: Any, distribution_id: str) -> dict[str, Any] | None:
    try:
        return cloudfront.get_distribution(Id=distribution_id).get("Distribution")
    except Exception as error:
        if error_code(error) in {"NoSuchDistribution", "404"}:
            return None
        raise


def distribution_config_is_desired(
    config: dict[str, Any],
    account_id: str,
    bucket: str,
    region: str,
    oac_id: str,
) -> bool:
    if config.get("Comment") != distribution_comment(account_id, bucket):
        return False
    if not config.get("Enabled") or not config.get("IsIPV6Enabled"):
        return False
    if (
        config.get("HttpVersion") != "http2and3"
        or config.get("PriceClass") != "PriceClass_100"
    ):
        return False
    if (config.get("Aliases") or {}).get("Quantity", 0) != 0:
        return False
    if (config.get("CacheBehaviors") or {}).get("Quantity", 0) != 0:
        return False
    if (config.get("OriginGroups") or {}).get("Quantity", 0) != 0:
        return False
    origins = (config.get("Origins") or {}).get("Items") or []
    if len(origins) != 1:
        return False
    origin = origins[0]
    expected_origin_id = f"s3-{bucket}"
    if any(
        (
            origin.get("Id") != expected_origin_id,
            origin.get("DomainName") != origin_domain(bucket, region),
            str(origin.get("OriginPath") or "") != "",
            origin.get("OriginAccessControlId") != oac_id,
            not isinstance(origin.get("S3OriginConfig"), dict),
            str((origin.get("S3OriginConfig") or {}).get("OriginAccessIdentity") or "")
            != "",
        )
    ):
        return False
    behavior = config.get("DefaultCacheBehavior") or {}
    allowed = behavior.get("AllowedMethods") or {}
    cached = allowed.get("CachedMethods") or {}
    values = behavior.get("ForwardedValues") or {}
    headers = (values.get("Headers") or {}).get("Items") or []
    return all(
        (
            behavior.get("TargetOriginId") == expected_origin_id,
            behavior.get("ViewerProtocolPolicy") == "redirect-to-https",
            behavior.get("Compress") is True,
            set(allowed.get("Items") or []) == {"GET", "HEAD", "OPTIONS"},
            set(cached.get("Items") or []) == {"GET", "HEAD", "OPTIONS"},
            values.get("QueryString") is False,
            (values.get("Cookies") or {}).get("Forward") == "none",
            set(headers) == FORWARDED_HEADERS,
            int(behavior.get("DefaultTTL", -1)) == 31536000,
            int(behavior.get("MaxTTL", -1)) == 31536000,
            int(behavior.get("MinTTL", -1)) == 0,
            (behavior.get("LambdaFunctionAssociations") or {}).get("Quantity", 0) == 0,
            (behavior.get("FunctionAssociations") or {}).get("Quantity", 0) == 0,
            str(config.get("DefaultRootObject") or "") == "",
            str(config.get("WebACLId") or "") == "",
            config.get("Staging") is not True,
            (config.get("ViewerCertificate") or {}).get("CloudFrontDefaultCertificate")
            is True,
            (config.get("Logging") or {}).get("Enabled") is False,
            (config.get("Restrictions") or {})
            .get("GeoRestriction", {})
            .get("RestrictionType")
            == "none",
        )
    )


def ensure_distribution(
    cloudfront: Any,
    account_id: str,
    bucket: str,
    region: str,
    oac_id: str,
    stored_id: str | None,
) -> dict[str, Any]:
    comment = distribution_comment(account_id, bucket)
    distribution = get_distribution(cloudfront, stored_id) if stored_id else None
    if (
        distribution
        and distribution.get("DistributionConfig", {}).get("Comment") != comment
    ):
        raise RuntimeError(
            f"State points to distribution {stored_id!r}, but it is not owned by this deployment"
        )
    if not distribution:
        matches = [
            item
            for item in list_distributions(cloudfront)
            if item.get("Comment") == comment
        ]
        if len(matches) > 1:
            raise RuntimeError(
                f"Multiple CloudFront distributions use marker {comment!r}"
            )
        if matches:
            distribution = get_distribution(cloudfront, str(matches[0]["Id"]))

    if not distribution:
        caller = f"{comment}:{utc_now()}"
        config = new_distribution_config(account_id, bucket, region, oac_id, caller)
        response = cloudfront.create_distribution_with_tags(
            DistributionConfigWithTags={
                "DistributionConfig": config,
                "Tags": {
                    "Items": [
                        {"Key": key, "Value": value}
                        for key, value in sorted(desired_tags().items())
                    ]
                },
            }
        )
        distribution = response["Distribution"]
        print(f"created CloudFront distribution {distribution['Id']}")
    else:
        distribution_id = str(distribution["Id"])
        config_response = cloudfront.get_distribution_config(Id=distribution_id)
        current = config_response["DistributionConfig"]
        if not distribution_config_is_desired(
            current, account_id, bucket, region, oac_id
        ):
            desired = new_distribution_config(
                account_id,
                bucket,
                region,
                oac_id,
                str(current["CallerReference"]),
            )
            response = cloudfront.update_distribution(
                Id=distribution_id,
                IfMatch=str(config_response["ETag"]),
                DistributionConfig=desired,
            )
            distribution = response["Distribution"]
            print(f"updated CloudFront distribution {distribution_id}")
    return distribution


def desired_bucket_policy(
    partition: str, bucket: str, distribution_arn: str
) -> dict[str, Any]:
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "AllowCloudFrontServicePrincipalReadOnly",
                "Effect": "Allow",
                "Principal": {"Service": "cloudfront.amazonaws.com"},
                "Action": "s3:GetObject",
                "Resource": f"arn:{partition}:s3:::{bucket}/*",
                "Condition": {"StringEquals": {"AWS:SourceArn": distribution_arn}},
            }
        ],
    }


def ensure_bucket_policy(
    s3: Any,
    account_id: str,
    partition: str,
    bucket: str,
    distribution_arn: str,
) -> None:
    desired = desired_bucket_policy(partition, bucket, distribution_arn)
    try:
        current_text = s3.get_bucket_policy(
            Bucket=bucket, ExpectedBucketOwner=account_id
        )["Policy"]
        current = json.loads(current_text)
    except Exception as error:
        if error_code(error) not in {"NoSuchBucketPolicy", "NoSuchPolicy"}:
            raise
        current = None
    if current != desired:
        s3.put_bucket_policy(
            Bucket=bucket,
            ExpectedBucketOwner=account_id,
            Policy=json.dumps(desired, separators=(",", ":"), sort_keys=True),
        )


def bootstrap(args: argparse.Namespace) -> int:
    state_path = args.state.resolve()
    state = read_json(state_path)
    region = state_value(state, "region", args.region) or REGION
    if region != REGION:
        raise SystemExit(f"This deployment is intentionally fixed to {REGION}")
    session, config = aws_session(args.profile, region)
    account_id, partition = identity(session, config)
    stored_account = str(state.get("account_id") or "")
    if stored_account and stored_account != account_id:
        raise SystemExit("The active AWS account does not match the state file")
    suggested_bucket = f"whl-facsimiles-{account_id}-{region}"
    requested_bucket = state_value(state, "bucket", args.bucket)
    bucket = validate_bucket_name(requested_bucket or suggested_bucket)
    prefix = validate_prefix(
        args.version_prefix or str(state.get("version_prefix") or "v1")
    )
    planned = {
        "mode": "apply" if args.apply else "dry-run",
        "account_id": account_id,
        "region": region,
        "bucket": bucket,
        "version_prefix": prefix,
        "site_origin": SITE_ORIGIN,
        "controls": [
            "S3 Block Public Access (all four settings)",
            "S3 default AES256 encryption and versioning",
            f"S3 CORS limited to {SITE_ORIGIN}",
            "CloudFront OAC, HTTPS redirect and compression",
            "S3 GetObject policy scoped to one CloudFront distribution ARN",
        ],
    }
    if not args.apply:
        print(json.dumps(planned, indent=2))
        print("dry run only; repeat with --apply to create or reconcile resources")
        return 0

    s3 = session.client("s3", region_name=region, config=config)
    cloudfront = session.client("cloudfront", region_name="us-east-1", config=config)
    state_trusts_bucket = bool(state and state.get("bucket") == bucket)
    ensure_bucket(
        s3,
        bucket,
        account_id,
        region=region,
        state_trusts_bucket=state_trusts_bucket,
        adopt_existing=args.adopt_existing_bucket,
    )
    oac_id = ensure_oac(
        cloudfront,
        account_id,
        bucket,
        str(state.get("oac_id") or "") or None,
    )
    distribution = ensure_distribution(
        cloudfront,
        account_id,
        bucket,
        region,
        oac_id,
        str(state.get("distribution_id") or "") or None,
    )
    distribution_id = str(distribution["Id"])
    distribution_arn = str(
        distribution.get("ARN")
        or f"arn:{partition}:cloudfront::{account_id}:distribution/{distribution_id}"
    )
    distribution_domain = str(distribution["DomainName"])
    ensure_bucket_policy(s3, account_id, partition, bucket, distribution_arn)
    new_state = {
        "schema": STATE_SCHEMA,
        "updated_at": utc_now(),
        "account_id": account_id,
        "partition": partition,
        "region": region,
        "bucket": bucket,
        "oac_id": oac_id,
        "distribution_id": distribution_id,
        "distribution_arn": distribution_arn,
        "distribution_domain": distribution_domain,
        "assets_base_url": f"https://{distribution_domain}/{prefix}",
        "version_prefix": prefix,
    }
    atomic_json(state_path, new_state)
    print(json.dumps(new_state, indent=2, sort_keys=True))
    print("bootstrap complete; CloudFront may remain InProgress for several minutes")
    return 0


def path_is_within(path: Path, parent: Path) -> bool:
    try:
        return os.path.commonpath((str(path), str(parent))) == str(parent)
    except ValueError:
        return False


def local_files(public_dir: Path, state_path: Path) -> list[Path]:
    if not public_dir.is_dir():
        raise SystemExit(f"Public asset directory does not exist: {public_dir}")
    root = public_dir.resolve()
    if path_is_within(state_path.resolve(), root):
        raise SystemExit("Keep the AWS state file outside the public asset directory")
    result: list[Path] = []
    for path in sorted(public_dir.rglob("*")):
        if path.is_symlink():
            raise RuntimeError(f"Refusing to follow symlink in public assets: {path}")
        if not path.is_file():
            continue
        resolved = path.resolve()
        if not path_is_within(resolved, root):
            raise RuntimeError(f"Asset escapes the public directory: {path}")
        result.append(path)
    if not result:
        raise SystemExit(f"No files found under {public_dir}")
    return result


def mime_type(path: Path) -> str:
    overrides = {
        ".json": "application/json",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
    }
    return (
        overrides.get(path.suffix.lower())
        or mimetypes.guess_type(path.name)[0]
        or "application/octet-stream"
    )


def cache_control(relative: PurePosixPath) -> str:
    if relative.name in {"catalog.json", "manifest.json", "report.json"}:
        return SHORT_CACHE
    if relative.suffix.lower() == ".html":
        return SHORT_CACHE
    return LONG_CACHE


def sha256_file(path: Path) -> tuple[str, str, os.stat_result]:
    before = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise RuntimeError(f"Asset changed while hashing: {path}")
    hexadecimal = digest.hexdigest()
    encoded = base64.b64encode(digest.digest()).decode("ascii")
    return hexadecimal, encoded, after


def upload_one(
    s3: Any,
    bucket: str,
    account_id: str,
    public_dir: Path,
    prefix: str,
    path: Path,
    allow_version_overwrite: bool,
) -> tuple[str, int]:
    relative = PurePosixPath(path.relative_to(public_dir).as_posix())
    key = f"{prefix}/{relative.as_posix()}"
    content_type = mime_type(path)
    caching = cache_control(relative)
    checksum, checksum_b64, stat = sha256_file(path)
    try:
        head = s3.head_object(Bucket=bucket, Key=key, ExpectedBucketOwner=account_id)
    except Exception as error:
        if error_code(error) not in {"404", "NoSuchKey", "NotFound"}:
            raise
        head = {}
    metadata = head.get("Metadata") or {}
    if (
        metadata.get("sha256") == checksum
        and int(head.get("ContentLength", -1)) == stat.st_size
        and head.get("ContentType") == content_type
        and head.get("CacheControl") == caching
        and head.get("ServerSideEncryption") == "AES256"
    ):
        return "skipped", stat.st_size
    if head and not allow_version_overwrite:
        raise RuntimeError(
            f"Refusing to replace immutable object s3://{bucket}/{key}; choose a "
            "new --version-prefix or explicitly pass --allow-version-overwrite"
        )
    with path.open("rb") as handle:
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=handle,
            ContentLength=stat.st_size,
            ContentType=content_type,
            CacheControl=caching,
            Metadata={"sha256": checksum},
            ServerSideEncryption="AES256",
            ChecksumSHA256=checksum_b64,
            ExpectedBucketOwner=account_id,
        )
    return "uploaded", stat.st_size


def verify_managed_bucket(s3: Any, state: dict[str, Any]) -> None:
    bucket = str(state["bucket"])
    account_id = str(state["account_id"])
    if not bucket_exists(s3, bucket, account_id):
        raise RuntimeError(f"Managed bucket no longer exists: {bucket}")
    tags = get_bucket_tags(s3, bucket, account_id)
    if not all(tags.get(key) == value for key, value in desired_tags().items()):
        raise RuntimeError(f"Bucket {bucket!r} is missing the managed-resource tags")


def upload(args: argparse.Namespace) -> int:
    state_path = args.state.resolve()
    state = read_json(state_path)
    if not state:
        raise SystemExit("Run bootstrap --apply before uploading assets")
    region = str(state["region"])
    if region != REGION:
        raise SystemExit(f"This deployment is intentionally fixed to {REGION}")
    public_dir = args.public_dir.resolve()
    release_books = verify_release_tree(public_dir)
    files = local_files(public_dir, state_path)
    total_bytes = sum(path.stat().st_size for path in files)
    prefix = validate_prefix(
        args.version_prefix or str(state.get("version_prefix") or "v1")
    )
    session, config = aws_session(args.profile, region)
    account_id, _ = identity(session, config)
    if account_id != str(state["account_id"]):
        raise SystemExit("The active AWS account does not match the state file")
    plan = {
        "mode": "apply" if args.apply else "dry-run",
        "bucket": state["bucket"],
        "prefix": prefix,
        "files": len(files),
        "bytes": total_bytes,
        "assets_base_url": f"https://{state['distribution_domain']}/{prefix}",
        "release_books": release_books,
        "deletes": 0,
        "allow_version_overwrite": args.allow_version_overwrite,
    }
    if not args.apply:
        print(json.dumps(plan, indent=2))
        print("dry run only; repeat with --apply to upload changed files")
        return 0

    s3 = session.client("s3", region_name=region, config=config)
    verify_managed_bucket(s3, state)
    counts = {"uploaded": 0, "skipped": 0}
    transferred = 0
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=max(1, args.workers)
    ) as pool:
        futures = [
            pool.submit(
                upload_one,
                s3,
                str(state["bucket"]),
                account_id,
                public_dir,
                prefix,
                path,
                args.allow_version_overwrite,
            )
            for path in files
        ]
        for completed, future in enumerate(concurrent.futures.as_completed(futures), 1):
            action, size = future.result()
            counts[action] += 1
            transferred += size
            if completed % 250 == 0 or completed == len(files):
                print(f"assets {completed}/{len(files)}")
    state["updated_at"] = utc_now()
    state["version_prefix"] = prefix
    state["assets_base_url"] = f"https://{state['distribution_domain']}/{prefix}"
    state["last_upload"] = {
        "completed_at": utc_now(),
        "prefix": prefix,
        "files": len(files),
        "bytes": transferred,
        **counts,
    }
    atomic_json(state_path, state)
    print(json.dumps({**plan, **counts}, indent=2))
    return 0


def policy_matches(s3: Any, state: dict[str, Any], partition: str) -> bool:
    try:
        value = json.loads(
            s3.get_bucket_policy(
                Bucket=str(state["bucket"]),
                ExpectedBucketOwner=str(state["account_id"]),
            )["Policy"]
        )
    except Exception:
        return False
    desired = desired_bucket_policy(
        partition, str(state["bucket"]), str(state["distribution_arn"])
    )
    return value == desired


def status(args: argparse.Namespace) -> int:
    state = read_json(args.state.resolve())
    if not state:
        raise SystemExit("State file not found; run bootstrap first")
    session, config = aws_session(args.profile, str(state["region"]))
    account_id, partition = identity(session, config)
    if account_id != str(state["account_id"]):
        raise SystemExit("The active AWS account does not match the state file")
    s3 = session.client("s3", region_name=str(state["region"]), config=config)
    cloudfront = session.client("cloudfront", region_name="us-east-1", config=config)
    bucket = str(state["bucket"])
    bucket_ok = bucket_exists(s3, bucket, account_id)
    details: dict[str, Any] = {
        "state": str(args.state.resolve()),
        "account_id": account_id,
        "region": state["region"],
        "bucket": bucket,
        "bucket_exists": bucket_ok,
        "assets_base_url": state["assets_base_url"],
    }
    checks: dict[str, bool] = {}
    if bucket_ok:
        tags = get_bucket_tags(s3, bucket, account_id)
        checks["managed_tags"] = all(
            tags.get(key) == value for key, value in desired_tags().items()
        )
        try:
            block = s3.get_public_access_block(
                Bucket=bucket, ExpectedBucketOwner=account_id
            )["PublicAccessBlockConfiguration"]
        except Exception:
            block = {}
        checks["public_access_block"] = all(
            block.get(key) is True
            for key in (
                "BlockPublicAcls",
                "IgnorePublicAcls",
                "BlockPublicPolicy",
                "RestrictPublicBuckets",
            )
        )
        try:
            rules = s3.get_bucket_encryption(
                Bucket=bucket, ExpectedBucketOwner=account_id
            )["ServerSideEncryptionConfiguration"]["Rules"]
        except Exception:
            rules = []
        checks["default_aes256"] = bool(rules) and all(
            (rule.get("ApplyServerSideEncryptionByDefault") or {}).get("SSEAlgorithm")
            == "AES256"
            for rule in rules
        )
        checks["versioning"] = (
            s3.get_bucket_versioning(Bucket=bucket, ExpectedBucketOwner=account_id).get(
                "Status"
            )
            == "Enabled"
        )
        try:
            cors = (
                s3.get_bucket_cors(Bucket=bucket, ExpectedBucketOwner=account_id).get(
                    "CORSRules"
                )
                or []
            )
        except Exception:
            cors = []
        checks["narrow_cors"] = cors_is_desired(cors)
        checks["cloudfront_only_policy"] = policy_matches(s3, state, partition)

    distribution = get_distribution(cloudfront, str(state["distribution_id"]))
    if distribution:
        details["distribution_id"] = distribution["Id"]
        details["distribution_domain"] = distribution["DomainName"]
        details["distribution_status"] = distribution["Status"]
        checks["distribution_configuration"] = distribution_config_is_desired(
            distribution["DistributionConfig"],
            account_id,
            bucket,
            str(state["region"]),
            str(state["oac_id"]),
        )
        checks["distribution_deployed"] = distribution["Status"] == "Deployed"
    else:
        checks["distribution_configuration"] = False
        checks["distribution_deployed"] = False
    details["checks"] = checks
    details["healthy"] = bucket_ok and all(checks.values())
    print(json.dumps(details, indent=2, sort_keys=True))
    return 0 if details["healthy"] else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Provision and publish World Herb Library facsimile assets to a "
            "private S3 origin behind CloudFront. Mutation commands are dry-run "
            "unless --apply is supplied."
        ),
        epilog=(
            "Examples:\n"
            "  python pipeline/publish_aws.py bootstrap --state C:\\safe\\whl-aws.json\n"
            "  python pipeline/publish_aws.py bootstrap --state C:\\safe\\whl-aws.json --apply\n"
            "  python pipeline/publish_aws.py upload --state C:\\safe\\whl-aws.json "
            "--public-dir C:\\build\\public --apply\n"
            "  python pipeline/publish_aws.py status --state C:\\safe\\whl-aws.json"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    commands = parser.add_subparsers(dest="command", required=True)

    bootstrap_parser = commands.add_parser(
        "bootstrap", help="plan or reconcile the private S3 + CloudFront origin"
    )
    bootstrap_parser.add_argument("--state", type=Path, required=True)
    bootstrap_parser.add_argument("--region", default=REGION, choices=[REGION])
    bootstrap_parser.add_argument(
        "--bucket", help="otherwise derived from STS account id"
    )
    bootstrap_parser.add_argument("--version-prefix", help="default: state value or v1")
    bootstrap_parser.add_argument("--profile", help="optional boto3 profile name")
    bootstrap_parser.add_argument(
        "--adopt-existing-bucket",
        action="store_true",
        help="explicitly allow an owned but unmarked bucket (off by default)",
    )
    bootstrap_parser.add_argument(
        "--apply", action="store_true", help="perform mutations; omitted means dry-run"
    )
    bootstrap_parser.set_defaults(handler=bootstrap)

    upload_parser = commands.add_parser(
        "upload", help="plan or upload assets beneath an immutable version prefix"
    )
    upload_parser.add_argument("--state", type=Path, required=True)
    upload_parser.add_argument("--public-dir", type=Path, required=True)
    upload_parser.add_argument("--version-prefix", help="default: state value or v1")
    upload_parser.add_argument("--workers", type=int, default=8)
    upload_parser.add_argument("--profile", help="optional boto3 profile name")
    upload_parser.add_argument(
        "--allow-version-overwrite",
        action="store_true",
        help=(
            "replace a changed key within the version prefix; safer default is "
            "to fail and use a new prefix"
        ),
    )
    upload_parser.add_argument(
        "--apply", action="store_true", help="perform uploads; omitted means dry-run"
    )
    upload_parser.set_defaults(handler=upload)

    status_parser = commands.add_parser(
        "status", help="read back AWS controls and CloudFront deployment status"
    )
    status_parser.add_argument("--state", type=Path, required=True)
    status_parser.add_argument("--profile", help="optional boto3 profile name")
    status_parser.set_defaults(handler=status)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if getattr(args, "workers", 1) < 1 or getattr(args, "workers", 1) > 64:
        parser.error("--workers must be between 1 and 64")
    return int(args.handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
