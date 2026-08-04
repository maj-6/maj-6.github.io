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
    "font-size-control",
    "font-size-value",
    "font-family-control",
    "line-height-control",
    "line-height-value",
    "zoom-control",
    "zoom-value",
    "display-reset",
    "fullscreen-toggle",
    "spread-scroll",
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

test("reader exposes bounded, labelled display controls", () => {
  const ranges = [
    ["font-size-control", 75, 200, 5, 100],
    ["line-height-control", 85, 160, 5, 100],
    ["zoom-control", 50, 250, 10, 100]
  ];
  for (const [id, minimum, maximum, step, value] of ranges) {
    const tag = readerHtml.match(new RegExp(`<input[^>]+id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `${id} range is missing`);
    assert.match(readerHtml, new RegExp(`<label[^>]+for="${id}"`));
    assert.match(tag, /type="range"/);
    assert.match(tag, new RegExp(`min="${minimum}"`));
    assert.match(tag, new RegExp(`max="${maximum}"`));
    assert.match(tag, new RegExp(`step="${step}"`));
    assert.match(tag, new RegExp(`value="${value}"`));
  }
  assert.match(readerHtml, /<select id="font-family-control">[\s\S]*?value="edition"[\s\S]*?value="georgia"[\s\S]*?value="palatino"[\s\S]*?value="sans"/);
  assert.match(readerHtml, /id="fullscreen-toggle"[^>]+type="button"[^>]+aria-pressed="false"/);
});

test("reader persists typography while preserving explicit user sizing", () => {
  for (const key of [
    "whl-text-scale",
    "whl-font-choice",
    "whl-line-height-scale",
    "whl-page-zoom"
  ]) assert.ok(readerJs.includes(key), `reader does not persist ${key}`);
  assert.match(readerJs, /readNumberPreference/);
  assert.match(readerJs, /FONT_CHOICES\.includes/);
  assert.match(readerJs, /document\.body\.dataset\.readerFont/);
  assert.match(readerJs, /referenceSizeRatio/);
  assert.match(readerJs, /ratio \* pageWidth \* state\.textScale/);
  assert.match(readerJs, /region\.style\.fontSize = `\$\{Math\.floor\(requestedSize \* 10\) \/ 10\}px`/);
  assert.match(readerJs, /roleLineHeight\(region\.dataset\.role\) \* state\.lineHeightScale/);
  assert.match(readerJs, /region\.style\.lineHeight = String\(roleLineHeight/);
  assert.match(readerJs, /syncPanelHeaderHeights/);
  assert.match(readerJs, /elements\.fontSize\.addEventListener\("input", \(\) => setTextScale/);
  assert.match(readerJs, /elements\.fontFamily\.addEventListener\("change", \(\) => setFontChoice/);
  assert.match(readerJs, /elements\.lineHeight\.addEventListener\("input", \(\) => setLineHeight/);
  assert.match(readerJs, /elements\.displayReset\.addEventListener\("click", resetDisplayPreferences\)/);
  assert.match(readerCss, /data-reader-font="georgia"/);
  assert.match(readerCss, /data-reader-font="sans"/);
  assert.match(readerCss, /\.facsimile-text\.is-reference-fit/);
  assert.match(readerCss, /\.reading-settings:not\(\[open\]\) \.reading-settings-card\s*\{[^}]*display: none/);
});

test("numeric display preferences are bounded and fail closed", () => {
  const clampSource = readerJs.match(/function clamp[\s\S]*?(?=\n\n  function parsePage)/)?.[0];
  const preferenceSource = readerJs.match(/function readNumberPreference[\s\S]*?(?=\n\n  function savePreference)/)?.[0];
  assert.ok(clampSource && preferenceSource, "numeric-preference helpers could not be located");
  let storedValue = null;
  const fakeWindow = { localStorage: { getItem: () => storedValue } };
  const readNumberPreference = Function(
    "window",
    `${clampSource}\n${preferenceSource}; return readNumberPreference;`
  )(fakeWindow);
  assert.equal(readNumberPreference("key", 1, 0.5, 2.5), 1);
  storedValue = "1.25";
  assert.equal(readNumberPreference("key", 1, 0.5, 2.5), 1.25);
  storedValue = "-7";
  assert.equal(readNumberPreference("key", 1, 0.5, 2.5), 0.5);
  storedValue = "9";
  assert.equal(readNumberPreference("key", 1, 0.5, 2.5), 2.5);
  fakeWindow.localStorage.getItem = () => { throw new Error("storage disabled"); };
  assert.equal(readNumberPreference("key", 1, 0.5, 2.5), 1);
});

test("reader uses one adjacent, layout-zoomed spread", () => {
  assert.match(readerHtml, /id="spread-scroll"[^>]+tabindex="0"/);
  assert.match(readerCss, /\.page-spread\s*\{[^}]*grid-template-columns: repeat\(2, var\(--page-display-width\)\);[^}]*gap: 0;/);
  assert.match(readerCss, /\.page-viewport\s*\{[^}]*padding: 0;[^}]*overflow: visible;/);
  assert.match(readerCss, /\.spread-scroll\s*\{[^}]*overflow: auto;/);
  assert.match(readerCss, /\.scan-viewport \.page-loading,[\s\S]*?grid-area: 1 \/ 1;/);
  assert.match(readerJs, /--page-display-width/);
  assert.match(readerJs, /baseWidth \* state\.zoom/);
  assert.match(readerJs, /setProperty\("--page-display-width", `\$\{displayWidth\}px`\)/);
  assert.match(readerJs, /elements\.zoom\.addEventListener\("input", \(\) => setZoom/);
  assert.match(readerJs, /state\.zoomAnchor = spreadPosition\(\)/);
  assert.match(readerJs, /updatePageSizing\(state\.pageRatio, true, state\.zoomAnchor\)/);
  assert.ok(
    readerJs.indexOf("elements.pageRange.max") < readerJs.indexOf("elements.pageRange.value"),
    "page-range maximum must be set before its value to avoid clamping every page to 1"
  );
  assert.doesNotMatch(readerCss, /--page-max-width/);
  assert.doesNotMatch(readerCss, /transform:\s*scale\(/);
  assert.match(readerCss, /@media \(max-width: 850px\)[\s\S]*?grid-template-columns: var\(--page-display-width\)/);
});

test("fullscreen keeps controls available and has a CSS fallback", () => {
  assert.match(readerJs, /requestFullscreen/);
  assert.match(readerJs, /webkitRequestFullscreen/);
  assert.match(readerJs, /document\.exitFullscreen/);
  assert.match(readerJs, /webkitExitFullscreen/);
  assert.match(readerJs, /fullscreenchange/);
  assert.match(readerJs, /webkitfullscreenchange/);
  assert.match(readerJs, /enterFauxFullscreen/);
  assert.match(readerJs, /aria-pressed/);
  assert.match(readerJs, /request\.call\(elements\.shell\)/);
  assert.match(readerJs, /exit\.call\(document\)/);
  assert.match(readerJs, /elements\.fullscreenToggle\.addEventListener\("click", toggleFullscreen\)/);
  assert.match(readerJs, /event\.key === "Escape" && state\.fauxFullscreen/);
  assert.match(readerCss, /\.reader-shell\.is-faux-fullscreen\s*\{[^}]*position: fixed/);
  assert.match(readerCss, /\.reader-body\.has-reader-fullscreen \.reader-controls\s*\{[^}]*top: 0/);
  assert.match(readerCss, /\.reader-body\.has-reader-fullscreen > \.skip-link,[^}]*display: none/);
  assert.match(readerCss, /@media \(max-height: 520px\)[\s\S]*?\.reading-settings-card\s*\{[^}]*max-height:[^}]*overflow: auto/);
  assert.match(readerJs, /updateSpreadAccessibility/);
  assert.match(readerJs, /Original scan page/);
  assert.match(readerJs, /Facsimile page/);
  assert.match(readerHtml, /assets\/reader\.css\?v=3/);
  assert.match(readerHtml, /assets\/reader\.js\?v=3/);
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
  assert.match(readerJs, /await loadPage\(state\.page\);/, "volume changes must announce their loaded page");
  assert.doesNotMatch(readerJs, /await loadPage\(state\.page, false\)/);
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
