import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isAllowedDevelopmentUrl,
  isPathInside,
  isTrustedRendererUrl,
  resolveRendererAsset
} from "../main/security.mjs";

test("development origin is exact and loopback-only", () => {
  assert.equal(isAllowedDevelopmentUrl("http://127.0.0.1:5173/"), true);
  assert.equal(isAllowedDevelopmentUrl("http://localhost:5173/"), false);
  assert.equal(isAllowedDevelopmentUrl("http://127.0.0.1:5173/path"), false);
  assert.equal(isAllowedDevelopmentUrl("http://user@127.0.0.1:5173/"), false);
  assert.equal(isAllowedDevelopmentUrl("https://127.0.0.1:5173/"), false);
  assert.equal(isAllowedDevelopmentUrl("http://127.0.0.1:5174/"), false);
});

test("renderer trust accepts only application or configured development origins", () => {
  const developmentUrl = "http://127.0.0.1:5173/";
  assert.equal(isTrustedRendererUrl("whl-editor://app/index.html"), true);
  assert.equal(isTrustedRendererUrl("whl-editor://app.evil/index.html"), false);
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:5173/src/main.jsx", developmentUrl), true);
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:5174/src/main.jsx", developmentUrl), false);
  assert.equal(isTrustedRendererUrl("https://example.com/", developmentUrl), false);
});

test("application asset resolution rejects traversal and missing files", (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "whl-editor-security-"));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const rendererRoot = join(temporaryRoot, "dist");
  mkdirSync(join(rendererRoot, "assets"), { recursive: true });
  writeFileSync(join(rendererRoot, "index.html"), "ok");
  writeFileSync(join(rendererRoot, "assets", "app.js"), "ok");
  writeFileSync(join(temporaryRoot, "secret.txt"), "secret");

  assert.equal(resolveRendererAsset(rendererRoot, "/"), join(rendererRoot, "index.html"));
  assert.equal(resolveRendererAsset(rendererRoot, "/assets/app.js"), join(rendererRoot, "assets", "app.js"));
  assert.equal(resolveRendererAsset(rendererRoot, "/../secret.txt"), null);
  assert.equal(resolveRendererAsset(rendererRoot, "/%2e%2e/secret.txt"), null);
  assert.equal(resolveRendererAsset(rendererRoot, "/%00secret"), null);
  assert.equal(resolveRendererAsset(rendererRoot, "/missing.js"), null);
  assert.equal(isPathInside(rendererRoot, join(rendererRoot, "assets", "app.js")), true);
  assert.equal(isPathInside(rendererRoot, join(temporaryRoot, "secret.txt")), false);

  try {
    symlinkSync(join(temporaryRoot, "secret.txt"), join(rendererRoot, "assets", "escape.txt"), "file");
    assert.equal(resolveRendererAsset(rendererRoot, "/assets/escape.txt"), null);
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
  }
});
