(() => {
  "use strict";

  const CATALOG_PATH = "data/catalog.json";
  const FONT_CHOICES = ["edition", "georgia", "palatino", "sans"];
  const ROLE_TEXT_MAXIMUMS = Object.freeze({
    title: 42,
    heading: 30,
    header: 22,
    caption: 17,
    marginalia: 14,
    note: 14,
    footer: 15,
    "page-number": 15
  });
  const catalogUrl = new URL(CATALOG_PATH, window.location.href);
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

  const elements = {
    title: document.querySelector("#reader-title"),
    meta: document.querySelector("#reader-meta"),
    qaBadge: document.querySelector("#qa-badge"),
    qaHelp: document.querySelector("#qa-help"),
    bookSelect: document.querySelector("#book-select"),
    previous: document.querySelector("#previous-page"),
    next: document.querySelector("#next-page"),
    pageForm: document.querySelector("#page-form"),
    pageInput: document.querySelector("#page-input"),
    pageTotal: document.querySelector("#page-total"),
    pageRange: document.querySelector("#page-range"),
    modernLabel: document.querySelector("#modern-layer-label"),
    layerInputs: [...document.querySelectorAll('input[name="text-layer"]')],
    layoutToggle: document.querySelector("#layout-toggle"),
    viewButtons: [...document.querySelectorAll(".view-switcher button[data-view]")],
    shell: document.querySelector("#reader-shell"),
    controls: document.querySelector("#reader-controls"),
    spread: document.querySelector("#page-spread"),
    spreadScroll: document.querySelector("#spread-scroll"),
    message: document.querySelector("#reader-message"),
    scanImage: document.querySelector("#scan-page"),
    scanLoading: document.querySelector("#scan-loading"),
    scanError: document.querySelector("#scan-error"),
    facsimilePage: document.querySelector("#facsimile-page"),
    facsimileText: document.querySelector("#facsimile-text"),
    facsimileError: document.querySelector("#facsimile-error"),
    pageConfidence: document.querySelector("#page-confidence"),
    sourceLink: document.querySelector("#source-link"),
    filmstrip: document.querySelector("#filmstrip"),
    filmstripShell: document.querySelector(".filmstrip-shell"),
    readingSettings: document.querySelector("#reading-settings"),
    fontSize: document.querySelector("#font-size-control"),
    fontSizeValue: document.querySelector("#font-size-value"),
    fontFamily: document.querySelector("#font-family-control"),
    lineHeight: document.querySelector("#line-height-control"),
    lineHeightValue: document.querySelector("#line-height-value"),
    zoom: document.querySelector("#zoom-control"),
    zoomValue: document.querySelector("#zoom-value"),
    zoomHelp: document.querySelector("#zoom-help"),
    displayReset: document.querySelector("#display-reset"),
    fullscreenToggle: document.querySelector("#fullscreen-toggle"),
    fullscreenLabel: document.querySelector("#fullscreen-label"),
    live: document.querySelector("#reader-live"),
    keyboardHint: document.querySelector("#keyboard-hint")
  };

  const state = {
    catalog: null,
    book: null,
    manifest: null,
    manifestUrl: null,
    page: 1,
    totalPages: 1,
    layer: readPreference("whl-text-layer", "modern", ["modern", "diplomatic"]),
    view: readPreference("whl-page-view", "both", ["scan", "facsimile", "both"]),
    showLayout: readPreference("whl-show-layout", "false", ["true", "false"]) === "true",
    textScale: readNumberPreference("whl-text-scale", 1, 0.75, 2),
    fontChoice: readPreference("whl-font-choice", "edition", FONT_CHOICES),
    lineHeightScale: readNumberPreference("whl-line-height-scale", 1, 0.85, 1.6),
    zoom: readNumberPreference("whl-page-zoom", 1, 0.5, 2.5),
    zoomAnchor: null,
    fauxFullscreen: false,
    fullscreenActive: false,
    currentPageData: null,
    currentPageDataUrl: null,
    pageController: null,
    manifestController: null,
    prefetchController: null,
    prefetchIdle: null,
    pageSerial: 0,
    manifestSerial: 0,
    pageCache: new Map(),
    prefetching: new Map(),
    prefetchedImages: new Map(),
    thumbObserver: null,
    rangeTimer: 0,
    messageTimer: 0,
    fitFrame: 0,
    sizeFrame: 0,
    pageRatio: 0.72,
    pageDisplayWidth: 520
  };

  function readPreference(key, fallback, allowed) {
    try {
      const value = window.localStorage.getItem(key);
      return allowed.includes(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function readNumberPreference(key, fallback, minimum, maximum) {
    try {
      const value = Number.parseFloat(window.localStorage.getItem(key));
      return Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;
    } catch {
      return fallback;
    }
  }

  function savePreference(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Preferences are optional when storage is unavailable.
    }
  }

  function resolveUrl(value, base = window.location.href) {
    if (!value || typeof value !== "string") return "";
    try {
      return new URL(value, base).href;
    } catch {
      return "";
    }
  }

  function resolveLibraryAsset(value, preferredBase) {
    if (!value || typeof value !== "string") return "";
    const isCatalogRelative = /^books\//i.test(value.trim());
    return resolveUrl(value, isCatalogRelative ? catalogUrl : preferredBase);
  }

  function resolvePattern(pattern, page, base) {
    if (!pattern || typeof pattern !== "string") return "";
    const paddedPage = String(page).padStart(4, "0");
    return resolveLibraryAsset(pattern.replaceAll("{page}", paddedPage), base);
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function parsePage(value, fallback = 1) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function preferredPage(book) {
    const requested = Number.parseInt(book?.cover_page, 10);
    const pageCount = Number.parseInt(book?.pages, 10);
    return Number.isInteger(requested)
      && requested > 0
      && (!Number.isInteger(pageCount) || requested <= pageCount)
      ? requested
      : 1;
  }

  function normalizedBox(box, pageWidth, pageHeight) {
    if (!Array.isArray(box) || box.length < 4) return null;
    let [x0, y0, x1, y1] = box.map(Number);
    if (![x0, y0, x1, y1].every(Number.isFinite)) return null;

    if (Math.max(Math.abs(x0), Math.abs(x1)) > 1.001) {
      if (!Number.isFinite(pageWidth) || pageWidth <= 0) return null;
      x0 /= pageWidth;
      x1 /= pageWidth;
    }
    if (Math.max(Math.abs(y0), Math.abs(y1)) > 1.001) {
      if (!Number.isFinite(pageHeight) || pageHeight <= 0) return null;
      y0 /= pageHeight;
      y1 /= pageHeight;
    }

    x0 = clamp(x0, 0, 1);
    y0 = clamp(y0, 0, 1);
    x1 = clamp(x1, 0, 1);
    y1 = clamp(y1, 0, 1);
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
  }

  function normalizeConfidence(value) {
    if (value && typeof value === "object") {
      value = value.score ?? value.value ?? value.confidence;
    }
    if (typeof value === "string") value = Number.parseFloat(value.replace("%", ""));
    if (!Number.isFinite(value)) return null;
    if (value > 1 && value <= 100) value /= 100;
    return value >= 0 && value <= 1 ? value : null;
  }

  function cssColor(value, fallback) {
    let candidate = value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      candidate = value.color ?? value.value ?? value.hex;
      if (!candidate && [value.r, value.g, value.b].every(Number.isFinite)) {
        candidate = `rgb(${value.r} ${value.g} ${value.b})`;
      }
    } else if (Array.isArray(value) && value.length >= 3) {
      candidate = `rgb(${value.slice(0, 3).map(Number).join(" ")})`;
    }
    return typeof candidate === "string" && window.CSS?.supports?.("color", candidate) ? candidate : fallback;
  }

  function colorChannels(value) {
    const normalized = String(value || "").trim().toLowerCase();
    const hex = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
    if (hex) {
      const expanded = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
      return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16));
    }
    const rgb = normalized.match(/^rgba?\(\s*([\d.]+)(?:\s+|\s*,\s*)([\d.]+)(?:\s+|\s*,\s*)([\d.]+)/);
    return rgb ? rgb.slice(1, 4).map((channel) => clamp(Number(channel), 0, 255)) : null;
  }

  function relativeLuminance(channels) {
    const values = channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * values[0]) + (0.7152 * values[1]) + (0.0722 * values[2]);
  }

  function contrastRatio(first, second) {
    const firstLuminance = relativeLuminance(first);
    const secondLuminance = relativeLuminance(second);
    return (Math.max(firstLuminance, secondLuminance) + 0.05)
      / (Math.min(firstLuminance, secondLuminance) + 0.05);
  }

  function channelsToHex(channels) {
    return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
  }

  function readableInkColor(paper, requestedInk, minimumRatio = 4.5) {
    const paperChannels = colorChannels(paper);
    const inkChannels = colorChannels(requestedInk);
    if (!paperChannels || !inkChannels || contrastRatio(paperChannels, inkChannels) >= minimumRatio) {
      return requestedInk;
    }
    const black = [0, 0, 0];
    const white = [255, 255, 255];
    const target = contrastRatio(paperChannels, black) >= contrastRatio(paperChannels, white) ? black : white;
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 18; iteration += 1) {
      const amount = (low + high) / 2;
      const candidate = inkChannels.map((channel, index) => channel + ((target[index] - channel) * amount));
      if (contrastRatio(paperChannels, candidate) >= minimumRatio) high = amount;
      else low = amount;
    }
    let emitted = inkChannels.map((channel, index) => Math.round(channel + ((target[index] - channel) * high)));
    while (contrastRatio(paperChannels, emitted) < minimumRatio) {
      const next = emitted.map((channel, index) => {
        if (channel === target[index]) return channel;
        return channel + (target[index] > channel ? 1 : -1);
      });
      if (next.every((channel, index) => channel === emitted[index])) break;
      emitted = next;
    }
    return channelsToHex(emitted);
  }

  function textLanguage(language, layer) {
    if (layer === "modern") return "en";
    const name = String(language || "").toLowerCase();
    if (name.includes("latin")) return "la";
    if (name.includes("german") || name.includes("deutsch")) return "de";
    if (name.includes("english")) return "en";
    return "";
  }

  function safeRole(value) {
    const role = String(value || "text").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    return role || "text";
  }

  function sourceDetails(source) {
    if (typeof source === "string") return { url: resolveUrl(source, state.manifestUrl), label: "Source record" };
    if (!source || typeof source !== "object") return { url: "", label: "" };
    const rawUrl = source.catalog_permalink ?? source.url ?? source.record_url ?? source.archive_url ?? source.pdf_url ?? source.href;
    const label = source.label ?? source.name ?? (source.catalog_permalink ? "World Herb Library record" : source.pdf_url ? "Source PDF" : "Source record");
    return {
      url: resolveUrl(rawUrl, state.manifestUrl),
      label
    };
  }

  async function fetchJson(url, signal, cache = "force-cache") {
    const response = await fetch(url, {
      signal,
      cache,
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Request for ${url} returned ${response.status}`);
    return response.json();
  }

  function setMessage(text, mode = "loading", delayed = false) {
    window.clearTimeout(state.messageTimer);
    const show = () => {
      elements.message.classList.add("is-visible");
      elements.message.classList.toggle("is-error", mode === "error");
      elements.message.querySelector("span:last-child").textContent = text;
    };
    if (delayed) state.messageTimer = window.setTimeout(show, 240);
    else show();
  }

  function clearMessage() {
    window.clearTimeout(state.messageTimer);
    elements.message.classList.remove("is-visible", "is-error");
  }

  function announce(text) {
    elements.live.textContent = "";
    window.setTimeout(() => { elements.live.textContent = text; }, 20);
  }

  function cancelPrefetch() {
    state.prefetchController?.abort();
    state.prefetchController = null;
    if (!state.prefetchIdle) return;
    if (state.prefetchIdle.type === "idle" && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(state.prefetchIdle.id);
    } else {
      window.clearTimeout(state.prefetchIdle.id);
    }
    state.prefetchIdle = null;
  }

  function setControlsEnabled(enabled) {
    [elements.bookSelect, elements.pageInput, elements.pageRange].forEach((control) => { control.disabled = !enabled; });
    elements.previous.disabled = !enabled || state.page <= 1;
    elements.next.disabled = !enabled || state.page >= state.totalPages;
  }

  function updatePageControls() {
    elements.pageInput.max = String(state.totalPages);
    elements.pageInput.value = String(state.page);
    elements.pageRange.max = String(state.totalPages);
    elements.pageRange.value = String(state.page);
    elements.pageTotal.textContent = `of ${state.totalPages.toLocaleString()}`;
    elements.previous.disabled = state.page <= 1;
    elements.next.disabled = state.page >= state.totalPages;
  }

  function updateHistory(mode = "push") {
    if (!state.book) return;
    const url = new URL(window.location.href);
    url.searchParams.set("book", state.book.id);
    url.searchParams.set("page", String(state.page));
    const current = `${window.location.pathname}${window.location.search}`;
    const next = `${url.pathname}${url.search}`;
    if (mode === "push" && next !== current) window.history.pushState({ book: state.book.id, page: state.page }, "", url);
    else if (mode === "replace") window.history.replaceState({ book: state.book.id, page: state.page }, "", url);
  }

  function setBookMetadata() {
    const book = state.book;
    const manifest = state.manifest;
    const title = book.short_title || book.title || manifest.title || "Untitled herbal";
    elements.title.textContent = title;
    elements.meta.textContent = [book.creator, book.year, book.language].filter(Boolean).join(" · ") || "World Herb Library";
    document.title = `${title} — World Herb Library`;

    const accent = cssColor(book.accent, "#5e7359");
    document.documentElement.style.setProperty("--book-accent", accent);

    const styles = manifest.styles && typeof manifest.styles === "object" ? manifest.styles : {};
    document.documentElement.style.setProperty("--paper", cssColor(styles.paper, "#eee2c5"));
    document.documentElement.style.setProperty("--page-ink", cssColor(styles.ink, "#29261e"));
    const validFontStack = (value) => typeof value === "string" && /^[a-zA-Z0-9\s,'"-]+$/.test(value);
    const bodyFont = styles.body_family ?? styles.font_family ?? styles.fontFamily ?? styles.typeface;
    const headingFont = styles.heading_family ?? bodyFont;
    if (validFontStack(bodyFont)) document.documentElement.style.setProperty("--facsimile-body-font", bodyFont);
    else document.documentElement.style.removeProperty("--facsimile-body-font");
    if (validFontStack(headingFont)) document.documentElement.style.setProperty("--facsimile-heading-font", headingFont);
    else document.documentElement.style.removeProperty("--facsimile-heading-font");
    const bodyScale = clamp(Number(styles.body_scale) || 1, 0.75, 1.35);
    document.documentElement.style.setProperty("--facsimile-body-scale", String(bodyScale));
    elements.facsimilePage.dataset.theme = safeRole(styles.theme || "reading-edition");

    const source = sourceDetails(manifest.source);
    if (source.url) {
      elements.sourceLink.href = source.url;
      elements.sourceLink.firstChild.textContent = `${source.label} `;
      elements.sourceLink.hidden = false;
    } else {
      elements.sourceLink.hidden = true;
      elements.sourceLink.removeAttribute("href");
    }

    const originalLanguage = String(book.language || "").toLowerCase();
    elements.modernLabel.textContent = originalLanguage.includes("english") ? "Normalized modern English" : "English translation";
    renderQa(manifest.qa);
  }

  function renderQa(qa) {
    const object = qa && typeof qa === "object" ? qa : {};
    const sampleValue = object.sample_pages ?? object.pages_sampled ?? object.samples ?? object.sample_size ?? object.reviewed_pages;
    const sampleCount = Array.isArray(sampleValue) ? sampleValue.length : parsePage(sampleValue, 0);
    const confidence = normalizeConfidence(object.mean_confidence ?? object.average_confidence ?? object.confidence);
    const statusText = typeof qa === "string" ? qa : object.status;
    const hasWarnings = /warning/i.test(String(statusText || ""));
    const wasReviewed = sampleCount > 0 || /review|sample|complete/i.test(String(statusText || ""));
    const reportUrl = resolveLibraryAsset(object.report, state.manifestUrl);
    const reportLink = () => {
      if (!reportUrl) return null;
      const link = document.createElement("a");
      link.href = reportUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Open the QA report ↗";
      return link;
    };
    const methodLink = () => {
      const link = document.createElement("a");
      link.href = "method.html";
      link.textContent = "Read the method";
      return link;
    };
    const replaceQaHelp = (...nodes) => elements.qaHelp.replaceChildren(...nodes, methodLink(), ...[reportLink()].filter(Boolean));

    if (sampleCount > 0) {
      elements.qaBadge.textContent = `QA sample · ${sampleCount} ${sampleCount === 1 ? "page" : "pages"}${hasWarnings ? " · warnings" : ""}`;
      elements.qaBadge.dataset.status = hasWarnings ? "warnings" : "reviewed";
      const title = document.createElement("strong");
      title.textContent = "Sample-based quality review";
      const detail = document.createElement("span");
      const score = confidence === null ? "" : ` Mean automated confidence was ${Math.round(confidence * 100)}%.`;
      const statusNote = hasWarnings
        ? " The release gate passed with warnings; open the QA report for the recorded limitations."
        : "";
      detail.textContent = `${sampleCount} ${sampleCount === 1 ? "page was" : "pages were"} assessed as a reproducible sample.${score}${statusNote} This is not a guarantee that every character or translation is correct.`;
      replaceQaHelp(title, detail);
      return;
    }

    if (wasReviewed) {
      elements.qaBadge.textContent = "QA review reported";
      elements.qaBadge.dataset.status = "reviewed";
      const title = document.createElement("strong");
      title.textContent = "Quality review reported";
      const detail = document.createElement("span");
      detail.textContent = `${statusText || "The manifest reports a review"}. No sample size is included, so this badge does not imply complete verification.`;
      replaceQaHelp(title, detail);
      return;
    }

    if (confidence !== null) {
      elements.qaBadge.textContent = `Automated · ${Math.round(confidence * 100)}%`;
      elements.qaBadge.dataset.status = "automated";
      const title = document.createElement("strong");
      title.textContent = "Automated estimate only";
      const detail = document.createElement("span");
      detail.textContent = `The manifest reports ${Math.round(confidence * 100)}% automated confidence. No human sample review is recorded.`;
      replaceQaHelp(title, detail);
      return;
    }

    elements.qaBadge.textContent = "QA sample not reported";
    elements.qaBadge.dataset.status = "none";
    const title = document.createElement("strong");
    title.textContent = "No sample review reported";
    const detail = document.createElement("span");
    detail.textContent = "Use the source scan to verify uncertain readings, especially for scholarly citation.";
    replaceQaHelp(title, detail);
  }

  function populateBookSelect() {
    const options = state.catalog.books.map((book) => {
      const option = document.createElement("option");
      option.value = book.id;
      option.textContent = `${book.short_title || book.title || book.id}${book.year ? ` · ${book.year}` : ""}`;
      return option;
    });
    elements.bookSelect.replaceChildren(...options);
  }

  async function openBook(bookId, requestedPage, historyMode = "push") {
    const book = state.catalog?.books?.find((candidate) => candidate.id === bookId) ?? state.catalog?.books?.[0];
    if (!book) throw new Error("The catalogue contains no readable volumes.");

    state.pageController?.abort();
    state.manifestController?.abort();
    cancelPrefetch();
    state.prefetchController = new AbortController();
    state.pageSerial += 1;
    const controller = new AbortController();
    state.manifestController = controller;
    const serial = ++state.manifestSerial;
    state.currentPageData = null;
    state.currentPageDataUrl = null;
    state.manifest = null;
    state.manifestUrl = null;
    state.book = book;
    state.page = 1;
    elements.scanImage.onload = null;
    elements.scanImage.onerror = null;
    elements.scanImage.removeAttribute("src");
    elements.scanImage.alt = "";
    elements.scanLoading.hidden = false;
    elements.scanError.hidden = true;
    elements.facsimilePage.hidden = false;
    elements.facsimilePage.classList.add("is-loading");
    elements.facsimileText.replaceChildren();
    elements.facsimileError.hidden = true;
    elements.spread.setAttribute("aria-busy", "true");
    elements.bookSelect.value = book.id;
    setControlsEnabled(false);
    setMessage(`Opening ${book.short_title || book.title || "the volume"}…`);

    try {
      const manifestUrl = resolveLibraryAsset(book.manifest, catalogUrl);
      if (!manifestUrl) throw new Error(`No manifest URL is provided for ${book.id}.`);
      const manifest = await fetchJson(manifestUrl, controller.signal);
      if (serial !== state.manifestSerial) return;
      state.manifest = manifest;
      state.manifestUrl = manifestUrl;
      state.totalPages = Math.max(1, parsePage(manifest.pages ?? book.pages, 1));
      state.page = clamp(parsePage(requestedPage, preferredPage(book)), 1, state.totalPages);
      state.pageCache.clear();
      state.prefetching.clear();
      state.prefetchedImages.clear();
      setBookMetadata();
      updatePageControls();
      setControlsEnabled(true);
      updateHistory(historyMode);
      await loadPage(state.page);
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error("Unable to load book manifest", error);
      setMessage("This volume’s manifest could not be loaded. Try another volume or reload the page.", "error");
      elements.facsimilePage.classList.remove("is-loading");
      elements.facsimileError.hidden = false;
      elements.scanLoading.hidden = true;
      elements.scanError.hidden = false;
      elements.spread.setAttribute("aria-busy", "false");
      setControlsEnabled(false);
      elements.bookSelect.disabled = false;
    }
  }

  function preparePageLoading(scanUrl, serial) {
    elements.spread.setAttribute("aria-busy", "true");
    elements.scanError.hidden = true;
    elements.facsimileError.hidden = true;
    elements.scanLoading.hidden = false;
    elements.facsimilePage.hidden = false;
    elements.facsimilePage.classList.add("is-loading");
    elements.facsimileText.replaceChildren();
    elements.facsimilePage.querySelector(".facsimile-art")?.remove();
    elements.pageConfidence.textContent = "Confidence —";
    delete elements.pageConfidence.dataset.band;
    setMessage(`Loading page ${state.page.toLocaleString()}…`, "loading", true);

    elements.scanImage.onload = null;
    elements.scanImage.onerror = null;
    elements.scanImage.removeAttribute("src");
    elements.scanImage.alt = "";
    elements.scanImage.dataset.request = String(serial);

    if (!scanUrl) {
      elements.scanLoading.hidden = true;
      elements.scanError.hidden = false;
      announce(`Original scan unavailable for page ${state.page}`);
      return;
    }

    elements.scanImage.onload = () => {
      if (elements.scanImage.dataset.request !== String(serial)) return;
      elements.scanLoading.hidden = true;
      elements.scanError.hidden = true;
      elements.scanImage.alt = scanAltText(state.currentPageData?.regions);
    };
    elements.scanImage.onerror = () => {
      if (elements.scanImage.dataset.request !== String(serial)) return;
      elements.scanLoading.hidden = true;
      elements.scanError.hidden = false;
      elements.scanImage.removeAttribute("src");
      announce(`Original scan failed to load for page ${state.page}`);
    };
    elements.scanImage.src = scanUrl;
  }

  async function loadPage(page, shouldAnnounce = true) {
    if (!state.manifest) return;
    state.pageController?.abort();
    cancelPrefetch();
    state.prefetchController = new AbortController();
    const controller = new AbortController();
    state.pageController = controller;
    const serial = ++state.pageSerial;
    state.currentPageData = null;
    state.currentPageDataUrl = null;
    const dataUrl = resolvePattern(state.manifest.data_pattern, page, state.manifestUrl);
    const scanUrl = resolvePattern(state.manifest.page_pattern, page, state.manifestUrl);

    preparePageLoading(scanUrl, serial);
    renderFilmstrip();

    if (!dataUrl) {
      renderFacsimileError("No page-data pattern is present in this manifest.");
      clearMessage();
      return;
    }

    try {
      let pageData = state.pageCache.get(dataUrl);
      if (!pageData) {
        pageData = await fetchJson(dataUrl, controller.signal);
        cachePage(dataUrl, pageData);
      }
      if (serial !== state.pageSerial || controller.signal.aborted) return;
      state.currentPageData = pageData;
      state.currentPageDataUrl = dataUrl;
      renderFacsimile(pageData, dataUrl);
      clearMessage();
      if (shouldAnnounce) announce(`Page ${state.page} of ${state.totalPages} loaded`);
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error(`Unable to load facsimile page ${page}`, error);
      if (serial !== state.pageSerial) return;
      renderFacsimileError("The OCR layout data for this page could not be loaded.");
      setMessage(`Page ${page}: facsimile data unavailable. The source scan may still be viewed.`, "error");
    } finally {
      if (serial === state.pageSerial) {
        elements.spread.setAttribute("aria-busy", "false");
        prefetchAdjacent();
      }
    }
  }

  function renderFacsimileError(message) {
    elements.facsimilePage.classList.remove("is-loading");
    elements.facsimilePage.hidden = true;
    elements.facsimileError.hidden = false;
    const detail = elements.facsimileError.querySelector("span");
    if (detail) detail.textContent = message;
    elements.spread.setAttribute("aria-busy", "false");
  }

  function pageDimensions(data) {
    const width = Number(data?.width);
    const height = Number(data?.height);
    return {
      width: Number.isFinite(width) && width > 0 ? width : 1000,
      height: Number.isFinite(height) && height > 0 ? height : 1400
    };
  }

  function visualRegionCount(regions) {
    if (!Array.isArray(regions)) return 0;
    return regions.filter((region) => {
      const role = String(region?.role || "").toLowerCase();
      const sourceType = String(region?.source_type || "").toLowerCase();
      return ["figure", "illustration", "image", "ornament"].includes(role)
        || ["figure", "illustration", "image", "ornament"].includes(sourceType);
    }).length;
  }

  function visualRegionContext(regions) {
    if (!Array.isArray(regions)) return "";
    const labels = regions
      .filter((region) => ["title", "heading", "caption"].includes(String(region?.role || "").toLowerCase()))
      .map((region) => sanitizeDisplayText(selectedText(region).value).replace(/\s+/g, " ").trim())
      .filter((value, index, values) => value && value.length <= 120 && values.indexOf(value) === index)
      .slice(0, 3);
    return labels.length ? `; nearby text identifies ${labels.join("; ")}` : "";
  }

  function scanAltText(regions) {
    const title = state.book?.title || state.book?.short_title || "Historical herbal";
    const visualCount = visualRegionCount(regions);
    const visualDetail = visualCount
      ? `; ${visualCount} illustration or ornament ${visualCount === 1 ? "region is" : "regions are"} identified`
      : "";
    return `${title}, original scanned page ${state.page}${visualDetail}${visualCount ? visualRegionContext(regions) : ""}`;
  }

  function selectedText(region) {
    const texts = typeof region.text === "string" ? { diplomatic: region.text } : (region.text || {});
    const primary = texts[state.layer];
    const alternate = state.layer === "modern" ? texts.diplomatic : texts.modern;
    if (typeof primary === "string" && (primary.trim() || typeof alternate !== "string" || !alternate.trim())) {
      return { value: primary, fallback: false };
    }
    return { value: typeof alternate === "string" ? alternate : "", fallback: typeof alternate === "string" && Boolean(alternate.trim()) };
  }

  function sanitizeDisplayText(value) {
    const text = String(value || "").replace(/\r\n?/g, "\n");
    if (/^\s*!\[[^\]]*\]\([\s\S]*\)\s*$/.test(text)) return "";
    return text
      .replace(/!\[[^\]]*\]\([^\n)]*\)/g, "")
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .trim();
  }

  function makeTextRegion(region, dimensions, index) {
    const box = normalizedBox(region.box, dimensions.width, dimensions.height);
    if (!box) return null;
    const [x0, y0, x1, y1] = box;
    const role = safeRole(region.role);
    const chosen = selectedText(region);
    const confidence = normalizeConfidence(region.confidence);
    const node = document.createElement("div");
    node.className = `text-region${chosen.fallback ? " is-fallback" : ""}`;
    node.dataset.role = role;
    node.dataset.label = `${role.replaceAll("-", " ")}${confidence === null ? "" : ` · ${Math.round(confidence * 100)}%`}`;
    node.dataset.regionId = String(region.id ?? index + 1);
    node.style.left = `${x0 * 100}%`;
    node.style.top = `${y0 * 100}%`;
    node.style.width = `${(x1 - x0) * 100}%`;
    node.style.height = `${(y1 - y0) * 100}%`;
    node.textContent = sanitizeDisplayText(chosen.value);
    const language = textLanguage(state.book?.language, state.layer);
    if (language) node.lang = language;
    if (!node.textContent && !["illustration", "image"].includes(role)) node.setAttribute("aria-hidden", "true");
    return node;
  }

  function renderFacsimile(data, dataUrl) {
    const dimensions = pageDimensions(data);
    const ratio = dimensions.width / dimensions.height;
    updatePageSizing(ratio);
    elements.facsimilePage.style.setProperty("--page-ratio", String(ratio));
    const paper = cssColor(data.paper, getComputedStyle(document.documentElement).getPropertyValue("--paper") || "#eee2c5");
    const sampledInk = cssColor(data.ink, getComputedStyle(document.documentElement).getPropertyValue("--page-ink") || "#29261e");
    const readableInk = readableInkColor(paper, sampledInk);
    elements.facsimilePage.style.setProperty("--paper", paper);
    elements.facsimilePage.style.setProperty("--page-ink", readableInk);
    elements.facsimilePage.dataset.inkAdjusted = String(readableInk !== sampledInk);
    elements.facsimilePage.hidden = false;
    elements.facsimileError.hidden = true;
    elements.facsimilePage.classList.remove("is-loading");
    elements.facsimilePage.setAttribute("aria-label", `${state.layer === "modern" ? elements.modernLabel.textContent : "Diplomatic OCR"} facsimile of page ${state.page}`);

    const regions = Array.isArray(data.regions) ? data.regions : [];
    const visualCount = visualRegionCount(regions);
    if (elements.scanImage.complete && elements.scanImage.hasAttribute("src")) {
      elements.scanImage.alt = scanAltText(regions);
    }

    elements.facsimilePage.querySelector(".facsimile-art")?.remove();
    const artUrl = resolveLibraryAsset(data.art, dataUrl);
    if (artUrl) {
      const art = document.createElement("img");
      art.className = "facsimile-art";
      art.src = artUrl;
      art.decoding = "async";
      if (visualCount) {
        art.alt = `Scan-derived illustration and ornament layer from page ${state.page}${visualRegionContext(regions)}`;
      } else {
        art.alt = "";
        art.setAttribute("aria-hidden", "true");
      }
      art.addEventListener("error", () => {
        art.remove();
        if (visualCount) announce(`The illustration layer failed to load for page ${state.page}`);
      }, { once: true });
      elements.facsimilePage.insertBefore(art, elements.facsimileText);
    }

    const nodes = regions.map((region, index) => makeTextRegion(region || {}, dimensions, index)).filter(Boolean);
    elements.facsimileText.replaceChildren(...nodes);
    updatePageConfidence(data.confidence, regions);
    scheduleTextFit();
  }

  function updatePageConfidence(value, regions) {
    let confidence = normalizeConfidence(value);
    if (confidence === null) {
      const regionScores = regions.map((region) => normalizeConfidence(region?.confidence)).filter((score) => score !== null);
      if (regionScores.length) confidence = regionScores.reduce((sum, score) => sum + score, 0) / regionScores.length;
    }
    if (confidence === null) {
      elements.pageConfidence.textContent = "Confidence not reported";
      delete elements.pageConfidence.dataset.band;
      elements.pageConfidence.removeAttribute("title");
      return;
    }
    const percent = Math.round(confidence * 100);
    elements.pageConfidence.textContent = `OCR confidence ${percent}%`;
    elements.pageConfidence.dataset.band = confidence >= 0.9 ? "high" : confidence >= 0.72 ? "medium" : "low";
    elements.pageConfidence.title = "Automated OCR confidence; this is not a human accuracy rating.";
  }

  function scheduleTextFit(pageWidth = state.pageDisplayWidth) {
    const resolvedPageWidth = Number.isFinite(Number(pageWidth)) && Number(pageWidth) > 0 ? Number(pageWidth) : 700;
    const manifestScale = clamp(Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--facsimile-body-scale")) || 1, 0.75, 1.35);
    const regions = [...elements.facsimileText.querySelectorAll(".text-region")];
    regions.forEach((region) => applyTextRegionPreferences(region, resolvedPageWidth, manifestScale));
    window.cancelAnimationFrame(state.fitFrame);
    state.fitFrame = window.requestAnimationFrame(() => {
      regions.filter((region) => region.isConnected).forEach(updateTextRegionOverflow);
    });
  }

  function spreadPosition() {
    const scrollWidth = elements.spreadScroll.scrollWidth || 1;
    const scrollHeight = elements.spreadScroll.scrollHeight || 1;
    return {
      x: (elements.spreadScroll.scrollLeft + (elements.spreadScroll.clientWidth / 2)) / scrollWidth,
      y: (elements.spreadScroll.scrollTop + (elements.spreadScroll.clientHeight / 2)) / scrollHeight
    };
  }

  function restoreSpreadPosition(position) {
    if (!position) return;
    const left = (position.x * elements.spreadScroll.scrollWidth) - (elements.spreadScroll.clientWidth / 2);
    const top = (position.y * elements.spreadScroll.scrollHeight) - (elements.spreadScroll.clientHeight / 2);
    elements.spreadScroll.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: "auto" });
  }

  function usesTwoPageSpread() {
    const narrow = window.matchMedia?.("(max-width: 850px)")?.matches ?? window.innerWidth <= 850;
    const fullscreenLandscape = isReaderFullscreen()
      && state.view === "both"
      && window.innerWidth >= 700
      && window.innerWidth > window.innerHeight;
    return !narrow || fullscreenLandscape;
  }

  function updateSpreadAccessibility(twoUp = usesTwoPageSpread()) {
    const narrow = window.matchMedia?.("(max-width: 850px)")?.matches ?? window.innerWidth <= 850;
    const visibleView = narrow && !twoUp ? state.view : "both";
    if (visibleView === "scan") {
      elements.spreadScroll.setAttribute("aria-label", "Original scan page");
      elements.zoomHelp.textContent = "When zoomed, focus this region and use the arrow keys or pointer gestures to pan across the scan.";
    } else if (visibleView === "facsimile") {
      elements.spreadScroll.setAttribute("aria-label", "Facsimile page");
      elements.zoomHelp.textContent = "When zoomed, focus this region and use the arrow keys or pointer gestures to pan across the facsimile.";
    } else {
      elements.spreadScroll.setAttribute("aria-label", twoUp ? "Original and facsimile page spread" : "Original and facsimile pages");
      elements.zoomHelp.textContent = twoUp
        ? "When zoomed, focus this region and use the arrow keys or pointer gestures to pan across both pages."
        : "When zoomed, focus this region and use the arrow keys or pointer gestures to pan through both pages.";
    }
  }

  function updatePageSizing(ratio = state.pageRatio, preservePosition = true, positionOverride = null) {
    const position = positionOverride || (preservePosition ? spreadPosition() : null);
    state.pageRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 0.72;
    const mobile = window.matchMedia?.("(max-width: 850px)")?.matches ?? window.innerWidth <= 850;
    const fullscreen = isReaderFullscreen();
    const controlsHeight = elements.controls.offsetHeight || (mobile ? 150 : 62);
    const headerHeight = fullscreen ? 0 : (document.querySelector(".reader-header")?.offsetHeight || 72);
    const filmstripHeight = fullscreen ? 0 : (elements.filmstripShell?.offsetHeight || 82);
    const reservedHeight = controlsHeight + headerHeight + filmstripHeight + (fullscreen ? 18 : 42);
    const availableHeight = Math.max(mobile ? 280 : 320, window.innerHeight - reservedHeight);
    const scrollerWidth = elements.spreadScroll.clientWidth || window.innerWidth;
    const twoUp = usesTwoPageSpread();
    const pageColumns = twoUp ? 2 : 1;
    const widthBound = Math.max(180, (scrollerWidth - (twoUp ? 2 : 0)) / pageColumns);
    const baseWidth = clamp(Math.min(availableHeight * state.pageRatio, widthBound), 180, 830);
    const displayWidth = Math.round(baseWidth * state.zoom);
    state.pageDisplayWidth = displayWidth;
    document.documentElement.style.setProperty("--page-ratio", String(state.pageRatio));
    document.documentElement.style.setProperty("--page-base-width", `${Math.round(baseWidth)}px`);
    document.documentElement.style.setProperty("--page-display-width", `${displayWidth}px`);
    document.documentElement.style.setProperty("--spread-max-height", `${Math.round(availableHeight)}px`);
    updateSpreadAccessibility(twoUp);
    scheduleTextFit(displayWidth);
    window.cancelAnimationFrame(state.sizeFrame);
    state.sizeFrame = window.requestAnimationFrame(() => {
      restoreSpreadPosition(position);
    });
  }

  function roleLineHeight(role) {
    if (["title", "heading", "header"].includes(role)) return 1.04;
    if (role === "caption") return 1.12;
    if (["marginalia", "note", "footnote", "catch-word", "signature-mark"].includes(role)) return 1.08;
    return 1.17;
  }

  function roleTextBaseSize(role, logicalPageWidth, manifestScale = 1) {
    const scale = clamp(logicalPageWidth / 720, 0.45, 1.5);
    const roleMaximum = ROLE_TEXT_MAXIMUMS[role] ?? 20;
    return Math.max(12, roleMaximum * scale * clamp(manifestScale, 0.75, 1.35));
  }

  function displayTextSize(role, pageWidth, zoom, textScale, manifestScale = 1) {
    const safeZoom = clamp(Number(zoom) || 1, 0.5, 2.5);
    const numericWidth = Number(pageWidth);
    const safeWidth = Number.isFinite(numericWidth) && numericWidth > 0 ? numericWidth : 700 * safeZoom;
    const logicalPageWidth = safeWidth / safeZoom;
    return Math.max(4, roleTextBaseSize(role, logicalPageWidth, manifestScale) * safeZoom * clamp(Number(textScale) || 1, 0.75, 2));
  }

  function applyTextRegionPreferences(region, pageWidth, manifestScale = 1) {
    if (!region.textContent) return;
    const requestedSize = displayTextSize(region.dataset.role, pageWidth, state.zoom, state.textScale, manifestScale);
    region.style.fontSize = `${Math.floor(requestedSize * 10) / 10}px`;
    region.style.lineHeight = String(roleLineHeight(region.dataset.role) * state.lineHeightScale);
  }

  function updateTextRegionOverflow(region) {
    const measurable = Boolean(region.textContent) && region.clientWidth >= 1 && region.clientHeight >= 1;
    const overflows = measurable && (region.scrollHeight > region.clientHeight + 1 || region.scrollWidth > region.clientWidth + 1);
    region.classList.toggle("is-overflowing", overflows);
    if (!overflows) {
      region.removeAttribute("tabindex");
      region.removeAttribute("aria-describedby");
      region.removeAttribute("title");
    } else {
      region.tabIndex = 0;
      region.setAttribute("aria-describedby", "overflow-help");
      region.title = "Scroll within this region to read the complete text.";
    }
  }

  function cachePage(url, data) {
    state.pageCache.delete(url);
    state.pageCache.set(url, data);
    while (state.pageCache.size > 14) {
      state.pageCache.delete(state.pageCache.keys().next().value);
    }
  }

  function prefetchAdjacent() {
    const bookId = state.book?.id;
    const controller = state.prefetchController;
    const pages = [state.page - 1, state.page + 1].filter((page) => page >= 1 && page <= state.totalPages);
    const callback = () => {
      state.prefetchIdle = null;
      if (state.book?.id !== bookId || controller?.signal.aborted) return;
      pages.forEach((page) => {
        const dataUrl = resolvePattern(state.manifest.data_pattern, page, state.manifestUrl);
        if (dataUrl && !state.pageCache.has(dataUrl) && !state.prefetching.has(dataUrl)) {
          const request = fetchJson(dataUrl, controller?.signal)
            .then((data) => cachePage(dataUrl, data))
            .catch(() => {})
            .finally(() => state.prefetching.delete(dataUrl));
          state.prefetching.set(dataUrl, request);
        }

        const imageUrl = resolvePattern(state.manifest.page_pattern, page, state.manifestUrl);
        if (imageUrl && !state.prefetchedImages.has(imageUrl)) {
          const image = new Image();
          image.decoding = "async";
          image.src = imageUrl;
          state.prefetchedImages.set(imageUrl, image);
          while (state.prefetchedImages.size > 8) {
            state.prefetchedImages.delete(state.prefetchedImages.keys().next().value);
          }
        }
      });
    };
    if (typeof window.requestIdleCallback === "function") {
      state.prefetchIdle = {
        id: window.requestIdleCallback(callback, { timeout: 1000 }),
        type: "idle"
      };
    } else {
      state.prefetchIdle = { id: window.setTimeout(callback, 100), type: "timeout" };
    }
  }

  function filmstripPages(total, current) {
    if (total <= 23) return Array.from({ length: total }, (_, index) => index + 1);
    const pages = new Set([1, total]);
    for (let page = current - 7; page <= current + 7; page += 1) {
      if (page >= 1 && page <= total) pages.add(page);
    }
    const sorted = [...pages].sort((a, b) => a - b);
    const result = [];
    sorted.forEach((page, index) => {
      if (index > 0 && page - sorted[index - 1] > 1) result.push(null);
      result.push(page);
    });
    return result;
  }

  function renderFilmstrip() {
    if (!state.manifest) return;
    const focusedButton = document.activeElement?.closest?.(".filmstrip-button");
    const focusedPage = focusedButton && elements.filmstrip.contains(focusedButton)
      ? focusedButton.dataset.page
      : null;
    state.thumbObserver?.disconnect();
    state.thumbObserver = null;
    const nodes = filmstripPages(state.totalPages, state.page).map((page) => {
      const item = document.createElement("li");
      if (page === null) {
        item.className = "filmstrip-gap";
        item.textContent = "…";
        item.setAttribute("aria-hidden", "true");
        return item;
      }

      const button = document.createElement("button");
      button.className = "filmstrip-button";
      button.type = "button";
      button.dataset.page = String(page);
      button.setAttribute("aria-label", `Go to page ${page}`);
      if (page === state.page) button.setAttribute("aria-current", "page");

      const thumbUrl = resolvePattern(state.manifest.thumb_pattern, page, state.manifestUrl);
      if (thumbUrl) {
        const image = document.createElement("img");
        image.alt = "";
        image.loading = "lazy";
        image.decoding = "async";
        image.dataset.src = thumbUrl;
        image.addEventListener("error", () => image.remove(), { once: true });
        button.append(image);
      }

      const number = document.createElement("span");
      number.className = "thumb-number";
      number.textContent = String(page);
      button.append(number);
      button.addEventListener("click", () => setPage(page));
      item.append(button);
      return item;
    });
    elements.filmstrip.replaceChildren(...nodes);
    if (focusedPage) {
      elements.filmstrip.querySelector(`.filmstrip-button[data-page="${focusedPage}"]`)?.focus({ preventScroll: true });
    }

    const images = [...elements.filmstrip.querySelectorAll("img[data-src]")];
    if ("IntersectionObserver" in window) {
      state.thumbObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const image = entry.target;
          image.src = image.dataset.src;
          image.removeAttribute("data-src");
          observer.unobserve(image);
        });
      }, { root: elements.filmstrip, rootMargin: "0px 280px" });
      images.forEach((image) => state.thumbObserver.observe(image));
    } else {
      images.forEach((image) => {
        image.src = image.dataset.src;
        image.removeAttribute("data-src");
      });
    }

    window.requestAnimationFrame(() => {
      const current = elements.filmstrip.querySelector('[aria-current="page"]');
      if (!current) return;
      const left = current.offsetLeft - ((elements.filmstrip.clientWidth - current.offsetWidth) / 2);
      elements.filmstrip.scrollTo({
        left: Math.max(0, left),
        behavior: reducedMotion ? "auto" : "smooth"
      });
    });
  }

  function setPage(nextPage, options = {}) {
    if (!state.manifest) return;
    window.clearTimeout(state.rangeTimer);
    const page = clamp(parsePage(nextPage, state.page), 1, state.totalPages);
    const changed = page !== state.page;
    state.page = page;
    updatePageControls();
    if (options.history !== "none") updateHistory(options.history || "push");
    if (changed || options.force) loadPage(page, options.announce !== false);
  }

  function setLayer(layer) {
    if (!["modern", "diplomatic"].includes(layer)) return;
    state.layer = layer;
    savePreference("whl-text-layer", layer);
    elements.layerInputs.forEach((input) => { input.checked = input.value === layer; });
    if (state.currentPageData) renderFacsimile(state.currentPageData, state.currentPageDataUrl);
    announce(layer === "modern" ? `Showing ${elements.modernLabel.textContent}` : "Showing original OCR text");
  }

  function setView(view) {
    if (!["scan", "facsimile", "both"].includes(view)) return;
    state.view = view;
    document.body.dataset.view = view;
    savePreference("whl-page-view", view);
    elements.viewButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === view)));
    updatePageSizing();
  }

  function syncDisplayControls() {
    const textPercent = Math.round(state.textScale * 100);
    const lineHeightPercent = Math.round(state.lineHeightScale * 100);
    const zoomPercent = Math.round(state.zoom * 100);
    elements.fontSize.value = String(textPercent);
    elements.fontSizeValue.value = `${textPercent}%`;
    elements.fontSize.setAttribute("aria-valuetext", `${textPercent} percent`);
    elements.fontFamily.value = state.fontChoice;
    elements.lineHeight.value = String(lineHeightPercent);
    elements.lineHeightValue.value = `${state.lineHeightScale.toFixed(2)}×`;
    elements.lineHeight.setAttribute("aria-valuetext", `${state.lineHeightScale.toFixed(2)} times`);
    elements.zoom.value = String(zoomPercent);
    elements.zoomValue.value = `${zoomPercent}%`;
    elements.zoom.setAttribute("aria-valuetext", `${zoomPercent} percent`);
    document.body.dataset.readerFont = state.fontChoice;
  }

  function setTextScale(value, shouldAnnounce = false) {
    state.textScale = clamp(Number.parseFloat(value) / 100, 0.75, 2);
    savePreference("whl-text-scale", String(state.textScale));
    syncDisplayControls();
    scheduleTextFit();
    if (shouldAnnounce) announce(`Facsimile text size ${Math.round(state.textScale * 100)} percent`);
  }

  function setFontChoice(value, shouldAnnounce = false) {
    state.fontChoice = FONT_CHOICES.includes(value) ? value : "edition";
    savePreference("whl-font-choice", state.fontChoice);
    syncDisplayControls();
    scheduleTextFit();
    if (shouldAnnounce) announce(`Facsimile typeface ${elements.fontFamily.selectedOptions[0]?.textContent || "edition typography"}`);
  }

  function setLineHeight(value, shouldAnnounce = false) {
    state.lineHeightScale = clamp(Number.parseFloat(value) / 100, 0.85, 1.6);
    savePreference("whl-line-height-scale", String(state.lineHeightScale));
    syncDisplayControls();
    scheduleTextFit();
    if (shouldAnnounce) announce(`Facsimile line height ${state.lineHeightScale.toFixed(2)} times`);
  }

  function setZoom(value, shouldAnnounce = false) {
    if (!state.zoomAnchor) state.zoomAnchor = spreadPosition();
    state.zoom = clamp(Number.parseFloat(value) / 100, 0.5, 2.5);
    savePreference("whl-page-zoom", String(state.zoom));
    syncDisplayControls();
    updatePageSizing(state.pageRatio, true, state.zoomAnchor);
    if (shouldAnnounce) {
      state.zoomAnchor = null;
      announce(`Page zoom ${Math.round(state.zoom * 100)} percent`);
    }
  }

  function resetDisplayPreferences() {
    state.textScale = 1;
    state.fontChoice = "edition";
    state.lineHeightScale = 1;
    state.zoom = 1;
    state.zoomAnchor = null;
    savePreference("whl-text-scale", "1");
    savePreference("whl-font-choice", "edition");
    savePreference("whl-line-height-scale", "1");
    savePreference("whl-page-zoom", "1");
    syncDisplayControls();
    updatePageSizing();
    announce("Display settings reset");
  }

  function nativeFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function isReaderFullscreen() {
    return state.fauxFullscreen || nativeFullscreenElement() === elements.shell;
  }

  function syncFullscreenState(shouldAnnounce = true) {
    const active = isReaderFullscreen();
    const changed = active !== state.fullscreenActive;
    state.fullscreenActive = active;
    elements.shell.classList.toggle("is-faux-fullscreen", state.fauxFullscreen);
    document.body.classList.toggle("has-reader-fullscreen", active);
    elements.fullscreenToggle.setAttribute("aria-pressed", String(active));
    elements.fullscreenToggle.setAttribute("aria-label", "Full screen");
    elements.fullscreenToggle.title = active ? "Exit full screen" : "Enter full screen";
    elements.fullscreenLabel.textContent = active ? "Exit full screen" : "Full screen";
    if (active) elements.readingSettings.open = false;
    updatePageSizing();
    if (changed && shouldAnnounce) announce(active ? "Full screen reader opened" : "Full screen reader closed");
    if (changed && !active) {
      window.requestAnimationFrame(() => elements.fullscreenToggle.focus({ preventScroll: true }));
    }
  }

  function enterFauxFullscreen() {
    if (nativeFullscreenElement() === elements.shell) return;
    state.fauxFullscreen = true;
    syncFullscreenState();
  }

  function exitFauxFullscreen() {
    if (!state.fauxFullscreen) return;
    state.fauxFullscreen = false;
    syncFullscreenState();
  }

  function toggleFullscreen() {
    const nativeElement = nativeFullscreenElement();
    if (state.fauxFullscreen) {
      exitFauxFullscreen();
      return;
    }
    if (nativeElement === elements.shell) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) {
        try {
          const result = exit.call(document);
          result?.catch?.(() => syncFullscreenState());
        } catch {
          syncFullscreenState();
        }
      }
      return;
    }

    const request = elements.shell.requestFullscreen || elements.shell.webkitRequestFullscreen;
    if (!request) {
      enterFauxFullscreen();
      return;
    }
    try {
      const result = request.call(elements.shell);
      result?.catch?.(() => enterFauxFullscreen());
    } catch {
      enterFauxFullscreen();
    }
  }

  function bindControls() {
    elements.previous.addEventListener("click", () => setPage(state.page - 1));
    elements.next.addEventListener("click", () => setPage(state.page + 1));
    elements.pageForm.addEventListener("submit", (event) => {
      event.preventDefault();
      setPage(elements.pageInput.value);
      elements.pageInput.select();
    });
    elements.pageInput.addEventListener("change", () => setPage(elements.pageInput.value));
    elements.pageRange.addEventListener("input", () => {
      const pendingPage = parsePage(elements.pageRange.value, state.page);
      elements.pageInput.value = String(pendingPage);
      window.clearTimeout(state.rangeTimer);
      state.rangeTimer = window.setTimeout(() => setPage(pendingPage, { history: "replace" }), 120);
    });
    elements.pageRange.addEventListener("change", () => {
      window.clearTimeout(state.rangeTimer);
      setPage(elements.pageRange.value);
    });
    elements.bookSelect.addEventListener("change", async () => {
      await openBook(elements.bookSelect.value);
      if (!elements.bookSelect.disabled) elements.bookSelect.focus({ preventScroll: true });
    });
    elements.layerInputs.forEach((input) => input.addEventListener("change", () => {
      if (input.checked) setLayer(input.value);
    }));
    elements.layoutToggle.addEventListener("change", () => {
      state.showLayout = elements.layoutToggle.checked;
      document.body.classList.toggle("show-layout", state.showLayout);
      savePreference("whl-show-layout", String(state.showLayout));
      announce(state.showLayout ? "Layout regions shown" : "Layout regions hidden");
    });
    elements.viewButtons.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
    elements.fontSize.addEventListener("input", () => setTextScale(elements.fontSize.value));
    elements.fontSize.addEventListener("change", () => setTextScale(elements.fontSize.value, true));
    elements.fontFamily.addEventListener("change", () => setFontChoice(elements.fontFamily.value, true));
    elements.lineHeight.addEventListener("input", () => setLineHeight(elements.lineHeight.value));
    elements.lineHeight.addEventListener("change", () => setLineHeight(elements.lineHeight.value, true));
    elements.zoom.addEventListener("input", () => setZoom(elements.zoom.value));
    elements.zoom.addEventListener("change", () => setZoom(elements.zoom.value, true));
    elements.displayReset.addEventListener("click", resetDisplayPreferences);
    elements.fullscreenToggle.addEventListener("click", toggleFullscreen);

    ["fullscreenchange", "webkitfullscreenchange"].forEach((eventName) => {
      document.addEventListener(eventName, () => {
        if (nativeFullscreenElement() === elements.shell) state.fauxFullscreen = false;
        syncFullscreenState();
      });
    });
    ["fullscreenerror", "webkitfullscreenerror"].forEach((eventName) => {
      document.addEventListener(eventName, () => {
        if (!isReaderFullscreen()) enterFauxFullscreen();
      });
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.fauxFullscreen) {
        event.preventDefault();
        if (elements.readingSettings.open) {
          elements.readingSettings.open = false;
          announce("Display settings closed");
          return;
        }
        exitFauxFullscreen();
        return;
      }
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement || target?.isContentEditable) return;
      if (target === elements.spreadScroll || target?.closest?.("a, summary, [role='button'], .text-region.is-overflowing, #spread-scroll")) return;
      const actions = {
        ArrowLeft: () => setPage(state.page - 1),
        ArrowRight: () => setPage(state.page + 1)
      };
      if (actions[event.key]) {
        event.preventDefault();
        actions[event.key]();
      }
    });

    window.addEventListener("popstate", () => {
      const params = new URLSearchParams(window.location.search);
      const bookId = params.get("book");
      const targetBook = state.catalog?.books?.find((book) => book.id === bookId) ?? state.catalog?.books?.[0];
      const page = params.has("page")
        ? parsePage(params.get("page"), preferredPage(targetBook))
        : preferredPage(targetBook);
      if (targetBook && targetBook.id !== state.book?.id) openBook(targetBook.id, page, "none");
      else setPage(page, { history: "none", force: page !== state.page, announce: false });
    });

    if ("ResizeObserver" in window) {
      const resizeObserver = new ResizeObserver(() => scheduleTextFit());
      resizeObserver.observe(elements.facsimilePage);
    }
    window.addEventListener("resize", () => {
      updatePageSizing();
      scheduleTextFit();
    }, { passive: true });
    window.addEventListener("orientationchange", () => updatePageSizing(), { passive: true });
    window.visualViewport?.addEventListener("resize", () => updatePageSizing(), { passive: true });
  }

  async function initialize() {
    bindControls();
    syncDisplayControls();
    syncFullscreenState(false);
    setLayer(state.layer);
    setView(state.view);
    elements.layoutToggle.checked = state.showLayout;
    document.body.classList.toggle("show-layout", state.showLayout);
    if (window.matchMedia?.("(pointer: coarse)")?.matches) elements.keyboardHint.hidden = true;
    setMessage("Opening the catalogue…");

    try {
      const catalog = await fetchJson(catalogUrl, undefined, "no-cache");
      const books = Array.isArray(catalog.books) ? catalog.books.filter((book) => book?.id && book?.manifest) : [];
      if (!books.length) throw new Error("The catalogue contains no book manifests.");
      state.catalog = { ...catalog, books };
      populateBookSelect();
      const params = new URLSearchParams(window.location.search);
      const targetBook = books.find((book) => book.id === params.get("book")) ?? books[0];
      const requestedPage = params.has("page")
        ? parsePage(params.get("page"), preferredPage(targetBook))
        : preferredPage(targetBook);
      await openBook(targetBook.id, requestedPage, "replace");
    } catch (error) {
      console.error("Unable to initialize facsimile reader", error);
      setMessage("The library catalogue could not be loaded. Check your connection and reload the page.", "error");
      elements.scanLoading.hidden = true;
      elements.scanError.hidden = false;
      elements.facsimilePage.classList.remove("is-loading");
      elements.facsimilePage.hidden = true;
      elements.facsimileError.hidden = false;
      elements.spread.setAttribute("aria-busy", "false");
    }
  }

  window.WHLReaderUtils = Object.freeze({
    resolvePattern,
    normalizedBox,
    normalizeConfidence,
    preferredPage,
    filmstripPages,
    sanitizeDisplayText
  });

  initialize();
})();
