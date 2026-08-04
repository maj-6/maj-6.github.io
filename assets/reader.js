(() => {
  "use strict";

  const CATALOG_PATH = "data/catalog.json";
  const PROJECT_CONFIG_PATH = "data/reader-config.json";
  const REGION_SETTINGS_SCHEMA = "whl-region-settings/1";
  const FONT_CHOICES = ["edition", "georgia", "palatino", "sans"];
  const FONT_STACKS = Object.freeze({
    edition: "var(--facsimile-body-font, var(--serif))",
    georgia: "Georgia, 'Times New Roman', serif",
    palatino: "Palatino, 'Palatino Linotype', 'Book Antiqua', serif",
    sans: "Arial, Helvetica, system-ui, sans-serif"
  });
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
  const projectConfigUrl = new URL(PROJECT_CONFIG_PATH, window.location.href);
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
    editorToggle: document.querySelector("#editor-toggle"),
    editorPanel: document.querySelector("#region-editor-panel"),
    editorClose: document.querySelector("#editor-close"),
    editorSelection: document.querySelector("#editor-selection"),
    editorScope: document.querySelector("#editor-scope"),
    editorFontFamily: document.querySelector("#editor-font-family"),
    editorFontSize: document.querySelector("#editor-font-size"),
    editorFontWeight: document.querySelector("#editor-font-weight"),
    editorFontColor: document.querySelector("#editor-font-color"),
    editorLineHeight: document.querySelector("#editor-line-height"),
    editorLetterSpacing: document.querySelector("#editor-letter-spacing"),
    editorFitMode: document.querySelector("#editor-fit-mode"),
    editorWrap: document.querySelector("#editor-wrap"),
    editorOverflow: document.querySelector("#editor-overflow"),
    editorMaxWidth: document.querySelector("#editor-max-width"),
    editorMinFont: document.querySelector("#editor-min-font"),
    editorGeometry: document.querySelector("#editor-geometry"),
    editorGeometryHelp: document.querySelector("#editor-geometry-help"),
    editorGeometryX: document.querySelector("#editor-geometry-x"),
    editorGeometryY: document.querySelector("#editor-geometry-y"),
    editorGeometryWidth: document.querySelector("#editor-geometry-width"),
    editorGeometryHeight: document.querySelector("#editor-geometry-height"),
    editorGeometryXLabel: document.querySelector("#editor-geometry-x-label"),
    editorGeometryYLabel: document.querySelector("#editor-geometry-y-label"),
    editorGeometryWidthLabel: document.querySelector("#editor-geometry-width-label"),
    editorGeometryHeightLabel: document.querySelector("#editor-geometry-height-label"),
    editorResetGeometry: document.querySelector("#editor-reset-geometry"),
    editorTextToggle: document.querySelector("#editor-text-toggle"),
    editorRestoreText: document.querySelector("#editor-restore-text"),
    editorUndo: document.querySelector("#editor-undo"),
    editorRedo: document.querySelector("#editor-redo"),
    editorResetScope: document.querySelector("#editor-reset-scope"),
    editorExport: document.querySelector("#editor-export"),
    editorImport: document.querySelector("#editor-import"),
    editorStatus: document.querySelector("#editor-status"),
    editorOverlay: document.querySelector("#editor-region-overlay"),
    editorMoveHandle: document.querySelector("#editor-move-handle"),
    editorResizeHandle: document.querySelector("#editor-resize-handle"),
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
    pageDisplayWidth: 520,
    projectConfig: null,
    editorEnabled: false,
    editorActive: false,
    regionSettings: null,
    regionPersistence: null,
    editorUnsubscribe: null,
    selectedRegionId: null,
    textEditing: false,
    editorDrag: null,
    editorSaveTimer: 0,
    editorControlTimers: new WeakMap(),
    editorComposing: false,
    editorTextDirty: false,
    editorTextStart: "",
    editorTextHadOverride: false,
    editorTextOriginalOverride: "",
    editorTextAutosaved: false,
    editorStatusRevision: 0
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

  function isRegionEditorEnabled(config) {
    return config?.schema === "whl-reader-config/1"
      && config?.projectId === "living-herbal"
      && config?.features?.regionEditor === true;
  }

  function reservesArrowKeys(target) {
    if (!target) return false;
    const tagName = String(target.tagName || target.nodeName || "").toLowerCase();
    if (["input", "select", "textarea"].includes(tagName) || target.isContentEditable) return true;
    if (target === elements.spreadScroll) return true;
    return Boolean(target.closest?.(
      "#spread-scroll, .text-region.is-overflowing, .text-region.is-editor-selected, #region-editor-panel, .editor-region-handle"
    ));
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

  function emptyRegionSettings(projectId = "living-herbal") {
    return {
      schema: REGION_SETTINGS_SCHEMA,
      schemaVersion: 1,
      projectId,
      overrides: {}
    };
  }

  function safeProjectAssetUrl(value, fallback) {
    const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
    try {
      const url = new URL(candidate, window.location.href);
      return url.origin === window.location.origin ? url : new URL(fallback, window.location.href);
    } catch {
      return new URL(fallback, window.location.href);
    }
  }

  function regionSettingsContext(regionId, role, layer = state.layer) {
    return {
      bookId: state.book?.id || "",
      page: state.page,
      role: safeRole(role),
      regionId: String(regionId || ""),
      layer
    };
  }

  function resolveRegionSettings(context) {
    if (!state.regionSettings || !context.bookId) return { style: {}, geometry: {}, fit: {}, text: {} };
    try {
      return state.regionSettings.resolve(context) || { style: {}, geometry: {}, fit: {}, text: {} };
    } catch (error) {
      console.warn("A region settings override could not be resolved", error);
      return { style: {}, geometry: {}, fit: {}, text: {} };
    }
  }

  function exposeRegionSettingsApi() {
    if (!state.regionSettings) return;
    const engine = state.regionSettings;
    window.WHLReaderRegions = Object.freeze({
      schema: REGION_SETTINGS_SCHEMA,
      ready: engine.ready,
      resolve: (context) => engine.resolve(context),
      getScope: (target, options) => engine.getScope(target, options),
      snapshot: () => engine.snapshot(),
      export: (options) => engine.export(options),
      subscribe: (listener) => engine.subscribe(listener)
    });
    if (!state.editorEnabled) {
      try { delete window.WHLReaderEditor; } catch { /* A stale non-configurable host value is harmless. */ }
      return;
    }
    window.WHLReaderEditor = Object.freeze({
      schema: REGION_SETTINGS_SCHEMA,
      enabled: true,
      ready: engine.ready,
      set: (target, patch) => engine.set(target, patch),
      remove: (target, path) => engine.remove(target, path),
      setText: (target, layer, value) => engine.setText(target, layer, value),
      clearText: (target, layer) => engine.clearText(target, layer),
      setBox: (target, box) => engine.set({
        scope: "region",
        bookId: target?.bookId,
        page: target?.page,
        regionId: target?.regionId
      }, { geometry: { box } }),
      import: (documentValue, options) => engine.import(documentValue, options),
      export: (options) => engine.export(options),
      snapshot: () => engine.snapshot(),
      resolve: (context) => engine.resolve(context),
      getScope: (target, options) => engine.getScope(target, options),
      undo: () => engine.undo(),
      redo: () => engine.redo(),
      batch: (callbackOrCommands, label) => engine.batch(callbackOrCommands, label),
      flush: () => engine.flush(),
      subscribe: (listener) => engine.subscribe(listener),
      selectRegion: (regionId) => selectEditorRegion(regionId)
    });
  }

  async function initializeRegionSettings() {
    let config = null;
    try {
      config = await fetchJson(projectConfigUrl, undefined, "no-cache");
    } catch (error) {
      console.warn("Reader project configuration is unavailable; editor mode remains disabled", error);
    }
    state.projectConfig = config;
    state.editorEnabled = isRegionEditorEnabled(config);

    const identityValid = config?.schema === "whl-reader-config/1"
      && config?.projectId === "living-herbal";
    const projectId = "living-herbal";
    const publishedUrl = safeProjectAssetUrl(identityValid ? config?.publishedSettings : null, "data/region-settings.json");
    let published = emptyRegionSettings(projectId);
    try {
      published = await fetchJson(publishedUrl, undefined, "no-cache");
    } catch (error) {
      console.warn("Published region settings are unavailable; source layout will be used", error);
    }

    const library = window.WHLRegionSettings;
    if (!library?.createEngine) {
      console.warn("The region settings engine did not load; source layout will be used");
      state.editorEnabled = false;
      return;
    }

    let persistence = null;
    if (state.editorEnabled) {
      const configuredKey = typeof config?.draftStorageKey === "string" ? config.draftStorageKey : "";
      const storageName = /^[a-zA-Z0-9:_-]{1,80}$/.test(configuredKey)
        ? configuredKey
        : "whl-region-settings-v1";
      const keyPrefix = `${storageName}:`;
      try {
        persistence = library.createBrowserPersistence?.({ keyPrefix, dbName: storageName }) || null;
      } catch (error) {
        console.warn("Persistent editor storage is unavailable; this editing session is memory-only", error);
      }
    }

    try {
      state.regionPersistence = persistence;
      state.regionSettings = library.createEngine({
        base: published,
        projectId,
        editorEnabled: state.editorEnabled,
        persistence
      });
      await state.regionSettings.ready;
      state.editorUnsubscribe = state.regionSettings.subscribe(() => {
        if (state.currentPageData) applyAllRegionSettings();
        if (state.editorActive) syncEditorPanel();
      });
      exposeRegionSettingsApi();
      if (state.editorEnabled) mountRegionEditor();
    } catch (error) {
      console.warn("Region settings could not be initialized; the reader remains available", error);
      state.regionSettings = null;
      state.regionPersistence = null;
      state.editorEnabled = false;
    }
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

    if (state.editorActive) clearEditorSelection();

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
    elements.editorOverlay.hidden = true;
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

  function normalizePlainText(value) {
    return String(value ?? "").replace(/\r\n?/g, "\n");
  }

  function editablePlainText(node) {
    return normalizePlainText(typeof node?.innerText === "string" ? node.innerText : node?.textContent);
  }

  function hasOwn(object, key) {
    return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
  }

  function textOverrideForLayer(settings, layer) {
    if (settings?.hasTextOverride === true) return { present: true, value: settings.text };
    if (hasOwn(settings?.text, layer)) return { present: true, value: settings.text[layer] };
    if (hasOwn(settings, "textValue")) return { present: true, value: settings.textValue };
    return { present: false, value: "" };
  }

  function transformedRegionBox(baseBox, geometry = {}) {
    const explicitBox = Array.isArray(geometry.box) && geometry.box.length === 4
      ? normalizedBox(geometry.box, 1, 1)
      : null;
    if (explicitBox) return explicitBox;
    const source = explicitBox || baseBox;
    let width = source[2] - source[0];
    let height = source[3] - source[1];
    const centerX = ((source[0] + source[2]) / 2) + clamp(Number(geometry.translateX) || 0, -1, 1);
    const centerY = ((source[1] + source[3]) / 2) + clamp(Number(geometry.translateY) || 0, -1, 1);
    width *= clamp(Number(geometry.scaleX) || 1, 0.25, 4);
    height *= clamp(Number(geometry.scaleY) || 1, 0.25, 4);
    width = clamp(width, 0.005, 1);
    height = clamp(height, 0.005, 1);
    const x0 = clamp(centerX - (width / 2), 0, 1 - width);
    const y0 = clamp(centerY - (height / 2), 0, 1 - height);
    return [x0, y0, x0 + width, y0 + height];
  }

  function setRegionBox(node, box) {
    const [x0, y0, x1, y1] = box;
    node.style.left = `${x0 * 100}%`;
    node.style.top = `${y0 * 100}%`;
    node.style.width = `${(x1 - x0) * 100}%`;
    node.style.height = `${(y1 - y0) * 100}%`;
    node.__whlDisplayBox = [...box];
  }

  function makeTextRegion(region, dimensions, index) {
    const box = normalizedBox(region.box, dimensions.width, dimensions.height);
    if (!box) return null;
    const role = safeRole(region.role);
    const regionId = String(region.id ?? index + 1);
    const context = regionSettingsContext(regionId, role);
    const settings = resolveRegionSettings(context);
    const sourceText = selectedText(region);
    const override = textOverrideForLayer(settings, state.layer);
    const chosen = override.present ? { value: override.value, fallback: false } : sourceText;
    const confidence = normalizeConfidence(region.confidence);
    const node = document.createElement("div");
    node.className = `text-region${chosen.fallback ? " is-fallback" : ""}`;
    node.dataset.role = role;
    node.dataset.label = `${role.replaceAll("-", " ")}${confidence === null ? "" : ` · ${Math.round(confidence * 100)}%`}`;
    node.dataset.regionId = regionId;
    node.__whlBaseBox = [...box];
    node.__whlSourceRegion = region;
    node.__whlSettings = settings;
    node.__whlGeometryBox = transformedRegionBox(box, settings.geometry);
    setRegionBox(node, node.__whlGeometryBox);
    node.textContent = override.present ? normalizePlainText(chosen.value) : sanitizeDisplayText(chosen.value);
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
    if (state.editorActive) {
      const selected = nodes.find((node) => node.dataset.regionId === state.selectedRegionId);
      const firstReadable = preferredEditorRegion(nodes);
      if (selected || firstReadable) selectEditorRegion((selected || firstReadable).dataset.regionId, { focus: false });
    }
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

  function effectiveRegionFont(style, role) {
    const token = state.fontChoice !== "edition" ? state.fontChoice : style?.fontFamily;
    if (token && token !== "edition" && FONT_STACKS[token]) return FONT_STACKS[token];
    if (token === "edition") {
      return ["title", "heading", "header"].includes(role)
        ? "var(--facsimile-heading-font, var(--facsimile-body-font, var(--serif)))"
        : FONT_STACKS.edition;
    }
    return "";
  }

  function applyTextRegionPreferences(region, pageWidth, manifestScale = 1) {
    if (!region.textContent) return;
    const settings = region.__whlSettings || {};
    const style = settings.style || {};
    const authoredScale = clamp(Number(style.fontSize) || 1, 0.5, 4);
    const requestedSize = displayTextSize(region.dataset.role, pageWidth, state.zoom, state.textScale, manifestScale) * authoredScale;
    region.style.fontSize = `${Math.floor(requestedSize * 10) / 10}px`;
    const lineHeight = Number.isFinite(Number(style.lineHeight)) ? Number(style.lineHeight) : roleLineHeight(region.dataset.role);
    region.style.lineHeight = String(lineHeight * state.lineHeightScale);
    const fontFamily = effectiveRegionFont(style, region.dataset.role);
    if (fontFamily) region.style.fontFamily = fontFamily;
    else region.style.removeProperty("font-family");
    if (Number.isFinite(Number(style.fontWeight))) region.style.fontWeight = String(style.fontWeight);
    else region.style.removeProperty("font-weight");
    if (typeof style.color === "string") region.style.color = style.color;
    else region.style.removeProperty("color");
    if (Number.isFinite(Number(style.letterSpacing))) region.style.letterSpacing = `${style.letterSpacing}em`;
    else region.style.removeProperty("letter-spacing");
    const nowrap = settings.fit?.wrap === "nowrap";
    region.style.whiteSpace = nowrap ? "pre" : "pre-wrap";
    region.style.overflowWrap = nowrap ? "normal" : "break-word";
    region.style.hyphens = nowrap ? "none" : "auto";
    if (settings.fit?.wrap === "balance") region.style.textWrap = "balance";
    else if (nowrap) region.style.textWrap = "nowrap";
    else if (settings.fit?.wrap === "normal") region.style.textWrap = "wrap";
    else region.style.removeProperty("text-wrap");
  }

  function updateTextRegionOverflow(region) {
    const fit = region.__whlSettings?.fit || {};
    if (region.__whlGeometryBox) setRegionBox(region, region.__whlGeometryBox);
    const measurable = Boolean(region.textContent) && region.clientWidth >= 1 && region.clientHeight >= 1;
    const isOverflowing = () => measurable
      && (region.scrollHeight > region.clientHeight + 1 || region.scrollWidth > region.clientWidth + 1);
    if (["grow-width", "grow-then-shrink"].includes(fit.mode) && isOverflowing() && region.__whlGeometryBox) {
      const [sourceX0, sourceY0, sourceX1, sourceY1] = region.__whlGeometryBox;
      const sourceWidth = sourceX1 - sourceX0;
      const centerX = (sourceX0 + sourceX1) / 2;
      const widen = (scale) => {
        const width = clamp(sourceWidth * scale, sourceWidth, 1);
        const x0 = clamp(centerX - (width / 2), 0, 1 - width);
        setRegionBox(region, [x0, sourceY0, x0 + width, sourceY1]);
      };
      const maximum = clamp(Number(fit.maxWidthScale) || 1.5, 1, 4);
      widen(maximum);
      if (!isOverflowing() && maximum > 1) {
        let low = 1;
        let high = maximum;
        let best = maximum;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const candidate = (low + high) / 2;
          widen(candidate);
          if (isOverflowing()) low = candidate;
          else {
            best = candidate;
            high = candidate;
          }
        }
        widen(best);
      }
    }
    if (["shrink-text", "grow-then-shrink"].includes(fit.mode) && isOverflowing()) {
      const baseSize = Number.parseFloat(region.style.fontSize);
      const minimumScale = clamp(Number(fit.minFontScale) || 0.7, 0.5, 1);
      let low = minimumScale;
      let high = 1;
      let best = minimumScale;
      region.style.fontSize = `${Math.max(4, baseSize * minimumScale)}px`;
      if (!isOverflowing()) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const candidate = (low + high) / 2;
          region.style.fontSize = `${Math.max(4, baseSize * candidate)}px`;
          if (isOverflowing()) high = candidate;
          else {
            best = candidate;
            low = candidate;
          }
        }
        region.style.fontSize = `${Math.floor(Math.max(4, baseSize * best) * 10) / 10}px`;
      }
    }
    const overflows = isOverflowing();
    region.classList.toggle("is-overflowing", overflows);
    const overflowPolicy = fit.overflow || "auto";
    if (overflowPolicy === "visible") {
      region.style.overflow = "visible";
      region.classList.remove("is-overflowing");
    } else if (overflowPolicy === "hidden") {
      region.style.overflow = "hidden";
      region.classList.remove("is-overflowing");
    } else if (overflowPolicy === "scroll") {
      region.style.overflow = "scroll";
    } else {
      region.style.removeProperty("overflow");
    }
    const scrollable = overflows && ["auto", "scroll"].includes(overflowPolicy);
    if (!scrollable) {
      region.removeAttribute("tabindex");
      region.removeAttribute("aria-describedby");
      region.removeAttribute("title");
      if (state.editorActive) region.tabIndex = region.dataset.regionId === state.selectedRegionId ? 0 : -1;
    } else {
      region.tabIndex = state.editorActive && region.dataset.regionId !== state.selectedRegionId ? -1 : 0;
      region.setAttribute("aria-describedby", "overflow-help");
      region.title = "Scroll within this region to read the complete text.";
    }
    if (state.editorActive && region.dataset.regionId === state.selectedRegionId) syncEditorOverlay();
  }

  function applyResolvedRegionSettings(region) {
    if (!region?.__whlBaseBox) return;
    const context = regionSettingsContext(region.dataset.regionId, region.dataset.role);
    const settings = resolveRegionSettings(context);
    region.__whlSettings = settings;
    region.__whlGeometryBox = transformedRegionBox(region.__whlBaseBox, settings.geometry);
    setRegionBox(region, region.__whlGeometryBox);
    if (!(state.textEditing && region.dataset.regionId === state.selectedRegionId)) {
      const source = selectedText(region.__whlSourceRegion || {});
      const override = textOverrideForLayer(settings, state.layer);
      const chosen = override.present ? { value: override.value, fallback: false } : source;
      region.textContent = override.present ? normalizePlainText(chosen.value) : sanitizeDisplayText(chosen.value);
      region.classList.toggle("is-fallback", chosen.fallback);
      if (region.textContent || ["illustration", "image"].includes(region.dataset.role)) region.removeAttribute("aria-hidden");
      else region.setAttribute("aria-hidden", "true");
    }
    applyTextRegionPreferences(region, state.pageDisplayWidth, clamp(Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--facsimile-body-scale")) || 1, 0.75, 1.35));
  }

  function applyAllRegionSettings() {
    const regions = [...elements.facsimileText.querySelectorAll(".text-region")];
    regions.forEach(applyResolvedRegionSettings);
    scheduleTextFit();
    syncEditorOverlay();
  }

  function selectedRegionNode() {
    if (!state.selectedRegionId) return null;
    return [...elements.facsimileText.querySelectorAll(".text-region")]
      .find((region) => region.dataset.regionId === state.selectedRegionId) || null;
  }

  function preferredEditorRegion(regions) {
    const peripheralRoles = new Set(["page-number", "footer", "catch-word", "signature-mark"]);
    return regions.find((region) => region.textContent.trim() && !region.classList.contains("is-overflowing") && !peripheralRoles.has(region.dataset.role))
      || regions.find((region) => region.textContent.trim() && !peripheralRoles.has(region.dataset.role))
      || regions.find((region) => region.textContent.trim() && !region.classList.contains("is-overflowing"))
      || regions.find((region) => region.textContent.trim())
      || regions[0];
  }

  function editorTarget(scope = elements.editorScope?.value || "region") {
    const node = selectedRegionNode();
    if (!state.book?.id || !node) return null;
    const target = { scope, bookId: state.book.id };
    if (["page", "pageRegionType", "region"].includes(scope)) target.page = state.page;
    if (["regionType", "pageRegionType"].includes(scope)) target.role = node.dataset.role;
    if (scope === "region") target.regionId = node.dataset.regionId;
    return target;
  }

  function exactRegionTarget() {
    return editorTarget("region");
  }

  function valueAtPath(object, path) {
    return String(path).split(".").reduce((value, key) => value?.[key], object);
  }

  function setEditorStatus(message, error = false) {
    if (!elements.editorStatus) return;
    elements.editorStatus.textContent = message;
    elements.editorStatus.classList.toggle("is-error", error);
  }

  function syncEditorHistory() {
    if (!state.regionSettings) return;
    const snapshot = state.regionSettings.snapshot();
    elements.editorUndo.disabled = !snapshot.canUndo;
    elements.editorRedo.disabled = !snapshot.canRedo;
  }

  function recordEditorChange(message) {
    const revision = state.regionSettings.snapshot().revision;
    state.editorStatusRevision = revision;
    syncEditorHistory();
    if (!state.regionPersistence) {
      setEditorStatus(`${message} Kept for this session; export JSON before closing.`, true);
      return;
    }
    setEditorStatus(`${message} Saving locally…`);
    state.regionSettings.flush().then(() => {
      const snapshot = state.regionSettings.snapshot();
      if (snapshot.revision !== revision || state.editorStatusRevision !== revision) return;
      if (snapshot.persistenceError) {
        setEditorStatus(`${message} Local storage failed; export JSON to keep this work.`, true);
      } else {
        setEditorStatus(`${message} Saved in this browser.`);
      }
    });
  }

  function setEditorPatch(target, patch, message = "Setting updated.") {
    if (!state.editorEnabled || !state.regionSettings || !target) return false;
    try {
      const changed = state.regionSettings.set(target, patch);
      if (changed) recordEditorChange(message);
      else setEditorStatus("No setting changed.");
      syncEditorHistory();
      return changed;
    } catch (error) {
      console.error("Unable to update region settings", error);
      setEditorStatus(error?.message || "This setting could not be saved.", true);
      return false;
    }
  }

  function removeEditorSetting(target, path, message = "Inherited setting restored.") {
    if (!state.editorEnabled || !state.regionSettings || !target) return false;
    try {
      const changed = state.regionSettings.remove(target, path);
      if (changed) recordEditorChange(message);
      else setEditorStatus("This scope is already inherited.");
      syncEditorHistory();
      return changed;
    } catch (error) {
      console.error("Unable to remove region setting", error);
      setEditorStatus(error?.message || "This setting could not be removed.", true);
      return false;
    }
  }

  function editorPatchForPath(path, value) {
    const [group, property] = String(path).split(".");
    return { [group]: { [property]: value } };
  }

  function editorControlValue(control, rawValue = control.value) {
    if (control.type === "color") return rawValue;
    if (control.tagName === "SELECT" && control.id !== "editor-font-weight") return rawValue;
    const numeric = Number(rawValue);
    const factor = Number(control.dataset.editorFactor) || 1;
    return numeric * factor;
  }

  function syncGeometryEditor(node, scopePatch, resolved = node.__whlSettings || {}) {
    const isRegion = elements.editorScope.value === "region";
    const labels = isRegion
      ? ["Left (%)", "Top (%)", "Width (%)", "Height (%)"]
      : ["Move X (%)", "Move Y (%)", "Width scale (%)", "Height scale (%)"];
    [elements.editorGeometryXLabel, elements.editorGeometryYLabel, elements.editorGeometryWidthLabel, elements.editorGeometryHeightLabel]
      .forEach((label, index) => { label.textContent = labels[index]; });
    elements.editorGeometryHelp.textContent = isRegion
      ? "Exact position and size for this region, as percentages of the page. Drag the handles on the page for direct adjustment."
      : "A reusable transform for every region matched by this scope. Values remain independent of reader zoom.";
    if (isRegion) {
      const box = node.__whlDisplayBox || node.__whlBaseBox;
      elements.editorGeometryX.value = (box[0] * 100).toFixed(1);
      elements.editorGeometryY.value = (box[1] * 100).toFixed(1);
      elements.editorGeometryWidth.value = ((box[2] - box[0]) * 100).toFixed(1);
      elements.editorGeometryHeight.value = ((box[3] - box[1]) * 100).toFixed(1);
      elements.editorGeometryX.min = "0";
      elements.editorGeometryY.min = "0";
      elements.editorGeometryWidth.min = "0.5";
      elements.editorGeometryHeight.min = "0.5";
      elements.editorGeometryWidth.max = "100";
      elements.editorGeometryHeight.max = "100";
      [elements.editorGeometryX, elements.editorGeometryY, elements.editorGeometryWidth, elements.editorGeometryHeight]
        .forEach((control) => { control.placeholder = ""; });
    } else {
      const geometry = scopePatch?.geometry || {};
      const effective = resolved.geometry || {};
      const fields = [
        [elements.editorGeometryX, "translateX", 0],
        [elements.editorGeometryY, "translateY", 0],
        [elements.editorGeometryWidth, "scaleX", 1],
        [elements.editorGeometryHeight, "scaleY", 1]
      ];
      fields.forEach(([control, property, fallback]) => {
        control.value = hasOwn(geometry, property) ? (Number(geometry[property]) * 100).toFixed(1) : "";
        control.placeholder = `${((Number(effective[property]) || fallback) * 100).toFixed(1)} inherited`;
      });
      elements.editorGeometryX.min = "-100";
      elements.editorGeometryY.min = "-100";
      elements.editorGeometryWidth.min = "25";
      elements.editorGeometryHeight.min = "25";
      elements.editorGeometryWidth.max = "400";
      elements.editorGeometryHeight.max = "400";
    }
  }

  function syncEditorPanel() {
    if (!state.editorEnabled || !elements.editorPanel) return;
    const node = selectedRegionNode();
    const controls = [...elements.editorPanel.querySelectorAll("input, select, button")]
      .filter((control) => ![elements.editorClose, elements.editorImport].includes(control));
    if (!node) {
      elements.editorSelection.textContent = "Choose a text region on the facsimile page.";
      const globalControls = new Set([
        elements.editorClose,
        elements.editorImport,
        elements.editorExport,
        elements.editorUndo,
        elements.editorRedo
      ]);
      controls.forEach((control) => { control.disabled = !globalControls.has(control); });
      globalControls.forEach((control) => { control.disabled = false; });
      syncEditorHistory();
      elements.editorImport.closest("label")?.classList.remove("is-disabled");
      return;
    }

    controls.forEach((control) => { control.disabled = false; });
    syncEditorHistory();
    elements.editorSelection.textContent = `Page ${state.page} · ${node.dataset.role.replaceAll("-", " ")} · ${node.dataset.regionId}`;
    const target = editorTarget();
    const context = regionSettingsContext(node.dataset.regionId, node.dataset.role);
    const resolved = resolveRegionSettings(context);
    let scopePatch = {};
    let localPatch = {};
    try {
      scopePatch = state.regionSettings.getScope(target, { source: "overlay" }) || {};
      localPatch = state.regionSettings.getScope(target, { source: "local" }) || {};
    } catch {
      // Invalid/stale scope data is already excluded by the engine.
    }

    elements.editorFontFamily.value = resolved.style?.fontFamily || "edition";
    elements.editorFontSize.value = String(Math.round((Number(resolved.style?.fontSize) || 1) * 100));
    elements.editorFontWeight.value = String(Number(resolved.style?.fontWeight) || (["title", "heading", "header"].includes(node.dataset.role) ? 600 : 400));
    const inkChannels = colorChannels(resolved.style?.color || getComputedStyle(elements.facsimilePage).getPropertyValue("--page-ink"));
    elements.editorFontColor.value = inkChannels ? channelsToHex(inkChannels) : "#29261e";
    elements.editorLineHeight.value = String(Number(resolved.style?.lineHeight) || roleLineHeight(node.dataset.role));
    elements.editorLetterSpacing.value = String(Number(resolved.style?.letterSpacing) || 0);
    elements.editorFitMode.value = resolved.fit?.mode || "scroll";
    elements.editorWrap.value = resolved.fit?.wrap || "normal";
    elements.editorOverflow.value = resolved.fit?.overflow || "auto";
    elements.editorMaxWidth.value = String(Math.round((Number(resolved.fit?.maxWidthScale) || 1.5) * 100));
    elements.editorMinFont.value = String(Math.round((Number(resolved.fit?.minFontScale) || 0.7) * 100));
    syncGeometryEditor(node, scopePatch, resolved);

    elements.editorPanel.querySelectorAll("[data-editor-clear]").forEach((button) => {
      button.disabled = valueAtPath(localPatch, button.dataset.editorClear) === undefined;
    });
    elements.editorTextToggle.checked = state.textEditing;
    elements.editorRestoreText.disabled = !resolved.hasTextOverride;
  }

  function syncEditorOverlay() {
    if (!elements.editorOverlay || !state.editorActive) {
      if (elements.editorOverlay) elements.editorOverlay.hidden = true;
      return;
    }
    const node = selectedRegionNode();
    if (!node?.__whlDisplayBox) {
      elements.editorOverlay.hidden = true;
      return;
    }
    const [x0, y0, x1, y1] = node.__whlDisplayBox;
    elements.editorOverlay.hidden = false;
    elements.editorOverlay.style.left = `${x0 * 100}%`;
    elements.editorOverlay.style.top = `${y0 * 100}%`;
    elements.editorOverlay.style.width = `${(x1 - x0) * 100}%`;
    elements.editorOverlay.style.height = `${(y1 - y0) * 100}%`;
  }

  function configureEditorRegionAccessibility(region, selected = false) {
    if (!state.editorActive) {
      region.removeAttribute("role");
      region.removeAttribute("aria-current");
      region.removeAttribute("aria-label");
      if (!region.textContent && !["illustration", "image"].includes(region.dataset.role)) {
        region.setAttribute("aria-hidden", "true");
      }
      updateTextRegionOverflow(region);
      return;
    }
    region.removeAttribute("aria-hidden");
    if (!region.isContentEditable) region.setAttribute("role", "button");
    region.setAttribute(
      "aria-label",
      `${region.dataset.role.replaceAll("-", " ")} region ${region.dataset.regionId}${selected ? ", selected" : ""}${region.textContent.trim() ? `: ${region.textContent.replace(/\s+/g, " ").trim().slice(0, 100)}` : ""}`
    );
    if (selected) region.setAttribute("aria-current", "true");
    else region.removeAttribute("aria-current");
    region.tabIndex = selected ? 0 : -1;
  }

  function selectEditorRegion(regionId, options = {}) {
    if (!state.editorEnabled) return false;
    const id = String(regionId || "");
    const node = [...elements.facsimileText.querySelectorAll(".text-region")]
      .find((candidate) => candidate.dataset.regionId === id);
    if (!node) return false;
    if (!state.editorActive) setEditorActive(true);
    if (state.textEditing && state.selectedRegionId !== id) finishTextEditing(true);
    state.selectedRegionId = id;
    elements.facsimileText.querySelectorAll(".text-region").forEach((region) => {
      region.classList.toggle("is-editor-selected", region === node);
      configureEditorRegionAccessibility(region, region === node);
    });
    syncEditorPanel();
    syncEditorOverlay();
    announce(`${node.dataset.role.replaceAll("-", " ")} region ${node.dataset.regionId} selected`);
    if (options.focus !== false) {
      node.focus({ preventScroll: true });
      if (window.matchMedia?.("(max-width: 850px)")?.matches) {
        node.scrollIntoView({ block: "center", inline: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
      }
    }
    return true;
  }

  function clearEditorSelection() {
    if (state.textEditing) finishTextEditing(true);
    state.selectedRegionId = null;
    elements.facsimileText.querySelectorAll(".text-region").forEach((region) => {
      region.classList.remove("is-editor-selected", "is-text-editing");
      configureEditorRegionAccessibility(region, false);
    });
    elements.editorOverlay.hidden = true;
    syncEditorPanel();
  }

  function setEditorActive(active) {
    if (!state.editorEnabled) return;
    state.editorActive = Boolean(active);
    document.body.classList.toggle("is-editor-active", state.editorActive);
    elements.editorToggle.setAttribute("aria-pressed", String(state.editorActive));
    elements.editorToggle.setAttribute("aria-expanded", String(state.editorActive));
    elements.editorPanel.hidden = !state.editorActive;
    if (state.editorActive) {
      elements.readingSettings.open = false;
      const regions = [...elements.facsimileText.querySelectorAll(".text-region")];
      const current = selectedRegionNode();
      const firstReadable = preferredEditorRegion(regions);
      if (current || firstReadable) selectEditorRegion((current || firstReadable).dataset.regionId);
      else {
        syncEditorPanel();
        syncEditorOverlay();
        setEditorStatus("This page has no selectable regions.");
      }
    } else {
      finishTextEditing(true);
      elements.editorOverlay.hidden = true;
      elements.facsimileText.querySelectorAll(".text-region").forEach((region) => {
        region.classList.remove("is-editor-selected");
        configureEditorRegionAccessibility(region, false);
      });
      elements.editorToggle.focus({ preventScroll: true });
    }
    updatePageSizing();
  }

  function persistEditedText(message = "Text correction updated.") {
    const node = selectedRegionNode();
    window.clearTimeout(state.editorSaveTimer);
    if (!state.textEditing || !node || !state.editorTextDirty) return false;
    try {
      const changed = state.regionSettings.setText(exactRegionTarget(), state.layer, editablePlainText(node));
      state.editorTextDirty = false;
      state.editorTextAutosaved ||= changed;
      if (changed) recordEditorChange(message);
      return changed;
    } catch (error) {
      setEditorStatus(error?.message || "The text correction could not be saved.", true);
      return false;
    }
  }

  function queueEditedTextSave() {
    window.clearTimeout(state.editorSaveTimer);
    state.editorSaveTimer = window.setTimeout(() => persistEditedText(), 400);
  }

  function finishTextEditing(commit = true) {
    const node = selectedRegionNode();
    if (!state.textEditing || !node) return;
    window.clearTimeout(state.editorSaveTimer);
    if (commit) {
      persistEditedText();
    } else {
      try {
        if (state.editorTextAutosaved) {
          const changed = state.editorTextHadOverride
            ? state.regionSettings.setText(exactRegionTarget(), state.layer, state.editorTextOriginalOverride)
            : state.regionSettings.clearText(exactRegionTarget(), state.layer);
          if (changed) recordEditorChange("Text edit cancelled and the prior text restored.");
        } else {
          setEditorStatus("Text edit cancelled.");
        }
      } catch (error) {
        setEditorStatus(error?.message || "The prior text could not be restored.", true);
      }
      node.textContent = state.editorTextStart;
    }
    node.removeAttribute("contenteditable");
    node.removeAttribute("aria-multiline");
    node.classList.remove("is-text-editing");
    state.textEditing = false;
    state.editorTextDirty = false;
    state.editorTextAutosaved = false;
    elements.editorTextToggle.checked = false;
    configureEditorRegionAccessibility(node, true);
    scheduleTextFit();
    syncEditorPanel();
  }

  function setTextEditing(active) {
    const node = selectedRegionNode();
    if (!active) {
      finishTextEditing(true);
      return;
    }
    if (!node || !state.editorEnabled) return;
    const localPatch = state.regionSettings.getScope(exactRegionTarget(), { source: "local" }) || {};
    state.textEditing = true;
    state.editorTextDirty = false;
    state.editorTextHadOverride = hasOwn(localPatch.text, state.layer);
    state.editorTextOriginalOverride = state.editorTextHadOverride ? String(localPatch.text[state.layer] ?? "") : "";
    state.editorTextAutosaved = false;
    state.editorTextStart = node.textContent || "";
    node.contentEditable = "plaintext-only";
    if (!node.isContentEditable) node.contentEditable = "true";
    node.setAttribute("role", "textbox");
    node.setAttribute("aria-multiline", "true");
    node.setAttribute("aria-label", `Edit ${node.dataset.role.replaceAll("-", " ")} text on page ${state.page}`);
    node.classList.add("is-text-editing");
    node.removeAttribute("aria-hidden");
    node.focus({ preventScroll: true });
    setEditorStatus("Editing text. Press Escape to cancel or Control/Command+Enter to save.");
    syncEditorPanel();
  }

  function insertTextAtSelection(text) {
    const selection = window.getSelection?.();
    if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(normalizePlainText(text));
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function insertPlainText(event) {
    if (!state.textEditing) return;
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") || "";
    if (insertTextAtSelection(text)) {
      state.editorTextDirty = true;
      scheduleTextFit();
      queueEditedTextSave();
    }
  }

  function geometryBoxFromInputs(changedControl, rawValue) {
    const value = (control) => Number(control === changedControl ? rawValue : control.value) / 100;
    const width = clamp(value(elements.editorGeometryWidth), 0.005, 1);
    const height = clamp(value(elements.editorGeometryHeight), 0.005, 1);
    const x = clamp(value(elements.editorGeometryX), 0, 1 - width);
    const y = clamp(value(elements.editorGeometryY), 0, 1 - height);
    return [x, y, x + width, y + height];
  }

  function commitGeometryInput(control, rawValue = control.value) {
    const target = editorTarget();
    if (!target || rawValue === "" || !control.checkValidity()) return;
    if (target.scope === "region") {
      setEditorPatch(target, { geometry: { box: geometryBoxFromInputs(control, rawValue) } }, "Region geometry updated.");
    } else {
      const properties = new Map([
        [elements.editorGeometryX, ["translateX", -1, 1]],
        [elements.editorGeometryY, ["translateY", -1, 1]],
        [elements.editorGeometryWidth, ["scaleX", 0.25, 4]],
        [elements.editorGeometryHeight, ["scaleY", 0.25, 4]]
      ]);
      const [property, minimum, maximum] = properties.get(control);
      const value = clamp(Number(rawValue) / 100, minimum, maximum);
      setEditorPatch(target, { geometry: { [property]: value } }, "Region scaling rule updated.");
    }
  }

  function adjustedBox(box, mode, dx, dy) {
    let [x0, y0, x1, y1] = box;
    if (mode === "move") {
      const width = x1 - x0;
      const height = y1 - y0;
      x0 = clamp(x0 + dx, 0, 1 - width);
      y0 = clamp(y0 + dy, 0, 1 - height);
      x1 = x0 + width;
      y1 = y0 + height;
    } else {
      x1 = clamp(x1 + dx, x0 + 0.005, 1);
      y1 = clamp(y1 + dy, y0 + 0.005, 1);
    }
    return [x0, y0, x1, y1];
  }

  function beginEditorDrag(event, mode) {
    if (event.button !== 0) return;
    const node = selectedRegionNode();
    if (!node?.__whlDisplayBox) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    state.editorDrag = {
      pointerId: event.pointerId,
      handle: event.currentTarget,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startBox: [...node.__whlDisplayBox],
      box: [...node.__whlDisplayBox],
      pageRect: elements.facsimilePage.getBoundingClientRect()
    };
    elements.editorOverlay.classList.add("is-dragging");
  }

  function moveEditorDrag(event) {
    const drag = state.editorDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const width = Math.max(1, drag.pageRect.width);
    const height = Math.max(1, drag.pageRect.height);
    drag.box = adjustedBox(drag.startBox, drag.mode, (event.clientX - drag.startX) / width, (event.clientY - drag.startY) / height);
    const node = selectedRegionNode();
    setRegionBox(node, drag.box);
    syncEditorOverlay();
    syncGeometryEditor(node, {});
  }

  function endEditorDrag(event, commit = true) {
    const drag = state.editorDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.handle.releasePointerCapture?.(event.pointerId);
    state.editorDrag = null;
    elements.editorOverlay.classList.remove("is-dragging");
    const node = selectedRegionNode();
    if (!commit) {
      setRegionBox(node, drag.startBox);
      syncEditorOverlay();
      syncEditorPanel();
      return;
    }
    setEditorPatch(exactRegionTarget(), { geometry: { box: drag.box } }, "Manual region adjustment saved.");
  }

  function nudgeEditorRegion(event, mode) {
    if (!event.key.startsWith("Arrow")) return;
    const node = selectedRegionNode();
    if (!node?.__whlDisplayBox) return;
    event.preventDefault();
    const amount = event.shiftKey ? 0.01 : 0.002;
    const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
    const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
    const box = adjustedBox(node.__whlDisplayBox, mode, dx, dy);
    setEditorPatch(exactRegionTarget(), { geometry: { box } }, mode === "move" ? "Region moved." : "Region resized.");
  }

  async function exportEditorSettings() {
    try {
      finishTextEditing(true);
      const exported = state.regionSettings.export({ stringify: true, pretty: true });
      const content = typeof exported === "string" ? exported : JSON.stringify(exported, null, 2);
      const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `whl-region-settings-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setEditorStatus("Settings exported for review or publication.");
    } catch (error) {
      setEditorStatus(error?.message || "Settings could not be exported.", true);
    }
  }

  async function importEditorSettings(file) {
    if (!file) return;
    try {
      finishTextEditing(true);
      if (file.size > 2_000_000) throw new Error("The settings file is larger than 2 MB.");
      const documentValue = JSON.parse(await file.text());
      const preview = window.WHLRegionSettings.createEngine({
        local: documentValue,
        projectId: "living-herbal",
        editorEnabled: false
      });
      await preview.ready;
      const canonical = preview.export();
      const books = Object.keys(canonical.overrides);
      const pages = Object.values(canonical.overrides).reduce(
        (count, book) => count + Object.keys(book.pages || {}).length,
        0
      );
      const approved = window.confirm(
        `Import validated settings for ${books.length} ${books.length === 1 ? "book" : "books"} across ${pages} ${pages === 1 ? "page" : "pages"}? Existing local settings will be retained unless the import replaces the same property.`
      );
      if (!approved) {
        setEditorStatus("Import cancelled; no settings changed.");
        return;
      }
      const changed = state.regionSettings.import(canonical, { mode: "merge" });
      if (changed) recordEditorChange("Validated settings imported.");
      else setEditorStatus("The imported settings already match this draft.");
      applyAllRegionSettings();
    } catch (error) {
      console.error("Unable to import region settings", error);
      setEditorStatus(error?.message || "The settings file is invalid.", true);
    } finally {
      elements.editorImport.value = "";
    }
  }

  function mountRegionEditor() {
    if (!state.editorEnabled || elements.editorToggle.dataset.mounted === "true") return;
    elements.editorToggle.dataset.mounted = "true";
    elements.editorToggle.hidden = false;
    elements.editorToggle.addEventListener("click", () => setEditorActive(!state.editorActive));
    elements.editorClose.addEventListener("click", () => setEditorActive(false));
    elements.editorScope.addEventListener("change", syncEditorPanel);
    elements.editorPanel.querySelectorAll("[data-editor-path]").forEach((control) => {
      const commit = (rawValue = control.value) => {
        if (rawValue === "" || !control.checkValidity()) return;
        const target = editorTarget();
        const value = editorControlValue(control, rawValue);
        setEditorPatch(target, editorPatchForPath(control.dataset.editorPath, value));
      };
      control.addEventListener("change", () => {
        window.clearTimeout(state.editorControlTimers.get(control));
        commit();
      });
      if (control.tagName === "INPUT") {
        control.addEventListener("input", () => {
          const rawValue = control.value;
          window.clearTimeout(state.editorControlTimers.get(control));
          state.editorControlTimers.set(control, window.setTimeout(() => commit(rawValue), 140));
        });
      }
    });
    elements.editorPanel.querySelectorAll("[data-editor-clear]").forEach((button) => {
      button.addEventListener("click", () => removeEditorSetting(editorTarget(), button.dataset.editorClear));
    });
    [elements.editorGeometryX, elements.editorGeometryY, elements.editorGeometryWidth, elements.editorGeometryHeight]
      .forEach((control) => {
        const commit = (rawValue = control.value) => commitGeometryInput(control, rawValue);
        control.addEventListener("change", () => {
          window.clearTimeout(state.editorControlTimers.get(control));
          commit();
        });
        control.addEventListener("input", () => {
          const rawValue = control.value;
          window.clearTimeout(state.editorControlTimers.get(control));
          state.editorControlTimers.set(control, window.setTimeout(() => commit(rawValue), 140));
        });
      });
    elements.editorResetGeometry.addEventListener("click", () => removeEditorSetting(editorTarget(), "geometry", "Inherited geometry restored."));
    elements.editorTextToggle.addEventListener("change", () => setTextEditing(elements.editorTextToggle.checked));
    elements.editorRestoreText.addEventListener("click", () => {
      finishTextEditing(false);
      try {
        const target = exactRegionTarget();
        const node = selectedRegionNode();
        const basePatch = state.regionSettings.getScope(target, { source: "base" }) || {};
        const sourceText = sanitizeDisplayText(selectedText(node.__whlSourceRegion || {}).value);
        const changed = hasOwn(basePatch.text, state.layer)
          ? state.regionSettings.setText(target, state.layer, sourceText)
          : state.regionSettings.clearText(target, state.layer);
        if (changed) recordEditorChange("OCR source text restored.");
        else setEditorStatus("This region already uses its OCR source text.");
      } catch (error) {
        setEditorStatus(error?.message || "Source text could not be restored.", true);
      }
    });
    elements.editorUndo.addEventListener("click", () => {
      finishTextEditing(true);
      const changed = state.regionSettings.undo();
      if (changed) recordEditorChange("Last change undone.");
      else syncEditorHistory();
    });
    elements.editorRedo.addEventListener("click", () => {
      finishTextEditing(true);
      const changed = state.regionSettings.redo();
      if (changed) recordEditorChange("Change restored.");
      else syncEditorHistory();
    });
    elements.editorResetScope.addEventListener("click", () => {
      finishTextEditing(true);
      removeEditorSetting(editorTarget(), undefined, "Local settings for this scope reset.");
    });
    elements.editorExport.addEventListener("click", exportEditorSettings);
    elements.editorImport.addEventListener("change", () => importEditorSettings(elements.editorImport.files?.[0]));

    elements.facsimileText.addEventListener("click", (event) => {
      if (!state.editorActive) return;
      const region = event.target.closest?.(".text-region");
      if (region && elements.facsimileText.contains(region)) selectEditorRegion(region.dataset.regionId, { focus: false });
    });
    elements.facsimileText.addEventListener("keydown", (event) => {
      const region = event.target.closest?.(".text-region");
      if (!region || !state.editorActive) return;
      if (event.isComposing || state.editorComposing) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && state.textEditing) {
        event.preventDefault();
        finishTextEditing(true);
        region.focus({ preventScroll: true });
      } else if (!state.textEditing
        && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
        && (!region.classList.contains("is-overflowing") || event.ctrlKey)) {
        event.preventDefault();
        const regions = [...elements.facsimileText.querySelectorAll(".text-region")];
        const direction = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
        const next = regions[(regions.indexOf(region) + direction + regions.length) % regions.length];
        if (next) selectEditorRegion(next.dataset.regionId);
      } else if (!state.textEditing && ["Enter", " "].includes(event.key)) {
        event.preventDefault();
        selectEditorRegion(region.dataset.regionId, { focus: false });
        elements.editorScope.focus({ preventScroll: true });
      }
    });
    elements.facsimileText.addEventListener("beforeinput", (event) => {
      if (!state.textEditing || event.isComposing || event.inputType !== "insertParagraph") return;
      event.preventDefault();
      if (insertTextAtSelection("\n")) {
        state.editorTextDirty = true;
        scheduleTextFit();
        queueEditedTextSave();
      }
    });
    elements.facsimileText.addEventListener("input", (event) => {
      if (state.textEditing && event.target === selectedRegionNode() && !state.editorComposing) {
        state.editorTextDirty = true;
        setEditorStatus("Text correction pending local save…");
        scheduleTextFit();
        queueEditedTextSave();
      }
    });
    elements.facsimileText.addEventListener("compositionstart", () => { state.editorComposing = true; });
    elements.facsimileText.addEventListener("compositionend", () => {
      state.editorComposing = false;
      state.editorTextDirty = true;
      scheduleTextFit();
      queueEditedTextSave();
    });
    elements.facsimileText.addEventListener("paste", insertPlainText);
    elements.facsimileText.addEventListener("focusout", (event) => {
      if (!state.textEditing || event.target !== selectedRegionNode()) return;
      if (!event.relatedTarget || !event.target.contains(event.relatedTarget)) persistEditedText();
    });

    elements.editorMoveHandle.addEventListener("pointerdown", (event) => beginEditorDrag(event, "move"));
    elements.editorResizeHandle.addEventListener("pointerdown", (event) => beginEditorDrag(event, "resize"));
    [elements.editorMoveHandle, elements.editorResizeHandle].forEach((handle) => {
      handle.addEventListener("pointermove", moveEditorDrag);
      handle.addEventListener("pointerup", (event) => endEditorDrag(event, true));
      handle.addEventListener("pointercancel", (event) => endEditorDrag(event, false));
    });
    elements.editorMoveHandle.addEventListener("keydown", (event) => nudgeEditorRegion(event, "move"));
    elements.editorResizeHandle.addEventListener("keydown", (event) => nudgeEditorRegion(event, "resize"));
    const flushEditorDraft = () => {
      if (state.textEditing && !state.editorComposing) persistEditedText();
      state.regionSettings.flush().catch(() => {});
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushEditorDraft();
    });
    window.addEventListener("pagehide", flushEditorDraft);
    syncEditorPanel();
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
    if (changed && state.editorActive) clearEditorSelection();
    state.page = page;
    updatePageControls();
    if (options.history !== "none") updateHistory(options.history || "push");
    if (changed || options.force) loadPage(page, options.announce !== false);
  }

  function setLayer(layer) {
    if (!["modern", "diplomatic"].includes(layer)) return;
    if (state.textEditing) finishTextEditing(true);
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
    elements.fullscreenToggle.setAttribute("aria-label", active ? "Exit full screen" : "Full screen");
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
      if (event.isComposing || state.editorComposing) return;
      if (event.key === "Escape" && state.textEditing) {
        event.preventDefault();
        const region = selectedRegionNode();
        finishTextEditing(false);
        region?.focus({ preventScroll: true });
        return;
      }
      if (event.key === "Escape" && state.editorActive) {
        event.preventDefault();
        setEditorActive(false);
        announce("Region editor closed");
        return;
      }
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
      if (reservesArrowKeys(target)) return;
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
      await initializeRegionSettings();
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
    sanitizeDisplayText,
    isRegionEditorEnabled,
    reservesArrowKeys,
    transformedRegionBox
  });

  initialize();
})();
