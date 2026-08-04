import csv
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

import process  # noqa: E402
import publish_aws  # noqa: E402


class TranslationStrategyTests(unittest.TestCase):
    def test_reviewed_full_region_overrides_fill_missing_model_values(self):
        book = {
            "modern_text_overrides": {
                "p0001-r001": {"text": "Scan-reviewed text", "reason": "review"}
            }
        }
        merged = process.overlay_reviewed_translations(
            book,
            {"p0001-r002": "Model text"},
            {"p0001-r001", "p0001-r002"},
        )
        self.assertEqual(merged["p0001-r001"], "Scan-reviewed text")
        self.assertEqual(merged["p0001-r002"], "Model text")

    def test_read_json_rejects_duplicate_object_keys(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "duplicate.json"
            path.write_text('{"region": 1, "region": 2}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate JSON key: region"):
                process.read_json(path)

    def test_upload_gate_rejects_stale_qa_policy(self):
        policy = publish_aws.current_release_policy()
        book = policy["books"]["banckes-1552"]
        annotation_scope = {
            "method_note": policy["annotations"].get("method_note"),
            "book": (policy["annotations"].get("books") or {}).get(book["id"]),
        }
        fingerprint = {
            "contract_version": policy["contract_version"],
            "pipeline_version": process.PIPELINE_VERSION,
            "book_config_sha256": publish_aws.sha256_json(book),
            "annotations_sha256": publish_aws.sha256_json(annotation_scope),
            "assets_sha256": "a" * 64,
            "implementation_sha256": policy["implementation_sha256"],
        }
        report = {
            "book": {
                "source_sha256": book["source_sha256"],
                "source_bytes": book["source_bytes"],
                "normalized_pages_sha256": "b" * 64,
            },
            "sample_review": {"pages": [{"page": page} for page in book["qa_pages"]]},
        }
        fingerprint["sha256"] = publish_aws.sha256_json(
            {
                "qa_contract_version": fingerprint["contract_version"],
                "pipeline_version": fingerprint["pipeline_version"],
                "book_config_sha256": fingerprint["book_config_sha256"],
                "source_sha256": report["book"]["source_sha256"],
                "source_bytes": report["book"]["source_bytes"],
                "normalized_pages_sha256": report["book"]["normalized_pages_sha256"],
                "annotations_sha256": fingerprint["annotations_sha256"],
                "assets_sha256": fingerprint["assets_sha256"],
                "implementation_sha256": fingerprint["implementation_sha256"],
            }
        )
        publish_aws.verify_release_fingerprint(book["id"], report, fingerprint, policy)
        fingerprint["contract_version"] = "stale"
        with self.assertRaisesRegex(RuntimeError, "policy is stale"):
            publish_aws.verify_release_fingerprint(book["id"], report, fingerprint, policy)

    def test_qa_sample_pages_are_nonempty_unique_and_within_the_book(self):
        process.validate_book_config({"id": "valid", "pages": 10, "qa_pages": [1, 5, 10]})
        invalid_books = [
            ({"id": "empty", "pages": 10, "qa_pages": []}, "non-empty"),
            ({"id": "duplicate", "pages": 10, "qa_pages": [1, 1]}, "duplicates"),
            ({"id": "outside", "pages": 10, "qa_pages": [11]}, "outside 1..10"),
        ]
        for book, message in invalid_books:
            with self.subTest(book=book["id"]), self.assertRaisesRegex(SystemExit, message):
                process.validate_book_config(book)

    def test_selected_catalog_snapshot_and_sources_are_pinned(self):
        config = json.loads((ROOT / "pipeline" / "books.json").read_text(encoding="utf-8"))
        snapshot = ROOT / "pipeline" / config["catalog"]["selection_snapshot"]
        self.assertEqual(
            hashlib.sha256(snapshot.read_bytes()).hexdigest(),
            config["catalog"]["selection_snapshot_sha256"],
        )
        with snapshot.open(encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        rows_by_line = {int(row["catalog_line"]): row for row in rows}
        self.assertEqual(set(rows_by_line), {970, 1669, 2308})
        self.assertEqual(config["catalog"]["bytes"], 1514650)
        self.assertEqual(config["catalog"]["rows"], 5534)
        self.assertEqual(config["catalog"]["publication_files"], 5314)
        self.assertEqual(
            config["catalog"]["sha256"],
            "e94bc6c1f91a84307fc2a5c7c9b2afb8c75157f5e4372f9d8677a55ab5beb5c2",
        )
        self.assertEqual(len(config["books"]), 3)
        for book in config["books"]:
            row = rows_by_line[book["catalog_line"]]
            self.assertEqual(book["year"], int(row["Year Published"]))
            self.assertEqual(book["catalog_permalink"], row["Permalink"])
            self.assertEqual(book["source_url"], row["Publication File"])
            self.assertGreater(book["source_bytes"], 0)
            self.assertEqual(len(book["source_sha256"]), 64)
            self.assertTrue(book["bibliographic_record"].startswith("https://"))

    def test_release_qa_fingerprint_binds_assets_and_rejects_failed_status(self):
        book = {
            "id": "test-book",
            "source_sha256": "a" * 64,
            "source_bytes": 42,
            "qa_pages": [1],
        }
        annotations = {
            "method_note": "reviewed",
            "books": {"test-book": {"pages": {"1": {"status": "observed"}}}},
        }
        with tempfile.TemporaryDirectory() as temporary:
            public_book = Path(temporary)
            scan_dir = public_book / "scan"
            scan_dir.mkdir()
            scan = scan_dir / "0001.webp"
            scan.write_bytes(b"scan-one")
            fingerprint = process.release_qa_fingerprint(
                book, public_book, annotations, "b" * 64
            )
            report = {
                "schema": "whl-facsimile-qa/1",
                "book": {
                    "id": "test-book",
                    "source_sha256": "a" * 64,
                    "source_bytes": 42,
                    "normalized_pages_sha256": "b" * 64,
                },
                "result": {"status": "ready_with_warnings"},
                "release_fingerprint": fingerprint,
                "sample_review": {"pages": [{"page": 1}]},
            }
            self.assertTrue(
                process.release_qa_report_is_current(
                    report, book, "b" * 64, fingerprint
                )
            )
            report["result"]["status"] = "incomplete"
            self.assertFalse(
                process.release_qa_report_is_current(
                    report, book, "b" * 64, fingerprint
                )
            )
            scan.write_bytes(b"scan-two")
            changed = process.release_qa_fingerprint(
                book, public_book, annotations, "b" * 64
            )
            self.assertNotEqual(fingerprint["sha256"], changed["sha256"])

    def test_region_records_keep_ids_and_exclude_art_and_structural_matter(self):
        page = {
            "page": 7,
            "regions": [
                {
                    "id": "p0007-r001",
                    "role": "title",
                    "text": {"diplomatic": "# LOCVS"},
                },
                {
                    "id": "p0007-r002",
                    "role": "figure",
                    "text": {"diplomatic": "![plant](x)"},
                },
                {
                    "id": "p0007-r004",
                    "role": "signature-mark",
                    "text": {"diplomatic": "A 2"},
                },
                {
                    "id": "p0007-r003",
                    "role": "body",
                    "text": {"diplomatic": "In muris crescit."},
                },
            ],
        }
        self.assertEqual(
            process.translation_records([page]),
            [
                {
                    "id": "p0007-r001",
                    "page": 7,
                    "order": 0,
                    "role": "title",
                    "text": "LOCVS",
                },
                {
                    "id": "p0007-r003",
                    "page": 7,
                    "order": 0,
                    "role": "body",
                    "text": "In muris crescit.",
                },
            ],
        )

    def test_semantic_guards_reject_truncation_and_extra_region_ids(self):
        book = {"mode": "translate"}
        records = [
            {"id": "p0001-r001", "text": "lorem " * 100},
            {"id": "p0001-r002", "text": "ipsum " * 100},
        ]
        missing, invalid = process.translation_issues(
            book,
            records,
            {"p0001-r001": "Too short", "p0001-r002": "Too short"},
        )
        self.assertFalse(missing)
        self.assertEqual(invalid, {"p0001-r001", "p0001-r002"})

        missing, invalid = process.translation_issues(
            book,
            [records[0]],
            {
                "p0001-r001": "A complete modern rendering for this region only.",
                "p9999-r999": "extra",
            },
        )
        self.assertFalse(missing)
        self.assertEqual(invalid, {"p0001-r001"})

    def test_semantic_guards_reject_balanced_cross_region_containment(self):
        records = [
            {"id": "p0001-r001", "role": "body", "text": "wort " * 100},
            {"id": "p0001-r002", "role": "body", "text": "ander " * 100},
        ]
        first = "word " * 160
        second = "word " * 80
        missing, invalid = process.translation_issues(
            {"mode": "translate", "language_code": "de"},
            records,
            {"p0001-r001": first, "p0001-r002": second},
        )
        self.assertFalse(missing)
        self.assertEqual(invalid, {"p0001-r001", "p0001-r002"})

    def test_unchanged_proper_name_plate_is_not_mistaken_for_untranslated_prose(self):
        book = {"mode": "translate", "language_code": "la"}
        labels = "Abies alba Pinus sylvestris Quercus robur Rosa gallica " * 8
        prose = "Et in horto est planta, sed non ex aqua, quod cum sole crescit. " * 8
        self.assertFalse(
            process.unchanged_source_prose(
                book, labels, process.canonical_alnum(labels)
            )
        )
        self.assertTrue(
            process.unchanged_source_prose(book, prose, process.canonical_alnum(prose))
        )

    def test_region_guards_preserve_numerals_authorities_and_open_fragments(self):
        record = {
            "id": "p0009-r010",
            "role": "body",
            "text": "Dioscoride libro XVII demonstratur. Quod",
        }
        self.assertEqual(
            process.protected_anchor_issues(
                record, "Dioscorides demonstrates this in book XVII. For"
            ),
            [],
        )
        self.assertTrue(process.source_requires_open_end(record))
        self.assertFalse(
            process.source_requires_open_end(
                {"role": "body", "text": "It has the virtue that Bave is of."}
            )
        )
        missing, invalid = process.translation_issues(
            {"mode": "translate", "language_code": "la"},
            [record],
            {"p0009-r010": "Galen demonstrates this in book 17. For."},
        )
        self.assertFalse(missing)
        self.assertEqual(invalid, {"p0009-r010"})


if __name__ == "__main__":
    unittest.main()
