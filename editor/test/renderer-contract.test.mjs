import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../main/main.mjs", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../preload/preload.cjs", import.meta.url), "utf8");

test("renderer exposes keyboard-equivalent region context actions", () => {
  assert.match(appSource, /onContextMenu=/);
  assert.match(appSource, /event\.shiftKey && event\.key === "F10"/);
  assert.match(appSource, /Assign category/);
  assert.match(appSource, /Classes/);
  assert.match(appSource, /Edit custom labels in Properties/);
  assert.match(appSource, /View properties/);
});

test("decorated-initial controls remain scoped and secondary", () => {
  assert.match(appSource, /Decorated initial rendering/);
  assert.match(appSource, /defaultOpen=\{false\} secondary/);
  assert.match(appSource, /Book ·/);
  assert.match(appSource, /Page ·/);
  assert.match(appSource, /Region ·/);
  assert.match(appSource, /Original crop/);
  assert.match(appSource, /Diplomatic text/);
  assert.match(appSource, /Modern text/);
});

test("desktop boundary keeps Electron capabilities out of the renderer", () => {
  assert.match(mainSource, /contextIsolation: true/);
  assert.match(mainSource, /nodeIntegration: false/);
  assert.match(mainSource, /sandbox: true/);
  assert.match(mainSource, /setPermissionRequestHandler/);
  assert.match(mainSource, /will-download/);
  assert.doesNotMatch(appSource, /node:fs|ipcRenderer|child_process/);
  assert.doesNotMatch(preloadSource, /send\(|sendSync\(|on\(/);
});
