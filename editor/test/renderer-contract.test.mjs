import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
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

test("blank canvas and keyboard provide history-free selection clearing routes", () => {
  assert.match(appSource, /className="page-stage" onClick=\{clearBlankSelection\}/);
  assert.match(appSource, /closest\?\.\("\[data-region-id\]"\)/);
  assert.match(appSource, /event\.key === "Escape"/);
  assert.match(appSource, /dispatch\("selection\.clear"\)/);
});

test("typography exposes accessible alignment and justification controls", () => {
  assert.match(appSource, /SegmentedControl/);
  assert.match(appSource, /aria-label="Text alignment"/);
  assert.match(appSource, /"justify", "align-justify", "Justify"/);
  assert.match(appSource, /property: "textAlign"/);
  assert.match(appSource, /property: "textAlignLast"/);
  assert.match(appSource, /property: "textJustify"/);
  assert.match(appSource, /property: "hyphens"/);
});

test("page appearance remains useful without a region and previews only on facsimile", () => {
  assert.match(appSource, /if \(!region\) return <PagePropertiesPanel/);
  assert.match(appSource, /aria-label="Page appearance scope"/);
  assert.match(appSource, /aria-label="Page texture"/);
  assert.match(appSource, /Background edits preview on the facsimile only/);
  assert.match(appSource, /const pageStyle = facsimile \?/);
  assert.match(stylesSource, /\.facsimile\[data-background-mode="solid"\][\s\S]*?background: var\(--paper\)/);
  assert.match(stylesSource, /\.facsimile\[data-texture="none"\] \.paper-grain[\s\S]*?display: none/);
});

test("transform UI uses compact numeric equivalents without permanent resize handles", () => {
  assert.match(appSource, /Horizontal region offset, percent of page/);
  assert.match(appSource, /Horizontal region scale, percent/);
  assert.match(appSource, /<summary>Exact bounds<\/summary>/);
  assert.match(appSource, /state\.context\.mode === "TRANSFORM"/);
  assert.doesNotMatch(appSource, /resize-corner/);
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
