import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..", "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const indexHtml = read("index.html");
const readerHtml = read("reader.html");
const siteJs = read("assets/site.js");
const readerJs = read("assets/reader.js");
const readerCss = read("assets/reader.css");

test("browser scripts pass JavaScript syntax validation", () => {
  for (const file of ["assets/site.js", "assets/reader.js"]) {
    execFileSync(process.execPath, ["--check", resolve(root, file)], { stdio: "pipe" });
  }
});

test("pages use unique IDs and only local runtime assets", () => {
  for (const [name, html] of [["index.html", indexHtml], ["reader.html", readerHtml]]) {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${name} contains a duplicate id`);

    const runtimeAssets = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(runtimeAssets.every((asset) => !/^https?:/i.test(asset)), `${name} has an external runtime dependency`);
  }
});

test("landing page is catalogue driven and links to method documentation", () => {
  assert.match(siteJs, /data\/catalog\.json/);
  assert.match(siteJs, /catalog\.books/);
  assert.match(siteJs, /reader\.html/);
  assert.match(siteJs, /book\.cover_page/);
  assert.match(siteJs, /representativePageDescription/);
  assert.ok(!siteJs.includes("Cover of"), "representative interior pages must not be announced as book covers");
  assert.match(indexHtml, /Selected representative pages/);
  assert.match(indexHtml, /href="method\.html"/);
  assert.match(indexHtml, /machine|Mistral OCR/i);
  assert.match(indexHtml, /scan-derived and never redrawn|non-generative/i);
  assert.match(indexHtml, /modern region keyed to its source box/i);
  assert.doesNotMatch(indexHtml, /reflowed once across the source regions/i);
});

test("reader exposes all required navigation and comparison controls", () => {
  const requiredIds = [
    "book-select",
    "previous-page",
    "next-page",
    "page-input",
    "page-range",
    "layout-toggle",
    "scan-page",
    "facsimile-page",
    "filmstrip",
    "overflow-help"
  ];
  for (const id of requiredIds) assert.match(readerHtml, new RegExp(`id="${id}"`));
  assert.match(readerHtml, /value="modern"/);
  assert.match(readerHtml, /value="diplomatic"/);
  assert.match(readerHtml, /data-view="scan"/);
  assert.match(readerHtml, /data-view="facsimile"/);
  assert.match(readerHtml, /data-view="both"/);
});

test("reader consumes the manifest contract without injecting source HTML", () => {
  for (const field of [
    "page_pattern",
    "thumb_pattern",
    "data_pattern",
    "regions",
    "paper",
    "ink",
    "confidence",
    "body_family",
    "heading_family",
    "body_scale",
    "catalog_permalink",
    "pdf_url"
  ]) assert.ok(readerJs.includes(field), `reader does not reference ${field}`);
  assert.match(readerJs, /padStart\(4, "0"\)/);
  assert.ok(!readerJs.includes("innerHTML"), "reader must treat OCR and translation text as text, not markup");
});

test("reader implements responsive loading safeguards and honest QA links", () => {
  assert.match(readerJs, /new AbortController\(\)/);
  assert.match(readerJs, /pageController\?\.abort\(\)/);
  assert.match(readerJs, /prefetchAdjacent/);
  assert.match(readerJs, /IntersectionObserver/);
  assert.match(readerJs, /requestIdleCallback/);
  assert.match(readerJs, /pushState/);
  assert.match(readerJs, /popstate/);
  assert.match(readerJs, /object\.report/);
  assert.match(readerJs, /not a guarantee|Automated estimate only/);
  assert.match(readerJs, /sanitizeDisplayText/);
  assert.match(readerJs, /#\{1,6\}/);
  assert.match(readerJs, /CatalogRelative/);
  assert.match(readerJs, /preferredPage/);
  assert.ok(!/bookSelect\.value,\s*1\)/.test(readerJs), "volume switching must not force page 1");
});

test("reader preserves responsive access, focus, and readable overflow", () => {
  const loadPage = readerJs.match(/async function loadPage[\s\S]*?(?=\n\n  function renderFacsimileError)/)?.[0];
  assert.ok(loadPage, "loadPage function could not be located");
  assert.match(loadPage, /state\.currentPageData = null/);
  assert.match(loadPage, /state\.currentPageDataUrl = null/);
  assert.match(readerJs, /focusedPage[\s\S]*?focus\(\{ preventScroll: true \}\)/);
  assert.match(readerJs, /const minimum = 12/);
  assert.match(readerJs, /is-overflowing/);
  assert.match(readerJs, /aria-describedby", "overflow-help/);
  assert.match(readerJs, /Normalized modern English/);
  assert.match(readerJs, /readyInkColor|readableInkColor/);
  assert.match(readerJs, /passed with warnings/);
  assert.doesNotMatch(readerJs, /PageUp:\s*\(\)\s*=>/);
  assert.doesNotMatch(readerJs, /scrollIntoView\(/);
  assert.match(readerCss, /\.text-region\.is-overflowing\s*\{[\s\S]*?overflow: auto/);
  assert.doesNotMatch(readerCss, /@media \(max-width: 1120px\)[\s\S]*?\.overlay-control\s*\{\s*display: none/);
});

test("facsimile ink correction reaches readable contrast without changing good ink", () => {
  const clampSource = readerJs.match(/function clamp[\s\S]*?(?=\n\n  function parsePage)/)?.[0];
  const colorSource = readerJs.match(/function colorChannels[\s\S]*?(?=\n\n  function textLanguage)/)?.[0];
  assert.ok(clampSource && colorSource, "color-contrast helpers could not be located");
  const helpers = Function(`${clampSource}\n${colorSource}; return { colorChannels, contrastRatio, readableInkColor };`)();
  const paper = helpers.colorChannels("#ebecee");
  const corrected = helpers.readableInkColor("#ebecee", "#e8eaec");
  assert.notEqual(corrected, "#e8eaec");
  assert.ok(helpers.contrastRatio(paper, helpers.colorChannels(corrected)) >= 4.5);
  const boundary = helpers.readableInkColor("#d8bc9d", "#615444");
  assert.ok(helpers.contrastRatio(helpers.colorChannels("#d8bc9d"), helpers.colorChannels(boundary)) >= 4.5);
  assert.equal(helpers.readableInkColor("#eee2c5", "#29261e"), "#29261e");
});

test("representative pages drive landing links and accurate image descriptions", () => {
  const source = siteJs.match(/const representativePage[\s\S]*?(?=\n\n  const safeAccent)/)?.[0];
  assert.ok(source, "representative-page helpers could not be located");
  const helpers = Function("window", `${source}; return { representativePage, representativePageDescription, readerHref };`)({
    location: { href: "https://maj-6.github.io/index.html" }
  });
  const fuchs = {
    id: "fuchs-1542",
    title: "De Historia Stirpium",
    cover_page: 236,
    pages: 940
  };
  assert.equal(helpers.representativePage(fuchs), 236);
  assert.equal(helpers.readerHref(fuchs), "reader.html?book=fuchs-1542&page=236");
  assert.match(helpers.representativePageDescription(fuchs), /page 236.*full-page botanical woodcut/i);
  assert.doesNotMatch(helpers.representativePageDescription(fuchs), /cover/i);
  assert.match(helpers.representativePageDescription({
    id: "herbarius-1488",
    title: "Herbarius zu Teutsch",
    cover_page: 264,
    pages: 526
  }), /page 264.*botanical woodcut.*two columns of blackletter text/i);
  assert.match(helpers.representativePageDescription({
    id: "banckes-1552",
    title: "A Boke of the Propreties of Herbes",
    cover_page: 1,
    pages: 157
  }), /page 1.*title-page woodcut.*title and imprint text/i);
  assert.equal(helpers.representativePage({ cover_page: 999, pages: 12 }), 1);
});

test("reader defaults each volume to its valid representative page", () => {
  const source = readerJs.match(/function preferredPage[\s\S]*?(?=\n\n  function normalizedBox)/)?.[0];
  assert.ok(source, "preferredPage function could not be located");
  const preferredPage = Function(`${source}; return preferredPage;`)();
  assert.equal(preferredPage({ cover_page: 264, pages: 526 }), 264);
  assert.equal(preferredPage({ cover_page: 1, pages: 157 }), 1);
  assert.equal(preferredPage({ cover_page: 0, pages: 157 }), 1);
  assert.equal(preferredPage({ cover_page: 158, pages: 157 }), 1);
  assert.match(readerJs, /parsePage\(requestedPage, preferredPage\(book\)\)/);
  assert.match(readerJs, /params\.has\("page"\)/);
});

test("display sanitization removes OCR Markdown scaffolding without changing prose", () => {
  const source = readerJs.match(/function sanitizeDisplayText[\s\S]*?(?=\n\n  function makeTextRegion)/)?.[0];
  assert.ok(source, "sanitizeDisplayText function could not be located");
  const sanitizeDisplayText = Function(`${source}; return sanitizeDisplayText;`)();
  assert.equal(sanitizeDisplayText("# Apothecaries and their herbs"), "Apothecaries and their herbs");
  assert.equal(sanitizeDisplayText("   #### A chapter heading"), "A chapter heading");
  assert.equal(sanitizeDisplayText("![plant woodcut](img-12.jpeg)"), "");
  assert.equal(sanitizeDisplayText("Rue ![ornament](ornament.png) is hot and dry"), "Rue  is hot and dry");
  assert.equal(sanitizeDisplayText("Use the source scan."), "Use the source scan.");
});
