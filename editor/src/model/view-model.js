import {
  DECORATED_INITIAL_COMPONENT,
  PAGE_APPEARANCE_COMPONENT,
  evaluatePage
} from "@whl/facsimile-engine";

const DEFAULT_TYPOGRAPHY = Object.freeze({
  fontFamily: "edition",
  fontSize: 1,
  fontWeight: 400,
  color: "#3f3026",
  lineHeight: 1.2,
  letterSpacing: 0,
  textAlign: "start",
  textAlignLast: "auto",
  textJustify: "auto",
  hyphens: "manual"
});

export const DEFAULT_PAGE_APPEARANCE = Object.freeze({
  mode: "matched",
  color: "#d4bca5",
  texture: Object.freeze({ kind: "none", strength: 0, scale: 1 })
});

function effectivePageAppearance(evaluatedPage) {
  const authored = evaluatedPage?.components?.[PAGE_APPEARANCE_COMPONENT] || {};
  return {
    ...DEFAULT_PAGE_APPEARANCE,
    ...authored,
    texture: {
      ...DEFAULT_PAGE_APPEARANCE.texture,
      ...(authored.texture || {})
    }
  };
}

function pageAppearanceSource(evaluatedPage) {
  const provenance = evaluatedPage?.provenance || {};
  const fields = ["mode", "color", "texture.kind", "texture.strength", "texture.scale"];
  const specificity = { componentDefault: 0, project: 1, book: 2, page: 3 };
  const entries = fields
    .map((field) => provenance[`${PAGE_APPEARANCE_COMPONENT}.${field}`])
    .filter(Boolean);
  return entries.sort((first, second) =>
    (specificity[first.scope] ?? -1) - (specificity[second.scope] ?? -1)
  ).at(-1)?.scope || "componentDefault";
}

function taxonomyView(taxonomy) {
  return {
    categories: Object.fromEntries(Object.entries(taxonomy.categories).map(([id, item]) => [id, {
      ...item,
      label: item.displayName
    }])),
    classes: Object.fromEntries(Object.entries(taxonomy.classes).map(([id, item]) => [id, {
      ...item,
      label: item.displayName
    }])),
    labels: Object.fromEntries(Object.entries(taxonomy.labels).map(([id, item]) => [id, {
      ...item,
      label: item.displayName
    }]))
  };
}

function rendererFor(engine, evaluatedById, regionId, activeEdition) {
  const evaluated = evaluatedById.get(regionId);
  const category = evaluated.categoryId ? engine.project.taxonomy.categories[evaluated.categoryId] : null;
  return engine.renderers.evaluate(evaluated, category, {
    activeEdition,
    regionContent(continuationRegionId, edition) {
      return evaluatedById.get(continuationRegionId)?.components["core.content"]?.[edition] || "";
    }
  });
}

/** Build a detached renderer-facing projection from immutable engine state. */
export function createEditorViewModel(engine) {
  const document = engine.project;
  const taxonomy = taxonomyView(document.taxonomy);
  const demoUi = document.extensions["whl.demo-ui"] || {};
  const bookOrder = Object.keys(document.books);
  const books = {};

  for (const bookId of bookOrder) {
    const book = document.books[bookId];
    const bookUi = demoUi.books?.[bookId] || {};
    const pageOrder = Object.keys(book.pages).sort((first, second) => Number(first) - Number(second));
    const pages = {};
    for (const pageId of pageOrder) {
      const page = book.pages[pageId];
      const sourcePage = document.sourceLibrary.books[bookId].pages[pageId];
      const evaluatedPage = typeof engine.evaluatePage === "function"
        ? engine.evaluatePage(bookId, Number(pageId))
        : evaluatePage(document, engine.components, bookId, Number(pageId));
      const regionOrder = Object.keys(page.regions);
      const evaluatedById = new Map(regionOrder.map((regionId) => [
        regionId,
        engine.evaluateRegion(bookId, Number(pageId), regionId)
      ]));
      const regions = {};
      for (const regionId of regionOrder) {
        const evaluated = evaluatedById.get(regionId);
        const source = evaluated.sourceRegion || {};
        const typography = { ...DEFAULT_TYPOGRAPHY, ...(evaluated.components["core.typography"] || {}) };
        const transform = evaluated.components["core.transform"] || {};
        const content = evaluated.components["core.content"] || {};
        const labelIds = [...evaluated.labelIds];
        const decorated = evaluated.categoryCapabilities.includes("decorated-initial");
        regions[regionId] = {
          id: regionId,
          displayName: evaluated.annotations.displayName || "",
          sourceRole: source.sourceRole || "authored",
          categoryId: evaluated.categoryId,
          categoryCapabilities: [...evaluated.categoryCapabilities],
          classIds: [...evaluated.classIds],
          labelIds,
          labels: labelIds.map((id) => taxonomy.labels[id]?.label || id),
          box: [...(transform.box || source.box || [0, 0, 0.1, 0.1])],
          transform: {
            box: [...(transform.box || source.box || [0, 0, 0.1, 0.1])],
            translateX: transform.translateX ?? 0,
            translateY: transform.translateY ?? 0,
            scaleX: transform.scaleX ?? 1,
            scaleY: transform.scaleY ?? 1
          },
          text: { modern: content.modern || "", diplomatic: content.diplomatic || "" },
          style: typography,
          originalGlyph: source.content?.diplomatic?.trim().slice(0, 1) || "",
          decoratedInitial: decorated ? evaluated.components[DECORATED_INITIAL_COMPONENT] : null,
          decoratedPreviews: decorated ? {
            modern: rendererFor(engine, evaluatedById, regionId, "modern"),
            diplomatic: rendererFor(engine, evaluatedById, regionId, "diplomatic")
          } : null,
          provenance: { ...evaluated.provenance }
        };
      }
      pages[pageId] = {
        id: pageId,
        number: page.page,
        label: page.displayName || sourcePage.displayName || `Page ${page.page}`,
        scanPaper: bookUi.pages?.[pageId]?.paper || "#cbb198",
        appearance: effectivePageAppearance(evaluatedPage),
        appearanceSource: pageAppearanceSource(evaluatedPage),
        regionOrder,
        regions
      };
    }
    books[bookId] = {
      id: bookId,
      title: book.displayName || bookId,
      creator: bookUi.creator || "",
      year: bookUi.year || null,
      language: bookUi.language || "",
      pageOrder,
      pages
    };
  }

  return Object.freeze({
    id: document.projectId,
    title: document.displayName,
    schema: document.schema,
    revision: document.revision,
    bookOrder,
    books,
    taxonomy
  });
}

export function regionDisplayName(region) {
  return region?.displayName || region?.labels?.[0] || region?.id || "Unnamed region";
}

export function isIlluminatedRegion(_project, region) {
  return Boolean(region?.categoryCapabilities?.includes("decorated-initial"));
}

export function authoredCapitalSetting(document, scope, bookId, pageId, regionId) {
  const book = document.workspace.books[bookId];
  let owner = null;
  if (scope === "book") owner = book;
  if (scope === "page") owner = book?.pages?.[String(pageId)];
  if (scope === "region") owner = book?.pages?.[String(pageId)]?.regions?.[regionId];
  const representation = owner?.components?.[DECORATED_INITIAL_COMPONENT]?.representation;
  return representation ? { representation } : null;
}

export function authoredPageAppearance(document, scope, bookId, pageId) {
  const book = document.workspace.books[bookId];
  const owner = scope === "book" ? book : book?.pages?.[String(pageId)];
  return owner?.components?.[PAGE_APPEARANCE_COMPONENT] || null;
}

export function effectiveCapitalSetting(region) {
  const representation = region?.decoratedInitial?.representation || "auto";
  const provenance = region?.provenance?.[`${DECORATED_INITIAL_COMPONENT}.representation`] || null;
  return {
    representation,
    source: provenance?.scope || "componentDefault"
  };
}

export function capitalPreview(_project, _bookId, _pageId, region, surface, textLayer = "modern") {
  if (!isIlluminatedRegion(null, region)) {
    return {
      text: region?.text?.[surface === "scan" ? "diplomatic" : textLayer] || "",
      representation: "text"
    };
  }
  if (surface === "scan") {
    return { text: region.originalGlyph || region.text.diplomatic || "", representation: "original" };
  }
  const rendered = region.decoratedPreviews?.[textLayer] || {};
  if (rendered.representation === "hidden") return { text: "", representation: "hidden" };
  if (rendered.representation === "original") {
    return { text: region.originalGlyph || region.text.diplomatic || "", representation: "original" };
  }
  return {
    text: rendered.text || region.text[textLayer] || "",
    representation: rendered.representation || textLayer
  };
}

export function adjacentPageId(book, currentPageId, direction) {
  const currentIndex = book.pageOrder.indexOf(String(currentPageId));
  if (currentIndex < 0) return null;
  return book.pageOrder[currentIndex + direction] || null;
}

export function clampContextMenuPosition(x, y, viewportWidth, viewportHeight) {
  const menuWidth = 270;
  const menuHeight = 410;
  return {
    x: Math.max(8, Math.min(x, viewportWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(y, viewportHeight - menuHeight - 8))
  };
}
