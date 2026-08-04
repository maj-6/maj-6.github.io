from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts import stage_pages


class StagePagesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "repository"
        self.root.mkdir()
        for relative in stage_pages.PUBLIC_FILES:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"public {relative}\n", encoding="utf-8")
        (self.root / "editor").mkdir()
        (self.root / "editor" / "desktop-source.js").write_text(
            "must not deploy\n", encoding="utf-8"
        )
        (self.root / "packages").mkdir()
        (self.root / "packages" / "engine-source.js").write_text(
            "must not deploy\n", encoding="utf-8"
        )
        (self.root / "pipeline").mkdir()
        (self.root / "pipeline" / "private-build.py").write_text(
            "must not deploy\n", encoding="utf-8"
        )
        (self.root / "schemas").mkdir()
        (self.root / "schemas" / "editor-project.schema.json").write_text(
            "{}\n", encoding="utf-8"
        )
        self.forbidden_extras = (
            "assets/editor-source.js",
            "assets/reader.js.map",
            "data/local-draft.whlproject",
            "data/journal.ndjson",
            "data/project.json",
        )
        for relative in self.forbidden_extras:
            target = self.root / relative
            target.write_text("must not deploy\n", encoding="utf-8")

    @staticmethod
    def artifact_files(output: Path) -> set[str]:
        return {
            path.relative_to(output).as_posix()
            for path in output.rglob("*")
            if path.is_file() or path.is_symlink()
        }

    def test_manifest_names_exact_current_reader_files(self) -> None:
        self.assertEqual(
            set(stage_pages.PUBLIC_FILES),
            {
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
            },
        )

    def test_stages_only_reader_allowlist(self) -> None:
        output = Path(self.temporary.name) / "artifact"
        copied = stage_pages.stage_pages(self.root, output)

        self.assertEqual(copied, list(stage_pages.PUBLIC_FILES))
        self.assertEqual(self.artifact_files(output), set(stage_pages.PUBLIC_FILES))
        for relative in stage_pages.PUBLIC_FILES:
            self.assertTrue((output / relative).is_file())
        self.assertFalse((output / "editor").exists())
        self.assertFalse((output / "packages").exists())
        self.assertFalse((output / "pipeline").exists())
        self.assertFalse((output / "schemas").exists())

    def test_ignores_forbidden_extra_files_inside_public_containers(self) -> None:
        output = Path(self.temporary.name) / "artifact"
        stage_pages.stage_pages(self.root, output)

        for relative in self.forbidden_extras:
            self.assertFalse((output / relative).exists(), relative)

    def test_refuses_an_existing_output(self) -> None:
        output = Path(self.temporary.name) / "artifact"
        output.mkdir()
        with self.assertRaisesRegex(stage_pages.StagingError, "must not already exist"):
            stage_pages.stage_pages(self.root, output)

    def test_refuses_output_inside_public_tree(self) -> None:
        output = self.root / "assets" / "artifact"
        with self.assertRaisesRegex(stage_pages.StagingError, "must not be inside"):
            stage_pages.stage_pages(self.root, output)

    def test_refuses_an_allowlisted_file_link(self) -> None:
        link = self.root / "assets" / "reader.js"
        link.unlink()
        try:
            link.symlink_to(self.root / "editor" / "desktop-source.js")
        except (OSError, NotImplementedError):
            self.skipTest("Symbolic links are unavailable in this environment")

        output = Path(self.temporary.name) / "artifact"
        with self.assertRaisesRegex(stage_pages.StagingError, "must not be a link"):
            stage_pages.stage_pages(self.root, output)

    def test_refuses_an_allowlisted_parent_directory_link(self) -> None:
        assets = self.root / "assets"
        replacement = self.root / "linked-assets"
        assets.rename(replacement)
        try:
            assets.symlink_to(replacement, target_is_directory=True)
        except (OSError, NotImplementedError):
            replacement.rename(assets)
            self.skipTest("Symbolic links are unavailable in this environment")

        output = Path(self.temporary.name) / "artifact"
        with self.assertRaisesRegex(stage_pages.StagingError, "must not be a link"):
            stage_pages.stage_pages(self.root, output)

    def test_pages_workflow_builds_on_pull_requests_and_uploads_staged_artifact(
        self,
    ) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        workflow = (repository_root / ".github" / "workflows" / "pages.yml").read_text(
            encoding="utf-8"
        )
        build = workflow.split("  test-and-build:\n", 1)[1].split("\n  deploy:\n", 1)[0]
        deploy = workflow.split("\n  deploy:\n", 1)[1]

        self.assertIn("  pull_request:\n", workflow)
        self.assertIn("uses: actions/checkout@v6", build)
        self.assertIn("uses: actions/setup-python@v6", build)
        self.assertIn("uses: actions/setup-node@v6", build)
        self.assertIn('node-version: "22.12.0"', build)
        self.assertIn("scripts/stage_pages.py", workflow)
        self.assertIn("uses: actions/upload-pages-artifact@v5", build)
        self.assertIn("path: .pages-artifact", build)
        self.assertIn("include-hidden-files: true", build)
        self.assertIn("permissions:\n      contents: read", build)
        self.assertNotIn("pages: write", build)
        self.assertNotIn("id-token: write", build)
        self.assertNotIn("path: .\n", workflow)

        self.assertIn("needs: test-and-build", deploy)
        self.assertIn("github.event_name != 'pull_request'", deploy)
        self.assertIn("github.ref == 'refs/heads/main'", deploy)
        self.assertIn("pages: write", deploy)
        self.assertIn("id-token: write", deploy)
        self.assertIn("uses: actions/checkout@v6", deploy)
        self.assertIn("uses: actions/setup-python@v6", deploy)
        self.assertIn("uses: actions/configure-pages@v6", deploy)
        self.assertIn("uses: actions/deploy-pages@v5", deploy)
        self.assertIn("scripts/release_smoke.py --root . postdeploy", deploy)

    def test_editor_workflow_uses_node24_action_runtime(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        workflow = (
            repository_root / ".github" / "workflows" / "editor-ci.yml"
        ).read_text(encoding="utf-8")

        self.assertIn("uses: actions/checkout@v6", workflow)
        self.assertIn("uses: actions/setup-node@v6", workflow)


if __name__ == "__main__":
    unittest.main()
