import json
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import release_smoke  # noqa: E402


BOOK_IDS = ["latin-book", "german-book", "english-book"]
CDN_BASE = "https://cdn.example/v1"
ORIGIN = "https://maj-6.github.io"


def http_result(
    url,
    body,
    *,
    content_type="application/json",
    cors=ORIGIN,
    status=200,
):
    headers = [("Content-Type", content_type)]
    if cors is not None:
        headers.append(("Access-Control-Allow-Origin", cors))
    return release_smoke.HttpResult(url, url, status, tuple(headers), body)


class ReleaseFixture:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "pipeline").mkdir()
        (self.root / "data").mkdir()
        books = [
            {"id": book_id, "pages": 2, "cover_page": 1}
            for book_id in BOOK_IDS
        ]
        catalog_books = [
            {
                **book,
                "manifest": f"{CDN_BASE}/books/{book['id']}/manifest.json",
                "cover": f"{CDN_BASE}/books/{book['id']}/scan/0001.webp",
            }
            for book in books
        ]
        (self.root / "pipeline" / "books.json").write_text(
            json.dumps({"books": books}), encoding="utf-8"
        )
        (self.root / "data" / "catalog.json").write_text(
            json.dumps({"books": catalog_books}), encoding="utf-8"
        )
        (self.root / "data" / "reader-config.json").write_text(
            json.dumps(
                {
                    "schema": "whl-reader-config/1",
                    "projectId": "living-herbal",
                    "features": {"regionEditor": False},
                    "publishedSettings": "data/region-settings.json",
                    "draftStorageKey": "whl-region-settings-v1",
                }
            ),
            encoding="utf-8",
        )
        (self.root / "data" / "region-settings.json").write_text(
            json.dumps(
                {
                    "schema": "whl-region-settings/1",
                    "schemaVersion": 1,
                    "projectId": "living-herbal",
                    "overrides": {},
                }
            ),
            encoding="utf-8",
        )
        for path in release_smoke.POSTDEPLOY_PATHS:
            target = self.root / path
            if target.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(f"committed {path}\n".encode())

    def close(self):
        self.temp.cleanup()


class ReleaseSmokeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = ReleaseFixture()

    def tearDown(self):
        self.fixture.close()

    def cdn_fetch(self, url, origin):
        self.assertEqual(origin, ORIGIN)
        path = urlsplit(url).path
        book_id = next(book_id for book_id in BOOK_IDS if book_id in path)
        if path.endswith("manifest.json"):
            body = json.dumps(
                {
                    "id": book_id,
                    "pages": 2,
                    "data_pattern": f"{CDN_BASE}/books/{book_id}/data/{{page}}.json",
                    "page_pattern": f"{CDN_BASE}/books/{book_id}/scan/{{page}}.webp",
                }
            ).encode()
            return http_result(url, body)
        if path.endswith("data/0001.json"):
            return http_result(url, b'{"page": 1}')
        if path.endswith("scan/0001.webp"):
            return http_result(
                url,
                b"RIFF\x04\x00\x00\x00WEBP",
                content_type="image/webp",
            )
        self.fail(f"unexpected URL: {url}")

    def test_local_gate_requires_catalog_ids_to_match_three_configured_ids(self):
        _, catalog = release_smoke.validate_local_release(self.fixture.root)
        self.assertEqual([book["id"] for book in catalog["books"]], BOOK_IDS)

        catalog["books"][2]["id"] = "unexpected-book"
        (self.fixture.root / "data" / "catalog.json").write_text(
            json.dumps(catalog), encoding="utf-8"
        )
        with self.assertRaisesRegex(release_smoke.SmokeCheckError, "do not match"):
            release_smoke.validate_local_release(self.fixture.root)

    def test_local_gate_requires_literal_boolean_editor_flag(self):
        path = self.fixture.root / "data" / "reader-config.json"
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                path.write_text(
                    json.dumps(
                        {
                            "schema": "whl-reader-config/1",
                            "projectId": "living-herbal",
                            "features": {"regionEditor": enabled},
                            "publishedSettings": "data/region-settings.json",
                            "draftStorageKey": "whl-region-settings-v1",
                        }
                    ),
                    encoding="utf-8",
                )
                config, _ = release_smoke.validate_reader_configuration(
                    self.fixture.root
                )
                self.assertIs(config["features"]["regionEditor"], enabled)

        for invalid in (None, "true", 1, 0, [], {}):
            with self.subTest(invalid=invalid):
                path.write_text(
                    json.dumps(
                        {
                            "schema": "whl-reader-config/1",
                            "projectId": "living-herbal",
                            "features": {"regionEditor": invalid},
                            "publishedSettings": "data/region-settings.json",
                            "draftStorageKey": "whl-region-settings-v1",
                        }
                    ),
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(
                    release_smoke.SmokeCheckError, "must be a JSON boolean"
                ):
                    release_smoke.validate_reader_configuration(self.fixture.root)

    def test_local_gate_validates_published_region_settings_contract(self):
        path = self.fixture.root / "data" / "region-settings.json"
        _, settings = release_smoke.validate_reader_configuration(self.fixture.root)
        self.assertEqual(settings["schema"], "whl-region-settings/1")
        self.assertEqual(settings["schemaVersion"], 1)
        self.assertEqual(settings["projectId"], "living-herbal")
        self.assertEqual(settings["overrides"], {})

        settings["overrides"] = []
        path.write_text(json.dumps(settings), encoding="utf-8")
        with self.assertRaisesRegex(release_smoke.SmokeCheckError, "overrides"):
            release_smoke.validate_reader_configuration(self.fixture.root)

    def test_predeploy_reads_each_manifest_page_and_scan_with_exact_origin(self):
        calls = []

        def recording_fetch(url, origin):
            calls.append((url, origin))
            return self.cdn_fetch(url, origin)

        checked = release_smoke.validate_cdn_release(
            self.fixture.root,
            origin=ORIGIN,
            cdn_base=CDN_BASE,
            fetch=recording_fetch,
        )
        self.assertEqual(checked, BOOK_IDS)
        self.assertEqual(len(calls), 9)
        self.assertTrue(all(origin == ORIGIN for _, origin in calls))

    def test_predeploy_rejects_wildcard_cors(self):
        def wildcard_fetch(url, origin):
            result = self.cdn_fetch(url, origin)
            return release_smoke.HttpResult(
                result.requested_url,
                result.final_url,
                result.status,
                tuple(
                    (key, "*") if key == "Access-Control-Allow-Origin" else (key, value)
                    for key, value in result.headers
                ),
                result.body,
            )

        with self.assertRaisesRegex(release_smoke.SmokeCheckError, "exactly"):
            release_smoke.validate_cdn_release(
                self.fixture.root,
                origin=ORIGIN,
                cdn_base=CDN_BASE,
                fetch=wildcard_fetch,
            )

    def test_postdeploy_retries_stale_content_until_all_files_match(self):
        attempts = {"assets/reader.js": 0}
        expected = {
            path: (self.fixture.root / path).read_bytes()
            for path in release_smoke.POSTDEPLOY_PATHS
        }

        def pages_fetch(url, origin):
            self.assertIsNone(origin)
            path = urlsplit(url).path.lstrip("/")
            if path == "assets/reader.js":
                attempts[path] += 1
                if attempts[path] == 1:
                    return http_result(
                        url,
                        b"stale",
                        cors=None,
                        content_type="text/javascript",
                    )
            content_type = (
                "application/json"
                if path.endswith(".json")
                else "text/css"
                if path.endswith(".css")
                else "text/javascript"
                if path.endswith(".js")
                else "text/html"
            )
            return http_result(url, expected[path], cors=None, content_type=content_type)

        sleeps = []
        checked = release_smoke.validate_deployed_pages(
            self.fixture.root,
            site_url="https://maj-6.github.io/",
            attempts=2,
            retry_delay=0.25,
            cache_bust="test-sha",
            fetch=pages_fetch,
            sleep=sleeps.append,
        )
        self.assertEqual(checked, list(release_smoke.POSTDEPLOY_PATHS))
        self.assertEqual(sleeps, [0.25])
        self.assertEqual(attempts["assets/reader.js"], 2)
        self.assertIn("assets/region-settings.js", release_smoke.POSTDEPLOY_PATHS)
        self.assertIn("assets/reader.js", release_smoke.POSTDEPLOY_PATHS)
        self.assertIn("assets/reader.css", release_smoke.POSTDEPLOY_PATHS)
        self.assertIn("data/reader-config.json", release_smoke.POSTDEPLOY_PATHS)
        self.assertIn("data/region-settings.json", release_smoke.POSTDEPLOY_PATHS)

    def test_postdeploy_rejects_wrong_reader_asset_content_type(self):
        expected = {
            path: (self.fixture.root / path).read_bytes()
            for path in release_smoke.POSTDEPLOY_PATHS
        }

        def pages_fetch(url, origin):
            self.assertIsNone(origin)
            path = urlsplit(url).path.lstrip("/")
            content_type = (
                "application/json"
                if path.endswith(".json")
                else "text/css"
                if path.endswith(".css")
                else "text/html"
                if path.endswith(".js")
                else "text/html"
            )
            return http_result(url, expected[path], cors=None, content_type=content_type)

        with self.assertRaisesRegex(release_smoke.SmokeCheckError, "Content-Type"):
            release_smoke.validate_deployed_pages(
                self.fixture.root,
                site_url="https://maj-6.github.io/",
                attempts=1,
                fetch=pages_fetch,
            )


if __name__ == "__main__":
    unittest.main()
