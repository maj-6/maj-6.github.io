(() => {
  "use strict";

  const CATALOG_PATH = "data/catalog.json";
  const catalogUrl = new URL(CATALOG_PATH, window.location.href);
  const elements = {
    grid: document.querySelector("#book-grid"),
    status: document.querySelector("#catalog-status"),
    heroCovers: document.querySelector("#hero-covers"),
    openFirst: document.querySelector("#open-first"),
    projectKicker: document.querySelector("#project-kicker"),
    projectDescription: document.querySelector("#project-description"),
    heroTitle: document.querySelector("#hero-title"),
    bookCount: document.querySelector("#book-count"),
    languageCount: document.querySelector("#language-count")
  };

  const create = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  const resolveAsset = (value) => {
    if (!value || typeof value !== "string") return "";
    try {
      return new URL(value, catalogUrl).href;
    } catch {
      return "";
    }
  };

  const representativePage = (book) => {
    const requestedCover = Number.parseInt(book.cover_page, 10);
    const pageCount = Number.parseInt(book.pages, 10);
    return Number.isInteger(requestedCover)
      && requestedCover > 0
      && (!Number.isInteger(pageCount) || requestedCover <= pageCount)
      ? requestedCover
      : 1;
  };

  const representativeDetails = Object.freeze({
    "fuchs-1542:236": "a full-page botanical woodcut with small plant labels and a running header",
    "herbarius-1488:264": "a botanical woodcut surrounded by two columns of blackletter text",
    "banckes-1552:1": "a title-page woodcut with separately printed title and imprint text"
  });

  const representativePageDescription = (book) => {
    const page = representativePage(book);
    const title = book.title || book.short_title || "the volume";
    const detail = representativeDetails[`${book.id}:${page}`];
    return detail
      ? `Selected scan of page ${page} from ${title}, showing ${detail}.`
      : `Selected representative scan of page ${page} from ${title}.`;
  };

  const readerHref = (book) => {
    const url = new URL("reader.html", window.location.href);
    url.searchParams.set("book", book.id);
    url.searchParams.set("page", String(representativePage(book)));
    return `${url.pathname.split("/").pop()}${url.search}`;
  };

  const safeAccent = (value, index = 0) => {
    const fallbacks = ["#5b7258", "#995039", "#647177"];
    if (typeof value === "string" && window.CSS?.supports?.("color", value)) return value;
    return fallbacks[index % fallbacks.length];
  };

  const compactNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number.toLocaleString() : "—";
  };

  const coverFallback = (book) => {
    const fallback = create("div", "book-cover-fallback", book.short_title || book.title || "Herbal");
    fallback.setAttribute("aria-hidden", "true");
    return fallback;
  };

  const createCover = (book) => {
    const source = resolveAsset(book.cover);
    if (!source) return coverFallback(book);

    const image = create("img", "book-cover");
    image.src = source;
    image.alt = representativePageDescription(book);
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => image.replaceWith(coverFallback(book)), { once: true });
    return image;
  };

  const renderBook = (book, index) => {
    const article = create("article", "book-card");
    article.style.setProperty("--accent", safeAccent(book.accent, index));

    const coverWrap = create("div", "book-cover-wrap");
    coverWrap.append(createCover(book));

    const copy = create("div", "book-card-copy");
    const language = book.language || "Original language";
    copy.append(create("div", "book-sequence", `Volume ${String(index + 1).padStart(2, "0")} · ${language}`));

    const heading = create("h3", "", book.title || book.short_title || `Volume ${index + 1}`);
    heading.id = `book-${index + 1}-title`;
    copy.append(heading);

    const subtitleParts = [book.creator, book.year].filter(Boolean);
    if (book.subtitle) subtitleParts.unshift(book.subtitle);
    if (subtitleParts.length) copy.append(create("p", "book-subtitle", subtitleParts.join(" · ")));
    if (book.description) copy.append(create("p", "book-description", book.description));
    if (book.significance) copy.append(create("p", "book-significance", book.significance));

    const footer = create("div", "book-card-footer");
    const data = create("div", "book-data");
    [language, book.year, `${compactNumber(book.pages)} pages`]
      .filter(Boolean)
      .forEach((item) => data.append(create("span", "", item)));
    footer.append(data);

    const open = create("div", "book-open", "Open facsimile");
    open.append(create("span", "", "→"));
    open.setAttribute("aria-hidden", "true");
    footer.append(open);
    copy.append(footer);

    const link = create("a", "book-card-link");
    link.href = readerHref(book);
    link.setAttribute("aria-label", `Open ${book.title || book.short_title || `volume ${index + 1}`} in the facsimile reader`);

    article.append(coverWrap, copy, link);
    article.setAttribute("aria-labelledby", heading.id);
    return article;
  };

  const renderHeroCovers = (books) => {
    const covers = books.slice(0, 3).map((book, index) => {
      const folio = create("div", "hero-folio");
      folio.style.setProperty("background", safeAccent(book.accent, index));
      const source = resolveAsset(book.cover);
      if (source) {
        const image = create("img");
        image.src = source;
        image.alt = representativePageDescription(book);
        image.decoding = "async";
        if (index > 0) image.loading = "lazy";
        image.addEventListener("error", () => image.remove(), { once: true });
        folio.append(image);
      }
      folio.append(create("span", "hero-folio-caption", `${book.short_title || book.title || "Herbal"}${book.year ? ` · ${book.year}` : ""}`));
      return folio;
    });
    elements.heroCovers.replaceChildren(...covers);
  };

  const renderProject = (catalog) => {
    const project = catalog.project || {};
    const books = Array.isArray(catalog.books) ? catalog.books : [];
    const languages = [...new Set(books.map((book) => book.language).filter(Boolean))];
    const years = books.map((book) => Number.parseInt(book.year, 10)).filter(Number.isFinite).sort((a, b) => a - b);

    elements.bookCount.textContent = String(books.length);
    elements.languageCount.textContent = String(languages.length || 3);

    if (project.description) elements.projectDescription.textContent = project.description;
    if (project.kicker) {
      elements.projectKicker.textContent = project.kicker;
    } else if (years.length) {
      const range = years[0] === years.at(-1) ? String(years[0]) : `${years[0]}—${years.at(-1)}`;
      elements.projectKicker.textContent = `${range} · ${languages.join(", ") || "early botanical books"}`;
    }

    if (project.headline) {
      elements.heroTitle.textContent = project.headline;
    }
    if (project.title) document.title = `${project.title} — Read the early herbals`;
  };

  const renderCatalog = (catalog) => {
    const books = Array.isArray(catalog.books) ? catalog.books.filter((book) => book && book.id) : [];
    if (!books.length) throw new Error("The catalogue contains no readable volumes.");

    renderProject({ ...catalog, books });
    elements.grid.replaceChildren(...books.map(renderBook));
    elements.grid.setAttribute("aria-busy", "false");
    elements.status.hidden = true;
    renderHeroCovers(books);
    elements.openFirst.href = readerHref(books[0]);
  };

  const showError = (error) => {
    console.error("Unable to load World Herb Library catalogue", error);
    const title = create("strong", "", "The catalogue could not be opened.");
    const detail = create("span", "", "Check your connection, then try once more.");
    const retry = create("button", "retry-button", "Try again");
    retry.type = "button";
    retry.addEventListener("click", loadCatalog, { once: true });
    elements.status.hidden = false;
    elements.status.className = "catalog-status catalog-error";
    elements.status.replaceChildren(title, detail, retry);
    elements.grid.setAttribute("aria-busy", "false");
  };

  async function loadCatalog() {
    elements.status.hidden = false;
    elements.status.className = "catalog-status";
    const leaf = create("span", "status-leaf");
    leaf.setAttribute("aria-hidden", "true");
    elements.status.replaceChildren(leaf, create("span", "", "Opening the catalogue…"));
    elements.grid.setAttribute("aria-busy", "true");

    try {
      const response = await fetch(catalogUrl, {
        cache: "no-cache",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error(`Catalogue request returned ${response.status}`);
      renderCatalog(await response.json());
    } catch (error) {
      showError(error);
    }
  }

  loadCatalog();
})();
