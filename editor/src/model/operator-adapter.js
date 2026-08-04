import { DECORATED_INITIAL_COMPONENT } from "@whl/facsimile-engine";

function cleanLabel(value, maximum = 120) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized && normalized.length <= maximum ? normalized : null;
}

function idFromLabel(label, table, prefix = "custom") {
  const stem = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54) || "item";
  let id = `${prefix}.${stem}`;
  let suffix = 2;
  while (table[id] && table[id].displayName !== label) {
    id = `${prefix}.${stem}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function scopeFromName(context, scopeName) {
  if (scopeName === "book") return { kind: "book" };
  if (scopeName === "page") return { kind: "page" };
  return { kind: "region", regionId: context.activeRegionId };
}

function scopeName(context) {
  return ["book", "page", "region"].includes(context.activeScope.kind)
    ? context.activeScope.kind
    : "region";
}

function changed(result) {
  return Boolean(result && result.changed);
}

function status(message, tone = "neutral") {
  return { message, tone };
}

/**
 * Translates renderer intents to the shared operator/context API. It never
 * clones, edits, or replaces canonical project blocks itself.
 */
export function createEngineOperatorAdapter(engine) {
  function executeEngine(operatorId, context, args, message) {
    const result = engine.operators.execute(operatorId, context, args);
    return { changed: changed(result), context, status: status(message) };
  }

  return Object.freeze({
    id: "facsimile-engine-operators",
    execute(actionId, context, payload = {}) {
      try {
        switch (actionId) {
          case "history.undo": {
            const result = engine.history.undo();
            return { changed: changed(result), context, status: status(result ? "Undid the last authored change." : "Nothing to undo.") };
          }
          case "history.redo": {
            const result = engine.history.redo();
            return { changed: changed(result), context, status: status(result ? "Redid the authored change." : "Nothing to redo.") };
          }
          case "region.select": {
            const nextContext = engine.context.activateRegion(context, payload.regionId);
            return { changed: nextContext !== context, context: nextContext, status: status(`Selected ${payload.regionId}.`) };
          }
          case "navigation.set-page": {
            const page = engine.project.books[context.bookId]?.pages[String(payload.pageId)];
            if (!page) return { changed: false, context, status: status("That page is unavailable.", "danger") };
            const firstRegionId = Object.keys(page.regions)[0] || null;
            const nextContext = engine.context.derive(context, {
              page: Number(payload.pageId),
              activeRegionId: firstRegionId,
              selectedRegionIds: firstRegionId ? [firstRegionId] : [],
              activeScope: firstRegionId ? { kind: "region", regionId: firstRegionId } : { kind: "page" }
            });
            return { changed: true, context: nextContext, status: status(`Opened page ${payload.pageId}.`) };
          }
          case "context.set-mode": {
            if (!["OBJECT", "TRANSFORM", "TEXT"].includes(payload.mode)) return { changed: false, context, status: status("Unsupported editor mode.", "danger") };
            const nextContext = engine.context.derive(context, { mode: payload.mode });
            return { changed: true, context: nextContext, status: status(`Mode: ${payload.mode}.`) };
          }
          case "context.set-tool": {
            if (!["select", "move", "resize"].includes(payload.tool)) return { changed: false, context, status: status("Unsupported tool.", "danger") };
            const nextContext = engine.context.derive(context, {
              activeToolId: payload.tool,
              mode: payload.tool === "select" ? "OBJECT" : "TRANSFORM"
            });
            return { changed: true, context: nextContext, status: status(`Tool: ${payload.tool}.`) };
          }
          case "context.view-properties": {
            const nextContext = engine.context.derive(context, { area: "properties" });
            return { changed: true, context: nextContext, status: status("Region properties opened.") };
          }
          case "context.set-render-scope": {
            if (!["book", "page", "region"].includes(payload.scope)) return { changed: false, context, status: status("Unsupported render scope.", "danger") };
            const nextContext = engine.context.derive(context, { activeScope: scopeFromName(context, payload.scope) });
            return { changed: true, context: nextContext, status: status(`Render scope: ${payload.scope}.`) };
          }
          case "context.set-text-layer": {
            if (!["modern", "diplomatic"].includes(payload.layer)) return { changed: false, context, status: status("Unsupported text edition.", "danger") };
            const nextContext = engine.context.derive(context, { activeEdition: payload.layer });
            return { changed: true, context: nextContext, status: status(`Text edition: ${payload.layer}.`) };
          }
          case "region.set-display-name":
            return executeEngine("region.setDisplayName", context, {
              displayName: payload.displayName ?? payload.value
            }, "Updated the region display name.");
          case "region.assign-category": {
            const definition = engine.project.taxonomy.categories[payload.categoryId];
            return executeEngine("region.assignCategory", context, { categoryId: payload.categoryId }, `Category assigned: ${definition?.displayName || payload.categoryId}.`);
          }
          case "region.toggle-class": {
            const active = engine.evaluateRegion(context.bookId, context.page, context.activeRegionId);
            const remove = active.classIds.includes(payload.classId);
            const operatorId = remove ? "region.removeClass" : "region.addClass";
            const definition = engine.project.taxonomy.classes[payload.classId];
            return executeEngine(operatorId, context, { classId: payload.classId }, `${remove ? "Removed" : "Added"} ${definition?.displayName || payload.classId}.`);
          }
          case "region.add-label": {
            const label = cleanLabel(payload.label);
            if (!label) return { changed: false, context, status: status("Enter a label first.", "danger") };
            const taxonomy = engine.project.taxonomy.labels;
            const existing = Object.values(taxonomy).find((item) => item.displayName.toLowerCase() === label.toLowerCase());
            const labelId = existing?.id || idFromLabel(label, taxonomy, "label");
            let anyChange = false;
            if (!existing) {
              anyChange = changed(engine.operators.execute("taxonomy.createLabel", context, { id: labelId, displayName: label })) || anyChange;
            }
            anyChange = changed(engine.operators.execute("region.addLabel", context, { labelId })) || anyChange;
            return { changed: anyChange, context, status: status(`Added label: ${label}.`) };
          }
          case "region.remove-label": {
            const labelId = payload.labelId || Object.values(engine.project.taxonomy.labels)
              .find((item) => item.displayName === payload.label)?.id;
            if (!labelId) return { changed: false, context, status: status("Label is unavailable.", "danger") };
            return executeEngine("region.removeLabel", context, { labelId }, `Removed label: ${engine.project.taxonomy.labels[labelId]?.displayName || labelId}.`);
          }
          case "region.create-class": {
            const label = cleanLabel(payload.label);
            if (!label) return { changed: false, context, status: status("Enter a class name first.", "danger") };
            const taxonomy = engine.project.taxonomy.classes;
            const existing = Object.values(taxonomy).find((item) => item.displayName.toLowerCase() === label.toLowerCase());
            const classId = existing?.id || idFromLabel(label, taxonomy, "custom");
            let anyChange = false;
            if (!existing) {
              anyChange = changed(engine.operators.execute("taxonomy.createClass", context, {
                id: classId,
                displayName: label,
                description: "Project-defined region class.",
                priority: 0,
                components: {}
              })) || anyChange;
            }
            const active = engine.evaluateRegion(context.bookId, context.page, context.activeRegionId);
            if (!active.classIds.includes(classId)) {
              anyChange = changed(engine.operators.execute("region.addClass", context, { classId })) || anyChange;
            }
            return { changed: anyChange, context, status: status(`Created and assigned class: ${label}.`) };
          }
          case "region.update-style":
            return executeEngine("property.set", context, {
              componentId: "core.typography",
              path: [payload.property],
              value: payload.value,
              scope: { kind: "region", regionId: context.activeRegionId }
            }, `Updated ${payload.property}.`);
          case "region.update-box":
            return executeEngine("region.transform", context, { transform: { box: payload.box } }, "Updated region bounds.");
          case "region.update-text": {
            const regionContext = engine.context.derive(context, {
              activeScope: { kind: "region", regionId: context.activeRegionId }
            });
            const result = engine.operators.execute("content.setText", regionContext, {
              edition: payload.layer,
              text: payload.value
            });
            return { changed: changed(result), context, status: status(`Updated ${payload.layer} text.`) };
          }
          case "render.set-illuminated-capital": {
            const scope = payload.scope || scopeName(context);
            return executeEngine("render.setRepresentation", context, {
              representation: payload.mode,
              scope: scopeFromName(context, scope)
            }, `Decorated initials use ${payload.mode} at ${scope} scope.`);
          }
          case "render.clear-illuminated-capital": {
            const scope = payload.scope || scopeName(context);
            return executeEngine("property.reset", context, {
              componentId: DECORATED_INITIAL_COMPONENT,
              path: ["representation"],
              scope: scopeFromName(context, scope)
            }, `Cleared the ${scope} decorated-initial override.`);
          }
          default: {
            if (!engine.operatorRegistry.has(actionId)) {
              return { changed: false, context, status: status(`Unknown action: ${actionId}.`, "danger") };
            }
            return executeEngine(actionId, context, payload, `Executed ${actionId}.`);
          }
        }
      } catch (error) {
        return { changed: false, context, status: status(error.message, "danger"), error };
      }
    }
  });
}
