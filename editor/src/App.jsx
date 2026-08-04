import {
  Button,
  ButtonGroup,
  Callout,
  Card,
  Checkbox,
  Collapse,
  Divider,
  FormGroup,
  HTMLSelect,
  Icon,
  InputGroup,
  Menu,
  MenuDivider,
  MenuItem,
  Navbar,
  NavbarDivider,
  NavbarGroup,
  NavbarHeading,
  NumericInput,
  Radio,
  RadioGroup,
  Tag,
  TextArea
} from "@blueprintjs/core";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  CATEGORY_ORDER,
  createDemoProject
} from "./model/demo-project.js";
import { createEditorStore, selectActiveLocation } from "./model/editor-store.js";
import {
  adjacentPageId,
  authoredCapitalSetting,
  capitalPreview,
  clampContextMenuPosition,
  effectiveCapitalSetting,
  isIlluminatedRegion,
  regionDisplayName
} from "./model/view-model.js";

const editorStore = createEditorStore({ project: createDemoProject() });
const WORKSPACES = ["Layout", "Text", "Classification", "QA", "Publish"];
const QUICK_LABELS = ["needs review", "reviewed", "decorated initial"];
const CAPITAL_MODES = [
  ["auto", "Auto"],
  ["original", "Original crop"],
  ["diplomatic", "Diplomatic text"],
  ["modern", "Modern text"],
  ["hidden", "Hidden"]
];

function useEditorSnapshot() {
  return useSyncExternalStore(editorStore.subscribe, editorStore.getSnapshot, editorStore.getSnapshot);
}

function CommitInput({ value, onCommit, ...props }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <InputGroup
      {...props}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(value ?? "");
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function CommitTextArea({ value, onCommit, ...props }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <TextArea
      {...props}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
    />
  );
}

function TopBar({ state, location, workspace, setWorkspace, dispatch }) {
  const previousPage = adjacentPageId(location.book, location.page.id, -1);
  const nextPage = adjacentPageId(location.book, location.page.id, 1);
  const pagePosition = location.book.pageOrder.indexOf(location.page.id) + 1;
  return (
    <Navbar className="editor-navbar" aria-label="Editor controls">
      <NavbarGroup className="project-group">
        <Icon icon="book" size={18} />
        <NavbarHeading>{state.view.title}</NavbarHeading>
        {state.history.canUndo && <Tag intent="warning" minimal>Modified</Tag>}
        <NavbarDivider />
        <HTMLSelect
          aria-label="Book"
          value={location.book.id}
          options={state.view.bookOrder.map((bookId) => ({
            label: state.view.books[bookId].title,
            value: bookId
          }))}
          disabled
        />
        <ButtonGroup minimal>
          <Button
            icon="chevron-left"
            aria-label="Previous page"
            disabled={!previousPage}
            onClick={() => dispatch("navigation.set-page", { pageId: previousPage })}
          />
          <Button text={`${pagePosition} / ${location.book.pageOrder.length}`} rightIcon="caret-down" aria-label={`Page ${location.page.number}; ${pagePosition} of ${location.book.pageOrder.length}`} />
          <Button
            icon="chevron-right"
            aria-label="Next page"
            disabled={!nextPage}
            onClick={() => dispatch("navigation.set-page", { pageId: nextPage })}
          />
        </ButtonGroup>
      </NavbarGroup>

      <NavbarGroup className="workspace-group">
        <ButtonGroup minimal className="workspace-tabs" aria-label="Workspace">
          {WORKSPACES.map((item) => (
            <Button
              key={item}
              text={item}
              active={workspace === item}
              onClick={() => setWorkspace(item)}
            />
          ))}
        </ButtonGroup>
      </NavbarGroup>

      <NavbarGroup align="right" className="action-group">
        <ButtonGroup minimal>
          <Button
            icon="undo"
            aria-label="Undo"
            title="Undo (Ctrl/Cmd+Z)"
            disabled={!state.history.canUndo}
            onClick={() => dispatch("history.undo")}
          />
          <Button
            icon="redo"
            aria-label="Redo"
            title="Redo (Ctrl/Cmd+Shift+Z)"
            disabled={!state.history.canRedo}
            onClick={() => dispatch("history.redo")}
          />
        </ButtonGroup>
        <NavbarDivider />
        <Button icon="eye-open" text="Reader preview" minimal />
        <Tag icon="tick-circle" intent="success" minimal>Demo valid</Tag>
        <Button icon="cloud-upload" text="Publish" intent="primary" disabled title="Publication service is not connected in this vertical slice." />
      </NavbarGroup>
    </Navbar>
  );
}

function ToolRail({ state, dispatch }) {
  const tools = [
    ["select", "selection", "Select"],
    ["move", "move", "Move"],
    ["resize", "widget", "Resize"]
  ];
  return (
    <div className="tool-rail" aria-label="Viewport tools">
      {tools.map(([tool, icon, label]) => (
        <Button
          key={tool}
          icon={icon}
          aria-label={label}
          title={label}
          active={state.context.activeToolId === tool}
          onClick={() => dispatch("context.set-tool", { tool })}
        />
      ))}
      <Divider />
      <Button
        icon="edit"
        aria-label="Text edit mode"
        title="Text edit mode"
        active={state.context.mode === "TEXT"}
        onClick={() => dispatch("context.set-mode", {
          mode: state.context.mode === "TEXT" ? "OBJECT" : "TEXT"
        })}
      />
    </div>
  );
}

function Outliner({ state, location, dispatch }) {
  const allRegions = location.page.regionOrder.map((id) => location.page.regions[id]);
  return (
    <aside className="outliner panel" aria-labelledby="outliner-heading">
      <div className="panel-title-row">
        <h2 id="outliner-heading">Outliner</h2>
        <Button icon="filter" minimal small aria-label="Filter outliner" />
      </div>
      <InputGroup leftIcon="search" placeholder="Search objects" aria-label="Search objects" />
      <div className="tree" role="tree" aria-label="Project hierarchy">
        <div className="tree-row depth-0" role="treeitem" aria-expanded="true">
          <Icon icon="folder-open" /> <span>{state.view.title}</span>
        </div>
        <div className="tree-row depth-1" role="treeitem" aria-expanded="true">
          <Icon icon="book" /> <span>{location.book.title}</span>
        </div>
        {location.book.pageOrder.map((pageId) => {
          const page = location.book.pages[pageId];
          const isPageActive = pageId === location.page.id;
          return (
            <div key={pageId} role="group" aria-label={`Page ${page.number}`}>
              <button
                type="button"
                className={`tree-row depth-2 ${isPageActive ? "is-active-page" : ""}`}
                role="treeitem"
                aria-expanded={isPageActive}
                onClick={() => dispatch("navigation.set-page", { pageId })}
              >
                <Icon icon="document" /> <span>Page {page.number}</span>
                <span className="tree-meta">{page.regionOrder.length}</span>
              </button>
              {isPageActive && allRegions.map((region) => {
                const active = region.id === state.context.activeRegionId;
                return (
                  <button
                    type="button"
                    key={region.id}
                    className={`tree-row depth-3 region-tree-row ${active ? "is-active" : ""}`}
                    role="treeitem"
                    aria-selected={active}
                    onClick={() => dispatch("region.select", { regionId: region.id })}
                  >
                    <span className={`object-dot role-${region.sourceRole}`} />
                    <span className="tree-main">
                      <span>{regionDisplayName(region)}</span>
                      <span className="tree-subtitle">{region.id}</span>
                    </span>
                    {region.labels.includes("needs review") && <Icon icon="warning-sign" intent="warning" />}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="outliner-collections">
        <div className="section-kicker">Collections</div>
        <button type="button" className="collection-row"><Icon icon="folder-close" /> Needs review</button>
        <button type="button" className="collection-row"><Icon icon="folder-close" /> Decorated initials</button>
      </div>
    </aside>
  );
}

function regionPosition(region) {
  const [left, top, right, bottom] = region.box;
  return {
    left: `${left * 100}%`,
    top: `${top * 100}%`,
    width: `${(right - left) * 100}%`,
    height: `${(bottom - top) * 100}%`
  };
}

function PageSurface({ surface, state, location, onOpenMenu, dispatch }) {
  const { book, page } = location;
  return (
    <section className="page-column" aria-label={surface === "scan" ? "Original scan" : "Facsimile preview"}>
      <div className="surface-label">
        <span>{surface === "scan" ? "Original scan" : "Facsimile"}</span>
        <Tag minimal>{surface === "scan" ? "source" : state.context.activeEdition}</Tag>
      </div>
      <div className={`page-sheet ${surface}`} style={{ "--paper": page.paper }}>
        <div className="paper-grain" aria-hidden="true" />
        <div className="botanical-ghost" aria-hidden="true">
          <span className="stem" /><span className="leaf leaf-one" /><span className="leaf leaf-two" />
          <span className="leaf leaf-three" /><span className="flower">✣</span>
        </div>
        {page.regionOrder.map((regionId) => {
          const region = page.regions[regionId];
          const active = state.context.activeRegionId === regionId;
          const preview = capitalPreview(state.view, book.id, page.id, region, surface, state.context.activeEdition);
          const className = [
            "page-region",
            `role-${region.sourceRole}`,
            active ? "is-active" : "",
            preview.representation === "original" ? "is-original-capital" : "",
            preview.representation === "hidden" ? "is-hidden-representation" : ""
          ].filter(Boolean).join(" ");
          return (
            <button
              type="button"
              key={regionId}
              className={className}
              style={{
                ...regionPosition(region),
                "--region-color": region.style.color,
                "--region-weight": region.style.fontWeight,
                "--region-leading": region.style.lineHeight,
                "--region-tracking": `${region.style.letterSpacing}em`,
                "--region-scale": region.style.fontSize
              }}
              aria-label={`${regionDisplayName(region)}, ${region.categoryId}`}
              aria-pressed={active}
              onClick={() => dispatch("region.select", { regionId })}
              onContextMenu={(event) => onOpenMenu(event, regionId)}
              onKeyDown={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                  onOpenMenu(event, regionId, true);
                }
              }}
            >
              <span className="region-content">{preview.text || (surface === "facsimile" ? "Hidden" : "")}</span>
              {active && <span className="resize-corner" aria-hidden="true" />}
            </button>
          );
        })}
        <span className="folio-number" aria-hidden="true">{page.number}</span>
      </div>
    </section>
  );
}

function Viewport({ state, location, dispatch, onOpenMenu }) {
  return (
    <main className="viewport-panel" aria-label="Adjacent page comparison">
      <div className="viewport-toolbar">
        <ButtonGroup minimal>
          <Button icon="horizontal-distribution" text="Side by side" active />
          <Button icon="zoom-in" aria-label="Zoom in" />
          <Button icon="zoom-out" aria-label="Zoom out" />
          <Button icon="maximize" text="Frame selected" />
        </ButtonGroup>
        <ButtonGroup minimal>
          <Button icon="widget" text="Regions" active />
          <Button icon="flow-linear" text="Reading order" />
        </ButtonGroup>
        <div className="edition-switch">
          <span>Edition</span>
          <HTMLSelect
            minimal
            aria-label="Facsimile text edition"
            value={state.context.activeEdition}
            onChange={(event) => dispatch("context.set-text-layer", { layer: event.target.value })}
            options={[
              { label: "Modern", value: "modern" },
              { label: "Diplomatic", value: "diplomatic" }
            ]}
          />
        </div>
      </div>
      <ToolRail state={state} dispatch={dispatch} />
      <div className="page-stage">
        <div className="page-pair">
          <PageSurface surface="scan" state={state} location={location} dispatch={dispatch} onOpenMenu={onOpenMenu} />
          <PageSurface surface="facsimile" state={state} location={location} dispatch={dispatch} onOpenMenu={onOpenMenu} />
        </div>
      </div>
    </main>
  );
}

function PropertySection({ title, icon, children, defaultOpen = true, secondary = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`property-section ${secondary ? "is-secondary" : ""}`}>
      <button type="button" className="property-section-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Icon icon={open ? "caret-down" : "caret-right"} />
        <Icon icon={icon} />
        <span>{title}</span>
        {secondary && <Tag minimal round>secondary</Tag>}
      </button>
      <Collapse isOpen={open}>
        <div className="property-section-body">{children}</div>
      </Collapse>
    </section>
  );
}

function LabelEditor({ region, taxonomy, dispatch }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    if (dispatch("region.add-label", { label: draft })) setDraft("");
  };
  return (
    <div className="label-editor">
      <div className="tag-list">
        {region.labelIds.map((labelId) => (
          <Tag key={labelId} interactive onRemove={() => dispatch("region.remove-label", { labelId })}>
            {taxonomy.labels[labelId]?.label || labelId}
          </Tag>
        ))}
      </div>
      <InputGroup
        value={draft}
        placeholder="Add custom label"
        aria-label="New custom label"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add();
          }
        }}
        rightElement={<Button icon="plus" minimal aria-label="Add label" onClick={add} />}
      />
    </div>
  );
}

function ClassificationProperties({ state, region, dispatch }) {
  const [customClass, setCustomClass] = useState("");
  const classes = Object.values(state.view.taxonomy.classes).sort((a, b) => a.label.localeCompare(b.label));
  const createClass = () => {
    if (dispatch("region.create-class", { label: customClass })) setCustomClass("");
  };
  return (
    <>
      <FormGroup label="Source role" helperText="Immutable OCR classification">
        <InputGroup value={region.sourceRole} readOnly leftIcon="lock" />
      </FormGroup>
      <FormGroup label="Category" labelFor="region-category">
        <HTMLSelect
          id="region-category"
          fill
          value={region.categoryId}
          onChange={(event) => dispatch("region.assign-category", { categoryId: event.target.value })}
        >
          {CATEGORY_ORDER.map((id) => <option key={id} value={id}>{state.view.taxonomy.categories[id].label}</option>)}
        </HTMLSelect>
      </FormGroup>
      <FormGroup label="Classes">
        <div className="checkbox-stack">
          {classes.map((definition) => (
            <Checkbox
              key={definition.id}
              label={definition.label}
              checked={region.classIds.includes(definition.id)}
              onChange={() => dispatch("region.toggle-class", { classId: definition.id })}
            />
          ))}
        </div>
        <InputGroup
          value={customClass}
          placeholder="Create project class"
          aria-label="New custom class"
          onChange={(event) => setCustomClass(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              createClass();
            }
          }}
          rightElement={<Button icon="plus" minimal aria-label="Create and assign class" onClick={createClass} />}
        />
      </FormGroup>
      <FormGroup label="Labels">
        <LabelEditor region={region} taxonomy={state.view.taxonomy} dispatch={dispatch} />
      </FormGroup>
    </>
  );
}

function CapitalProperties({ state, location, region, dispatch }) {
  const scope = ["book", "page", "region"].includes(state.context.activeScope.kind)
    ? state.context.activeScope.kind
    : "region";
  const resolved = effectiveCapitalSetting(region);
  const authored = authoredCapitalSetting(
    state.project,
    scope,
    location.book.id,
    location.page.id,
    region.id
  );
  return (
    <>
      <Callout icon="info-sign" compact>
        Optional source-backed handling for a decorated initial. It does not repaint the original.
      </Callout>
      <FormGroup label="Apply render setting to">
        <HTMLSelect
          fill
          aria-label="Decorated-initial render scope"
          value={scope}
          onChange={(event) => dispatch("context.set-render-scope", { scope: event.target.value })}
          options={[
            { label: `Book · ${location.book.title}`, value: "book" },
            { label: `Page · ${location.page.number}`, value: "page" },
            { label: `Region · ${regionDisplayName(region)}`, value: "region" }
          ]}
        />
      </FormGroup>
      <div className="inheritance-line">
        <span>Effective</span>
        <Tag intent="primary" minimal>{CAPITAL_MODES.find(([id]) => id === resolved.representation)?.[1] || resolved.representation}</Tag>
        <span>from {resolved.source}</span>
      </div>
      <RadioGroup
        label="Representation"
        selectedValue={authored?.representation || resolved.representation}
        onChange={(event) => dispatch("render.set-illuminated-capital", {
          scope,
          mode: event.currentTarget.value
        })}
      >
        {CAPITAL_MODES.map(([value, label]) => <Radio key={value} value={value} label={label} />)}
      </RadioGroup>
      <Button
        icon="reset"
        text="Reset to inherited"
        minimal
        disabled={!authored}
        onClick={() => dispatch("render.clear-illuminated-capital", { scope })}
      />
      <Divider />
      <FormGroup label="Diplomatic equivalent">
        <CommitInput
          value={region.text.diplomatic}
          onCommit={(value) => dispatch("region.update-text", { layer: "diplomatic", value })}
        />
      </FormGroup>
      <FormGroup label="Modern equivalent">
        <CommitInput
          value={region.text.modern}
          onCommit={(value) => dispatch("region.update-text", { layer: "modern", value })}
        />
      </FormGroup>
      <div className="source-crop-preview" aria-label="Untouched original crop preview">
        <span>{region.originalGlyph || region.text.diplomatic}</span>
        <small>Original source crop · contain · multiply</small>
      </div>
    </>
  );
}

function PropertiesPanel({ state, location, dispatch, headingRef }) {
  const region = location.region;
  if (!region) return <aside className="properties panel"><Callout>Select a region to edit its properties.</Callout></aside>;
  const illuminated = isIlluminatedRegion(state.view, region);
  return (
    <aside className="properties panel" aria-labelledby="region-properties-heading">
      <div className="panel-title-row sticky">
        <div>
          <div className="section-kicker">Active object</div>
          <h2 id="region-properties-heading" ref={headingRef} tabIndex="-1">Properties</h2>
        </div>
        <Button icon="more" minimal aria-label="More property actions" />
      </div>
      <div className="properties-scroll">
        <PropertySection title="Object" icon="cube">
          <FormGroup label="Display name" helperText={region.id}>
            <CommitInput
              value={region.displayName || ""}
              onCommit={(value) => dispatch("region.set-display-name", { value })}
            />
          </FormGroup>
        </PropertySection>

        <PropertySection title="Classification" icon="tag">
          <ClassificationProperties state={state} region={region} dispatch={dispatch} />
        </PropertySection>

        <PropertySection title="Content" icon="paragraph" defaultOpen={state.context.mode === "TEXT"}>
          <FormGroup label="Diplomatic text">
            <CommitTextArea
              fill
              rows={3}
              value={region.text.diplomatic}
              onCommit={(value) => dispatch("region.update-text", { layer: "diplomatic", value })}
            />
          </FormGroup>
          <FormGroup label="Modern text">
            <CommitTextArea
              fill
              rows={3}
              value={region.text.modern}
              onCommit={(value) => dispatch("region.update-text", { layer: "modern", value })}
            />
          </FormGroup>
        </PropertySection>

        <PropertySection title="Typography" icon="font">
          <FormGroup label="Typeface">
            <HTMLSelect
              fill
              aria-label="Region typeface"
              value={region.style.fontFamily}
              onChange={(event) => dispatch("region.update-style", { property: "fontFamily", value: event.target.value })}
              options={[
                { label: "Edition serif", value: "edition" },
                { label: "Georgia", value: "georgia" },
                { label: "Palatino", value: "palatino" },
                { label: "System sans", value: "sans" }
              ]}
            />
          </FormGroup>
          <div className="two-column-fields">
            <FormGroup label="Size">
              <NumericInput
                fill
                min={0.5}
                max={4}
                stepSize={0.05}
                minorStepSize={0.01}
                majorStepSize={0.5}
                value={region.style.fontSize}
                onValueChange={(value) => Number.isFinite(value) && dispatch("region.update-style", { property: "fontSize", value })}
              />
            </FormGroup>
            <FormGroup label="Weight">
              <NumericInput
                fill
                min={100}
                max={900}
                stepSize={50}
                minorStepSize={10}
                majorStepSize={100}
                value={region.style.fontWeight}
                onValueChange={(value) => Number.isFinite(value) && dispatch("region.update-style", { property: "fontWeight", value })}
              />
            </FormGroup>
            <FormGroup label="Line height">
              <NumericInput
                fill
                min={0.5}
                max={4}
                stepSize={0.05}
                minorStepSize={0.01}
                majorStepSize={0.5}
                value={region.style.lineHeight}
                onValueChange={(value) => Number.isFinite(value) && dispatch("region.update-style", { property: "lineHeight", value })}
              />
            </FormGroup>
            <FormGroup label="Tracking">
              <NumericInput
                fill
                min={-0.25}
                max={1}
                stepSize={0.01}
                minorStepSize={0.005}
                majorStepSize={0.1}
                value={region.style.letterSpacing}
                onValueChange={(value) => Number.isFinite(value) && dispatch("region.update-style", { property: "letterSpacing", value })}
              />
            </FormGroup>
          </div>
          <FormGroup label="Text color">
            <InputGroup
              type="color"
              value={region.style.color}
              onChange={(event) => dispatch("region.update-style", { property: "color", value: event.target.value })}
            />
          </FormGroup>
        </PropertySection>

        <PropertySection title="Transform" icon="widget">
          <div className="coordinate-grid">
            {region.box.map((value, index) => {
              const labels = ["Left", "Top", "Right", "Bottom"];
              return (
                <FormGroup key={labels[index]} label={labels[index]}>
                  <NumericInput
                    fill
                    min={0}
                    max={1}
                    stepSize={0.005}
                    minorStepSize={0.001}
                    value={value}
                    onValueChange={(nextValue) => {
                      if (!Number.isFinite(nextValue)) return;
                      const box = [...region.box];
                      box[index] = nextValue;
                      dispatch("region.update-box", { box });
                    }}
                  />
                </FormGroup>
              );
            })}
          </div>
        </PropertySection>

        {illuminated && (
          <PropertySection title="Decorated initial rendering" icon="style" defaultOpen={false} secondary>
            <CapitalProperties state={state} location={location} region={region} dispatch={dispatch} />
          </PropertySection>
        )}

        <PropertySection title="Source & QA" icon="issue" defaultOpen={false}>
          <div className="qa-row"><span>OCR confidence</span><Tag intent="success">0.94</Tag></div>
          <div className="qa-row"><span>Source fingerprint</span><Tag minimal>verified</Tag></div>
        </PropertySection>
      </div>
    </aside>
  );
}

function RegionContextMenu({ menu, state, location, dispatch, onClose, onViewProperties, menuRef }) {
  const region = location.region;
  if (!menu || !region) return null;
  const classes = Object.values(state.view.taxonomy.classes).sort((a, b) => a.label.localeCompare(b.label));
  const illuminated = isIlluminatedRegion(state.view, region);
  const invoke = (operatorId, payload) => {
    dispatch(operatorId, payload);
    onClose(false);
  };
  return (
    <div
      ref={menuRef}
      className="region-menu-layer"
      style={{ left: menu.x, top: menu.y }}
      aria-label={`Actions for ${regionDisplayName(region)}`}
    >
      <Menu>
        <MenuItem icon="tag" text="Assign category">
          {CATEGORY_ORDER.map((categoryId) => {
            const category = state.view.taxonomy.categories[categoryId];
            return (
              <MenuItem
                key={categoryId}
                icon={region.categoryId === categoryId ? "tick" : undefined}
                text={category.label}
                onClick={() => invoke("region.assign-category", { categoryId })}
              />
            );
          })}
        </MenuItem>
        <MenuItem icon="many-to-many" text="Classes">
          {classes.map((definition) => (
            <MenuItem
              key={definition.id}
              icon={region.classIds.includes(definition.id) ? "tick" : undefined}
              text={definition.label}
              onClick={() => invoke("region.toggle-class", { classId: definition.id })}
            />
          ))}
        </MenuItem>
        <MenuItem icon="label" text="Labels">
          {QUICK_LABELS.map((label) => (
            <MenuItem
              key={label}
              icon={region.labels.includes(label) ? "tick" : undefined}
              text={label}
              onClick={() => invoke(
                region.labels.includes(label) ? "region.remove-label" : "region.add-label",
                { label }
              )}
            />
          ))}
          <MenuDivider />
          <MenuItem icon="properties" text="Edit custom labels in Properties" onClick={onViewProperties} />
        </MenuItem>
        <MenuItem icon="edit" text="Set display name…" onClick={onViewProperties} />
        {illuminated && (
          <>
            <MenuDivider />
            <MenuItem icon="style" text="Capital rendering">
              {CAPITAL_MODES.map(([mode, label]) => (
                <MenuItem
                  key={mode}
                  icon={effectiveCapitalSetting(region).representation === mode ? "tick" : undefined}
                  text={label}
                  onClick={() => invoke("render.set-illuminated-capital", { scope: "region", mode })}
                />
              ))}
            </MenuItem>
          </>
        )}
        <MenuDivider />
        <MenuItem icon="properties" text="View properties" label="Shift+F10" onClick={onViewProperties} />
        <MenuItem icon="locate" text="Reveal in Outliner" onClick={() => onClose(true)} />
        <MenuItem icon="maximize" text="Frame selected" onClick={() => onClose(true)} />
      </Menu>
    </div>
  );
}

function StatusBar({ state, location, appInfo }) {
  const region = location.region;
  return (
    <footer className="status-bar">
      <span><Icon icon="small-tick" intent="success" /> {state.status.message}</span>
      <span className="status-spacer" />
      <span>{region ? regionDisplayName(region) : "No active region"}</span>
      <span>{state.context.selectedRegionIds.length} selected</span>
      {region && <span>xywh {region.box.map((value) => value.toFixed(3)).join(" · ")}</span>}
      <span>revision {state.revision}</span>
      <span>{appInfo ? `${appInfo.name} ${appInfo.version}` : "renderer preview"}</span>
    </footer>
  );
}

export default function App() {
  const state = useEditorSnapshot();
  const location = selectActiveLocation(state);
  const [workspace, setWorkspace] = useState("Classification");
  const [contextMenu, setContextMenu] = useState(null);
  const [appInfo, setAppInfo] = useState(null);
  const menuRef = useRef(null);
  const propertiesHeadingRef = useRef(null);
  const returnFocusRef = useRef(null);
  const dispatch = useCallback((operatorId, payload) => editorStore.dispatch(operatorId, payload), []);

  useEffect(() => {
    let active = true;
    if (window.whlDesktop?.getAppInfo) {
      window.whlDesktop.getAppInfo().then((value) => active && setAppInfo(value)).catch(() => {});
    }
    return () => { active = false; };
  }, []);

  const closeContextMenu = useCallback((restoreFocus = true) => {
    setContextMenu(null);
    if (restoreFocus) requestAnimationFrame(() => returnFocusRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!contextMenu) return undefined;
    requestAnimationFrame(() => menuRef.current?.querySelector("[role='menuitem']")?.focus());
    const onPointerDown = (event) => {
      if (event.target.closest?.(".bp6-menu")) return;
      closeContextMenu(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeContextMenu(true);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [contextMenu, closeContextMenu]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      const ownsTextUndo = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target?.isContentEditable;
      if (ownsTextUndo || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        dispatch(event.shiftKey ? "history.redo" : "history.undo");
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        dispatch("history.redo");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch]);

  const openContextMenu = useCallback((event, regionId, keyboard = false) => {
    event.preventDefault();
    event.stopPropagation();
    dispatch("region.select", { regionId });
    returnFocusRef.current = event.currentTarget;
    const bounds = event.currentTarget.getBoundingClientRect();
    const rawX = keyboard ? bounds.left + Math.min(bounds.width, 32) : event.clientX;
    const rawY = keyboard ? bounds.top + Math.min(bounds.height, 32) : event.clientY;
    const position = clampContextMenuPosition(rawX, rawY, window.innerWidth, window.innerHeight);
    setContextMenu({ ...position, regionId });
  }, [dispatch]);

  const viewProperties = useCallback(() => {
    dispatch("context.view-properties", { panel: "region" });
    setContextMenu(null);
    requestAnimationFrame(() => propertiesHeadingRef.current?.focus());
  }, [dispatch]);

  if (!location.book || !location.page) {
    return <Callout intent="danger" title="Project cannot be displayed">The active book or page is missing.</Callout>;
  }

  return (
    <div className="editor-app bp6-dark">
      <TopBar
        state={state}
        location={location}
        workspace={workspace}
        setWorkspace={setWorkspace}
        dispatch={dispatch}
      />
      <div className="editor-body">
        <Outliner state={state} location={location} dispatch={dispatch} />
        <Viewport state={state} location={location} dispatch={dispatch} onOpenMenu={openContextMenu} />
        <PropertiesPanel state={state} location={location} dispatch={dispatch} headingRef={propertiesHeadingRef} />
      </div>
      <StatusBar state={state} location={location} appInfo={appInfo} />
      <RegionContextMenu
        menu={contextMenu}
        state={state}
        location={location}
        dispatch={dispatch}
        onClose={closeContextMenu}
        onViewProperties={viewProperties}
        menuRef={menuRef}
      />
      <div className="sr-only" aria-live="polite">{state.status.message}</div>
    </div>
  );
}
