import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..", "..");
const source = readFileSync(resolve(root, "assets", "region-settings.js"), "utf8");
const browserWindow = {};
new Function("window", source)(browserWindow);
const settings = browserWindow.WHLRegionSettings;

const projectId = "living-herbal";
const bookId = "fuchs-1542";
const regionTarget = { scope: "region", bookId, page: 12, regionId: "p0012-r003" };
const context = { bookId, page: 12, role: "header", regionId: "p0012-r003", layer: "modern" };
const documentWith = (overrides = {}) => ({
  schema: "whl-region-settings/1",
  schemaVersion: 1,
  projectId,
  overrides
});

test("exports the versioned browser engine and persistence adapters", () => {
  assert.equal(settings.SCHEMA, "whl-region-settings/1");
  assert.equal(settings.schemaVersion, 1);
  for (const name of ["createEngine", "createIndexedDBPersistence", "createLocalStoragePersistence", "createBrowserPersistence"]) {
    assert.equal(typeof settings[name], "function", `${name} should be exported`);
  }
});

test("resolves base and local properties through deterministic scope precedence", async () => {
  const base = documentWith({
    [bookId]: {
      book: { style: { fontFamily: "edition", fontSize: 1, color: "#111111" } },
      regionTypes: {
        header: { style: { fontWeight: 600, color: "#222222" }, fit: { mode: "grow-width" } }
      },
      pages: {
        "12": {
          style: { color: "#333333", lineHeight: 1.2 },
          regionTypes: {
            header: { style: { letterSpacing: 0.02 }, fit: { wrap: "nowrap" } }
          },
          regions: {
            "p0012-r003": { style: { fontSize: 1.4 }, geometry: { translateX: 0.01 } }
          }
        }
      }
    }
  });
  const local = documentWith({
    [bookId]: {
      book: { style: { fontFamily: "georgia" } },
      regionTypes: { header: { style: { fontWeight: 700 } } },
      pages: { "12": { style: { lineHeight: 1.3 }, regions: { "p0012-r003": { style: { color: "#abcdef" } } } } }
    },
    "banckes-1552": { book: { style: { fontSize: 3 } } }
  });
  const engine = settings.createEngine({
    base,
    local,
    projectId,
    editorEnabled: true,
    defaults: { style: { fontFamily: "sans", fontSize: 0.8, lineHeight: 1 } }
  });
  await engine.ready;

  assert.deepEqual(engine.resolve(context), {
    style: {
      fontFamily: "georgia",
      fontSize: 1.4,
      lineHeight: 1.3,
      color: "#abcdef",
      fontWeight: 700,
      letterSpacing: 0.02
    },
    geometry: { translateX: 0.01 },
    fit: { mode: "grow-width", wrap: "nowrap" },
    text: undefined,
    hasTextOverride: false
  });
  assert.equal(engine.resolve({ ...context, bookId: "banckes-1552" }).style.fontSize, 3);
  assert.equal(engine.resolve({ ...context, bookId: "herbarius-1488" }).style.fontSize, 0.8);

  assert.deepEqual(engine.getScope({ scope: "regionType", bookId, role: "header" }), {
    style: { fontWeight: 700, color: "#222222" },
    fit: { mode: "grow-width" }
  });
  assert.deepEqual(engine.getScope({ scope: "page", bookId, page: 12 }, { source: "local" }), {
    style: { lineHeight: 1.3 }
  }, "page scope reads must not expose nested type or region overrides");
});

test("write operations fail closed when the project editor flag is not exactly true", async () => {
  for (const editorEnabled of [false, undefined, 1, "true"]) {
    const engine = settings.createEngine({ projectId, editorEnabled });
    await engine.ready;
    assert.throws(
      () => engine.set({ scope: "book", bookId }, { style: { fontSize: 1.1 } }),
      settings.EditorDisabledError
    );
    assert.throws(() => engine.import(documentWith(), { mode: "replace" }), settings.EditorDisabledError);
    assert.throws(() => engine.undo(), settings.EditorDisabledError);
  }
});

test("strict validation rejects unknown values, unsafe keys, and prototype pollution", async () => {
  const engine = settings.createEngine({ projectId, editorEnabled: true });
  await engine.ready;
  assert.throws(() => engine.set({ scope: "book", bookId }, { style: { fontSize: 4.1 } }), settings.SettingsValidationError);
  assert.throws(() => engine.set({ scope: "book", bookId }, { style: { color: "red" } }), /hexadecimal color/);
  assert.throws(() => engine.set({ scope: "book", bookId }, { style: { color: "#12345678" } }), /hexadecimal color/);
  assert.throws(() => engine.set({ scope: "book", bookId }, { style: { fontFamily: "untrusted-font" } }), /edition, georgia, palatino, or sans/);
  assert.throws(() => engine.set({ scope: "book", bookId }, { style: { fontWeight: 550.5 } }), /integer/);
  assert.throws(() => engine.set({ scope: "book", bookId }, { fit: { mode: "magic" } }), /unsupported fitting mode/);
  assert.throws(() => engine.set({ scope: "book", bookId }, { geometry: { scaleX: 4.1 } }), /from 0.25 to 4/);
  assert.throws(() => engine.set({ scope: "book", bookId }, { fit: { minFontScale: 0.49 } }), /from 0.5 to 1/);
  assert.throws(() => engine.set({ scope: "book", bookId, page: 1 }, { style: {} }), /not valid for book scope/);
  assert.throws(() => engine.set({ scope: "book", bookId }, { arbitrary: true }), /unknown property/);

  const polluted = JSON.parse('{"schema":"whl-region-settings/1","schemaVersion":1,"projectId":"living-herbal","overrides":{"__proto__":{"book":{}}}}');
  assert.throws(() => engine.import(polluted), /unsafe key/);
  assert.equal({}.book, undefined);

  const alteredPrototype = { schema: settings.SCHEMA, schemaVersion: 1, projectId, overrides: {} };
  Object.setPrototypeOf(alteredPrototype, { compromised: true });
  assert.throws(() => engine.import(alteredPrototype), /plain object/);
});

test("modern and diplomatic text overrides are isolated and preserve intentional emptiness", async () => {
  const base = documentWith({
    [bookId]: { pages: { "12": { regions: { "p0012-r003": { text: { modern: "Base modern", diplomatic: "Base diplomatic" } } } } } }
  });
  const engine = settings.createEngine({ base, projectId, editorEnabled: true });
  await engine.ready;

  engine.setText(regionTarget, "modern", "");
  engine.setText(regionTarget, "diplomatic", "Edited diplomatic");
  assert.deepEqual(engine.resolve(context), {
    style: {}, geometry: {}, fit: {}, text: "", hasTextOverride: true
  });
  assert.equal(engine.resolve({ ...context, layer: "diplomatic" }).text, "Edited diplomatic");

  engine.clearText(regionTarget, "modern");
  assert.equal(engine.resolve(context).text, "Base modern", "clearing a local edit must reveal the base value");
  assert.equal(engine.resolve({ ...context, layer: "diplomatic" }).text, "Edited diplomatic");
});

test("write APIs build and remove sparse page and page-type scopes", async () => {
  const engine = settings.createEngine({ projectId, editorEnabled: true });
  await engine.ready;
  const pageTarget = { scope: "page", bookId, page: 12 };
  const pageTypeTarget = { scope: "pageRegionType", bookId, page: 12, role: "header" };
  engine.set({ scope: "book", bookId }, { style: { lineHeight: 1.1 } });
  engine.set({ scope: "regionType", bookId, role: "header" }, { style: { fontWeight: 600 } });
  engine.set(pageTarget, { style: { fontSize: 1.2, color: "#123456" } });
  engine.set(pageTypeTarget, { style: { fontSize: 1.4 }, geometry: { scaleX: 1.3 } });
  assert.deepEqual(engine.resolve(context).style, {
    lineHeight: 1.1,
    fontWeight: 600,
    fontSize: 1.4,
    color: "#123456"
  });
  assert.equal(engine.resolve(context).geometry.scaleX, 1.3);

  engine.remove(pageTypeTarget, ["style.fontSize", "geometry.scaleX"]);
  assert.equal(engine.resolve(context).style.fontSize, 1.2);
  assert.deepEqual(engine.resolve(context).geometry, {});
  engine.remove(pageTarget);
  assert.equal(engine.resolve(context).style.fontSize, undefined);
  assert.equal(engine.resolve(context).style.fontWeight, 600, "removing page scope must preserve nested and type scopes");
});

test("manual boxes are normalized, region-only, isolated, and immutable through snapshots", async () => {
  const engine = settings.createEngine({ projectId, editorEnabled: true });
  await engine.ready;
  assert.throws(
    () => engine.set({ scope: "regionType", bookId, role: "header" }, { geometry: { box: [0, 0, 0.5, 0.5] } }),
    /only valid for an exact region scope/
  );
  assert.throws(() => engine.set(regionTarget, { geometry: { box: [0.5, 0, 0.4, 1] } }), /positive width and height/);
  assert.throws(() => engine.set(regionTarget, { geometry: { box: [-0.1, 0, 0.4, 1] } }), /from 0 to 1/);

  engine.set(regionTarget, { geometry: { box: [0.1, 0.2, 0.9, 0.8], scaleX: 1.2 } });
  assert.deepEqual(engine.resolve(context).geometry, { box: [0.1, 0.2, 0.9, 0.8], scaleX: 1.2 });
  const snapshot = engine.snapshot();
  snapshot.local.overrides[bookId].pages["12"].regions["p0012-r003"].geometry.box[0] = 0.7;
  assert.equal(engine.resolve(context).geometry.box[0], 0.1, "snapshots must not expose mutable engine state");
});

test("idempotent writes do not add revisions, history, saves, or notifications", async () => {
  const saves = [];
  const persistence = {
    async load() { return null; },
    async save(_key, value) { saves.push(value); },
    async remove() {}
  };
  const engine = settings.createEngine({ projectId, editorEnabled: true, persistence });
  await engine.ready;
  const events = [];
  const unsubscribe = engine.subscribe((event) => events.push(event));

  assert.equal(engine.set({ scope: "book", bookId }, { style: { color: "#ABCDEF" } }), true);
  assert.equal(engine.set({ scope: "book", bookId }, { style: { color: "#abcdef" } }), false);
  await engine.flush();
  assert.equal(engine.snapshot().revision, 1);
  assert.equal(events.length, 1);
  assert.equal(saves.length, 1);
  assert.equal(engine.export().overrides[bookId].book.style.color, "#abcdef");
  unsubscribe();
});

test("undo, redo, and batches are atomic and publish one change event", async () => {
  const engine = settings.createEngine({ projectId, editorEnabled: true });
  await engine.ready;
  const events = [];
  engine.subscribe((event) => events.push(event));

  engine.batch((draft) => {
    draft.set({ scope: "book", bookId }, { style: { fontFamily: "edition" } });
    draft.set({ scope: "regionType", bookId, role: "header" }, { style: { fontWeight: 700 } });
    draft.setText(regionTarget, "modern", "Edited title");
  }, "three changes");
  assert.equal(engine.snapshot().revision, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].operations[0].op, "batch");
  assert.equal(engine.resolve(context).text, "Edited title");

  assert.equal(engine.undo(), true);
  assert.equal(engine.resolve(context).hasTextOverride, false);
  assert.equal(engine.redo(), true);
  assert.equal(engine.resolve(context).style.fontWeight, 700);
  assert.equal(engine.resolve(context).text, "Edited title");

  const beforeFailure = engine.export({ stringify: true });
  assert.throws(() => engine.batch([
    { op: "set", target: { scope: "book", bookId }, patch: { style: { lineHeight: 1.5 } } },
    { op: "set", target: { scope: "book", bookId }, patch: { style: { fontSize: 10 } } }
  ]), settings.SettingsValidationError);
  assert.equal(engine.export({ stringify: true }), beforeFailure, "failed batches must roll back every command");
});

test("JSON import and export round-trip canonically and reject corruption", async () => {
  const first = settings.createEngine({ projectId, editorEnabled: true });
  await first.ready;
  first.batch([
    { op: "set", target: { scope: "book", bookId }, patch: { style: { fontSize: 1.25, color: "#123456" } } },
    { op: "set", target: regionTarget, patch: { fit: { mode: "grow-then-shrink", wrap: "nowrap", overflow: "visible", maxWidthScale: 1.4, minFontScale: 0.7 } } },
    { op: "setText", target: regionTarget, layer: "modern", text: "A modern reading" }
  ]);
  const serialized = first.export({ stringify: true, pretty: true });

  const second = settings.createEngine({ projectId, editorEnabled: true });
  await second.ready;
  assert.equal(second.import(serialized, { mode: "replace" }), true);
  assert.deepEqual(second.export(), first.export());
  assert.equal(second.import(serialized, { mode: "replace" }), false, "reimporting an identical document is idempotent");
  assert.throws(() => second.import("{broken"), /invalid JSON/);
  assert.throws(() => second.import(serialized.replace("schemaVersion\": 1", "schemaVersion\": 2")), /schemaVersion/);
  assert.throws(() => second.import({ ...first.export(), projectId: "another-project" }), /must equal living-herbal/);
});

test("localStorage persistence round-trips and corrupt storage fails safely", async () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
  const persistence = settings.createLocalStoragePersistence({ storage, keyPrefix: "test:" });
  const first = settings.createEngine({ projectId, editorEnabled: true, persistence });
  await first.ready;
  first.set({ scope: "book", bookId }, { style: { fontFamily: "palatino", letterSpacing: 0.03 } });
  await first.flush();

  const second = settings.createEngine({ projectId, editorEnabled: true, persistence });
  await second.ready;
  assert.equal(second.resolve(context).style.fontFamily, "palatino");
  assert.equal(second.resolve(context).style.letterSpacing, 0.03);

  values.set("test:living-herbal", "{not-json");
  const corrupt = settings.createEngine({ projectId, editorEnabled: true, persistence });
  await corrupt.ready;
  assert.match(corrupt.snapshot().persistenceError, /corrupt/);
  assert.deepEqual(corrupt.export(), documentWith(), "corrupt persistence must not enter active state");
});

test("browser persistence falls back to localStorage when IndexedDB fails", async () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
  const indexedDB = { open() { throw new Error("blocked"); } };
  const persistence = settings.createBrowserPersistence({ indexedDB, storage, keyPrefix: "fallback:" });
  const expected = documentWith({ [bookId]: { book: { style: { fontSize: 1.2 } } } });
  await persistence.save(projectId, expected);
  assert.deepEqual(await persistence.load(projectId), expected);
  await persistence.remove(projectId);
  assert.equal(await persistence.load(projectId), null);
});
