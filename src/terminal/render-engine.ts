import {
    beginSynchronizedOutput,
    endSynchronizedOutput,
    disableAutoWrap,
    enableAutoWrap,
    setScrollRegion,
    resetScrollRegion,
    moveCursor,
    clearToEndOfLine,
} from "./escape.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
    sanitizeLine,
} from "../compositor/text.js";

import { resolveSidebarLayout } from "../compositor/layout.js";
import { buildFixedClusterPaint } from "../compositor/frame.js";
import { readColumns, readRows } from "../pi/dimensions.js";
import type { FixedEditorClusterRender } from "../compositor/cluster.js";
import { CollapseController } from "../collapse/collapse-controller.js";
import {
    isAssistantComponent,
    isToolComponent,
} from "../collapse/types.js";
import { ChildRenderCache } from "./render-cache.js";
import type { ComponentRangeMapper } from "./range-mapper.js";
import type { SelectionManager } from "./selection-manager.js";
import type {
    PatchedRenderable,
    RenderPassCluster,
    RenderPatch,
    RootComponentLineRange,
} from "./types.js";
import type { TuiInternals, TerminalInternals } from "../pi/internals.js";
import type { Terminal } from "@earendil-works/pi-tui";
import type { SidebarOptions } from "./types.js";
import {
    captureRootViewportAnchor,
    offsetForRootViewportAnchor,
    type RootViewportAnchor,
} from "./viewport-anchor.js";
import { composeOverlayFrameLine } from "./overlay-frame.js";

const RANGE_MAP_OVERSCAN_LINES = 10;

// ── RenderEngine ─────────────────────────────────────────────

/**
 * Owns the rendering pipeline: refresh root window, update visible window,
 * render scrollable root, repaint viewport, overlay frame, sidebar paint,
 * cluster decoration, and patch management.
 */
export class RenderEngine {
    private readonly tui: TuiInternals;
    private readonly terminal: Terminal & TerminalInternals;
    private readonly originalWrite: (data: string) => void;
    private readonly renderCluster: (
        width: number,
        terminalRows: number,
    ) => FixedEditorClusterRender;
    private readonly getShowHardwareCursor: () => boolean;
    private readonly sidebar: SidebarOptions | undefined;
    private readonly rowsDescriptor: PropertyDescriptor | undefined;
    private readonly columnsDescriptor: PropertyDescriptor | undefined;
    private readonly originalRender: ((width: number) => string[]) | null;
    private readonly originalDoRender: (() => void) | null;
    private readonly collapseState: CollapseController;
    private readonly rangeMapper: ComponentRangeMapper;
    private readonly selectionManager: SelectionManager;
    private readonly getMouseReportingGuard: () => string;
    private readonly childRenderCache = new ChildRenderCache();

    private patchedRenders: RenderPatch[] = [];
    private renderPassActive = false;
    private renderPassCluster: RenderPassCluster | null = null;
    /** Monotonically increasing; cache hit in getCluster() only when generations match. */
    private clusterGeneration = 0;
    private renderingCluster = false;
    private renderingScrollableRoot = false;
    private checkingOverlay = false;
    /**
     * Index in `tui.children` where the fixed-cluster region begins.
     * Children at or above this index are part of the cluster (editor, above/below
     * widgets, footer) and are excluded from root rendering.  Using an index
     * boundary instead of per-instance hideRenderable patching means that
     * dynamically replaced children (e.g. pi-input-revamp&#39;s setFooter which
     * removes the old footer and appends a new one) are automatically excluded
     * from the root without needing to re-patch new instances.
     */
    private clusterStartIndex: number = Infinity;
    private scrollOffset = 0;
    private maxScrollOffset = 0;
    private lastRootLineCount = 0;
    private rootLines: string[] = [];
    /** Root-child line ranges from the latest successful root render. */
    private rootComponentLineRanges: RootComponentLineRange[] = [];
    private rootComponentRangesTrusted = false;
    private visibleRootStart = 0;
    private visibleScrollableRows = 0;
    private visibleRootLines: string[] = [];
    private visibleClusterLines: string[] = [];
    /** Components that changed in the most recent refreshRootWindow call. */
    private lastChangedComponents: Set<object> = new Set();

    /**
     * Set by the controller when transitioning from overlay\xe2\x86\x92non-overlay.
     * When true, write() skips the cluster+sidebar repaint because they
     * are already correct on screen from the last paintFullFrame.
     * Avoids a visible clear+redraw flicker in the input bar area during
     * quick overlay transitions (e.g. compositor settings toggle).
     */
    overlayTransitionRepaintPending = false;

    constructor(params: {
        tui: TuiInternals;
        terminal: Terminal & TerminalInternals;
        originalWrite: (data: string) => void;
        renderCluster: (
            width: number,
            terminalRows: number,
        ) => FixedEditorClusterRender;
        getShowHardwareCursor: () => boolean;
        sidebar: SidebarOptions | undefined;
        rowsDescriptor: PropertyDescriptor | undefined;
        columnsDescriptor: PropertyDescriptor | undefined;
        originalRender: ((width: number) => string[]) | null;
        originalDoRender: (() => void) | null;
        collapseState: CollapseController;
        rangeMapper: ComponentRangeMapper;
        selectionManager: SelectionManager;
        getMouseReportingGuard: () => string;
    }) {
        this.tui = params.tui;
        this.terminal = params.terminal;
        this.originalWrite = params.originalWrite;
        this.renderCluster = params.renderCluster;
        this.getShowHardwareCursor = params.getShowHardwareCursor;
        this.sidebar = params.sidebar;
        this.rowsDescriptor = params.rowsDescriptor;
        this.columnsDescriptor = params.columnsDescriptor;
        this.originalRender = params.originalRender;
        this.originalDoRender = params.originalDoRender;
        this.collapseState = params.collapseState;
        this.rangeMapper = params.rangeMapper;
        this.selectionManager = params.selectionManager;
        this.getMouseReportingGuard = params.getMouseReportingGuard;
    }

    // ── Accessors for controller ────────────────────────────

    /**
     * Set the index boundary between scrollable root children and fixed-cluster
     * children in `tui.children`.  Children at `index` and above are excluded
     * from root rendering and expected to be rendered by the `renderCluster`
     * callback instead.
     */
    setClusterStartIndex(index: number): void {
        this.clusterStartIndex = index;
    }

    get currentScrollOffset(): number {
        return this.scrollOffset;
    }

    set currentScrollOffset(value: number) {
        this.scrollOffset = value;
    }

    get currentMaxScrollOffset(): number {
        return this.maxScrollOffset;
    }

    get currentLastRootLineCount(): number {
        return this.lastRootLineCount;
    }

    set currentLastRootLineCount(value: number) {
        this.lastRootLineCount = value;
    }

    get currentRootLines(): string[] {
        return this.rootLines;
    }

    get currentVisibleRootStart(): number {
        return this.visibleRootStart;
    }

    get currentVisibleScrollableRows(): number {
        return this.visibleScrollableRows;
    }

    get currentVisibleRootLines(): string[] {
        return this.visibleRootLines;
    }

    get currentVisibleClusterLines(): string[] {
        return this.visibleClusterLines;
    }

    set currentVisibleClusterLines(value: string[]) {
        this.visibleClusterLines = value;
    }

    get currentRootComponentLineRanges(): RootComponentLineRange[] {
        return this.rootComponentLineRanges;
    }

    get currentRootComponentRangesTrusted(): boolean {
        return this.rootComponentRangesTrusted;
    }

    get currentPatchedRenders(): RenderPatch[] {
        return this.patchedRenders;
    }

    get isRenderPassActive(): boolean {
        return this.renderPassActive;
    }

    setRenderPassActive(active: boolean): void {
        this.renderPassActive = active;
        // Don't null renderPassCluster here — let it persist across render
        // passes so getCluster() returns cached data during scroll calls
        // without re-rendering the editor on every tick. The cache is
        // invalidated explicitly in write() and paintFullFrame() when
        // cluster content might have changed.
    }

    /**
     * Return the set of components that changed in the most recent
     * refreshRootWindow call, then clear the set.  Used by the render
     * loop to decide between incremental vs full repaint.
     */
    getAndClearChangedComponents(): Set<object> {
        const s = this.lastChangedComponents;
        this.lastChangedComponents = new Set();
        return s;
    }

    /**
     * Estimate how many screen rows are affected by a set of changed
     * components, based on the current root component line ranges.
     */
    estimateAffectedLines(changed: Set<object>): number {
        if (changed.size === 0) return 0;
        const rows = new Set<number>();
        const start = this.visibleRootStart;
        const end = start + this.visibleScrollableRows;
        for (const comp of changed) {
            const range = this.rootComponentLineRanges.find(
                r => r.component === comp,
            );
            if (!range) continue;
            const rStart = Math.max(start, range.startLine);
            const rEnd = Math.min(end, range.startLine + range.lineCount);
            for (let r = rStart; r < rEnd; r++) rows.add(r);
        }
        return rows.size;
    }

    get isRenderingCluster(): boolean {
        return this.renderingCluster;
    }

    get isCheckingOverlay(): boolean {
        return this.checkingOverlay;
    }

    // ── Row accounting ──────────────────────────────────────

    getRawRows(): number {
        return Math.max(2, readRows(this.terminal, this.rowsDescriptor));
    }

    getScrollableRows(): number {
        if (
            this.renderingCluster ||
            this.checkingOverlay ||
            this.hasVisibleOverlay()
        ) {
            return this.getRawRows();
        }

        const rawRows = this.getRawRows();
        const width = this.getSidebarLayout().mainWidth;
        const cluster = this.getCluster(width, rawRows);
        return Math.max(1, rawRows - cluster.lines.length);
    }

    getRawColumns(): number {
        return Math.max(1, readColumns(this.terminal, this.columnsDescriptor));
    }

    getSidebarLayout() {
        return resolveSidebarLayout(this.getRawColumns(), this.sidebar);
    }

    /** Pi overlays temporarily reclaim the full terminal width. */
    getMainWidth(): number {
        if (
            this.checkingOverlay ||
            this.hasVisibleOverlay()
        ) {
            return this.getRawColumns();
        }
        return this.getSidebarLayout().mainWidth;
    }

    // ── Rendering pipeline ───────────────────────────────────

    /**
     * Return the subset of `tui.children` that belongs to the scrollable root
     * (everything before the fixed-cluster region).
     */
    private getRootChildren(): readonly unknown[] {
        return this.tui.children.slice(0, this.clusterStartIndex);
    }

    /**
     * Drop every render cache so the next root-window refresh recomputes line
     * ranges from the live component tree. Useful when we suspect stale cached
     * output (e.g. fresh startup where Pi populated children after install).
     */
    forceRefreshRootState(width: number): number {
        this.childRenderCache.clear();
        this.rangeMapper.clear();
        return this.refreshRootWindow(width);
    }

    refreshRootWindow(width: number): number {
        if (!this.originalRender) return this.updateVisibleRootWindow();

        const rawRows = this.getRawRows();
        const renderWidth = Math.max(1, width);
        const cluster = this.getCluster(renderWidth, rawRows);
        const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
        const previousVisibleRootStart = this.visibleRootStart;
        const previousVisibleScrollableRows = this.visibleScrollableRows;
        const previousScrollOffset = this.scrollOffset;

        const rootChildren = this.getRootChildren();
        const anchor = captureRootViewportAnchor(
            this.rootComponentLineRanges,
            this.visibleRootStart,
            this.scrollOffset,
            rootChildren,
        );

        // A collapse toggle can change a component's size without the parent
        // root child's own signature changing, so clear the range-mapper cache
        // before rendering.  The render cache will then seed fresh line counts
        // for all root children.
        if (this.collapseState.hasPendingToggle) {
            this.rangeMapper.clear();
        }

        const { lines, changedComponents } = this.childRenderCache.render(
            rootChildren,
            renderWidth,
            this.collapseState,
            this.rangeMapper,
        );
        this.lastChangedComponents = changedComponents;
        this.rootLines = lines;
        this.updateRootComponentLineRanges(
            renderWidth,
            lines.length,
            scrollableRows,
            rootChildren,
        );

        // Collapse/expand viewport anchoring: keep the toggled cell stable.
        const toggle = this.collapseState.consumeLastToggle();
        const collapseAnchorRange = toggle
            ? this.rootComponentLineRanges.find(
                    (r) => r.component === toggle.component,
                )
            : undefined;

        // General viewport anchoring: keeps content at the first visible line
        // stable when total line count changes (content growth or shrinkage).
        const anchoredOffset = offsetForRootViewportAnchor(
            anchor,
            this.rootComponentLineRanges,
            lines.length,
            scrollableRows,
        );
        if (anchoredOffset !== null) {
            this.scrollOffset = anchoredOffset;
        } else if (
            this.scrollOffset > 0 &&
            this.lastRootLineCount > 0 &&
            lines.length > this.lastRootLineCount
        ) {
            this.scrollOffset += lines.length - this.lastRootLineCount;
        }

        // Collapse anchoring: pin the toggled cell on screen.
        if (collapseAnchorRange && toggle) {
            const componentStart = collapseAnchorRange.startLine;
            const viewportTop = previousVisibleRootStart;
            const viewportBottom = viewportTop + previousVisibleScrollableRows;
            const clickLine = toggle.startLine;

            if (clickLine >= 0 && clickLine < viewportTop) {
                // Toggled cell was above the viewport: snap header to top on collapse.
                if (toggle.collapsed) {
                    const desiredOffset =
                        lines.length - scrollableRows - componentStart;
                    this.scrollOffset = Math.max(
                        0,
                        Math.min(desiredOffset, lines.length - scrollableRows),
                    );
                }
            } else if (
                clickLine >= 0 &&
                clickLine < viewportBottom &&
                previousScrollOffset > 0
            ) {
                // Toggled cell was in the viewport: pin click line to same screen row.
                const oldScreenRow = clickLine - viewportTop;
                const desiredStart = clickLine - oldScreenRow;
                const desiredOffset =
                    lines.length - scrollableRows - desiredStart;
                this.scrollOffset = Math.max(
                    0,
                    Math.min(desiredOffset, lines.length - scrollableRows),
                );
            }
        }

        this.lastRootLineCount = lines.length;
        this.maxScrollOffset = Math.max(0, lines.length - scrollableRows);
        this.scrollOffset = Math.max(
            0,
            Math.min(this.scrollOffset, this.maxScrollOffset),
        );

        return this.updateVisibleRootWindow(scrollableRows);
    }

    updateVisibleRootWindow(
        scrollableRows = this.visibleScrollableRows,
    ): number {
        const rows = Math.max(1, scrollableRows);
        const start = Math.max(
            0,
            this.rootLines.length - rows - this.scrollOffset,
        );
        const visibleLines = this.rootLines.slice(start, start + rows);
        while (visibleLines.length < rows) {
            visibleLines.push("");
        }

        this.visibleRootStart = start;
        this.visibleScrollableRows = rows;
        this.visibleRootLines = visibleLines;
        return start;
    }

    renderScrollableRoot(width: number): string[] {
        if (
            !this.originalRender ||
            this.renderingScrollableRoot
        ) {
            return this.originalRender?.(width) ?? [];
        }

        if (this.hasVisibleOverlay()) {
            return this.renderOverlayFrame();
        }

        this.renderingScrollableRoot = true;
        try {
            const start = this.refreshRootWindow(width);
            return this.visibleRootLines.map((line, index) => {
                return this.selectionManager.renderSelectionHighlight(
                    line,
                    start + index,
                    "root",
                );
            });
        } finally {
            this.renderingScrollableRoot = false;
        }
    }

    repaintScrollableViewport(
        width: number,
        options?: { skipClusterAndSidebar?: boolean },
    ): void {
        if (this.hasVisibleOverlay()) return;

        const rawRows = this.getRawRows();
        const cluster = this.getCluster(width, rawRows);
        const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
        const start = this.updateVisibleRootWindow(scrollableRows);

        // DEC 2026 synchronized output can cause scroll lag on some terminals
        // (notably Ghostty) when combined with DECSTBM scroll regions.  Disable
        // it by default for scroll repaints.  Set PI_COMPOSITOR_SYNC_SCROLL=1
        // to re-enable synchronized output during scrolls (may reduce tearing).
        const useSyncScroll = process.env.PI_COMPOSITOR_SYNC_SCROLL === "1";
        const syncBegin = useSyncScroll ? beginSynchronizedOutput() : "";
        const syncEnd = useSyncScroll ? endSynchronizedOutput() : "";

        // The fixed cluster (input bar) and sidebar do not move during a scroll,
        // so skip painting them entirely.  Only the scrollable root content needs
        // to be updated.

        let buffer =
            syncBegin +
            disableAutoWrap() +
            setScrollRegion(1, scrollableRows) +
            moveCursor(1, 1);

        // When no selection is active, skip the per-row
        // renderSelectionHighlight call entirely.  It returns the line
        // unchanged when there is no selection, but the call overhead
        // + getSelectionRangeForLine check adds up over 20+ rows per
        // repaint.
        const hasSelection = this.selectionManager.area !== null;
        for (let row = 0; row < scrollableRows; row++) {
            if (row > 0) buffer += "\r\n";
            const line = this.visibleRootLines[row] ?? "";
            const highlighted = hasSelection
                ? this.selectionManager.renderSelectionHighlight(
                      line,
                      start + row,
                      "root",
                  )
                : line;
            const content = sanitizeLine(highlighted, width);
            // Pad to `width` columns instead of using clearLine() (\x1b[2K),
            // which erases the ENTIRE line including the sidebar area.  Padding
            // only overwrites columns 1..width, leaving the sidebar columns
            // untouched so they persist correctly between scroll repaints.
            const vis = visibleWidth(content);
            buffer += vis >= width
                ? content + "\x1b[0m"
                : content + "\x1b[0m" + " ".repeat(width - vis);
        }

        if (options?.skipClusterAndSidebar) {
            // Reset the scroll region so subsequent terminal writes outside the
            // scrollable area behave correctly. The cluster and sidebar are
            // already on screen from the previous frame.
            buffer += resetScrollRegion();
        } else {
            buffer += buildFixedClusterPaint(
                this.decorateCluster(cluster),
                rawRows,
                width,
                this.getShowHardwareCursor(),
            );
            buffer += this.buildSidebarPaint();
        }

        buffer += enableAutoWrap();
        buffer += this.getMouseReportingGuard();
        buffer += syncEnd;
        this.originalWrite(buffer);
    }

    /**
     * Single terminal write for a normal render frame.
     *
     * Re-renders the scrollable root, then paints the visible root lines,
     * fixed cluster, and sidebar in one synchronized output. Also updates
     * Pi's internal bookkeeping so terminal.write interception keeps working.
     */
    paintFullFrame(): void {
        if (this.hasVisibleOverlay()) return;

        // Ensure the cluster is rendered fresh for full repaints so cursor
        // position, editor content, and other cluster state that may have
        // changed without a write() (e.g. cursor movement) are picked up.
        this.clusterGeneration++;

        const rawRows = this.getRawRows();
        const width = this.getSidebarLayout().mainWidth;
        const highlightedRootLines = this.renderScrollableRoot(width);
        const cluster = this.getCluster(width, rawRows);
        const scrollableRows = Math.max(1, rawRows - cluster.lines.length);

        let buffer =
            beginSynchronizedOutput() +
            disableAutoWrap() +
            setScrollRegion(1, scrollableRows);

        for (let row = 0; row < scrollableRows; row++) {
            if (row > 0) buffer += "\r\n";
            buffer += moveCursor(row + 1, 1);
            const content = sanitizeLine(
                highlightedRootLines[row] ?? "",
                width,
            );
            const vis = visibleWidth(content);
            buffer += vis >= width
                ? content + "\x1b[0m"
                : content + "\x1b[0m" + " ".repeat(width - vis);
        }

        buffer += buildFixedClusterPaint(
            this.decorateCluster(cluster),
            rawRows,
            width,
            this.getShowHardwareCursor(),
        );
        buffer += this.buildSidebarPaint();
        buffer += enableAutoWrap();
        buffer += this.getMouseReportingGuard();
        buffer += endSynchronizedOutput();
        this.originalWrite(buffer);

        // Keep Pi's cursor/viewport bookkeeping consistent with what was just
        // painted, so terminal.write interception can map cursor rows correctly.
        const contentRows = Math.max(0, highlightedRootLines.length - 1);
        this.tui.hardwareCursorRow = contentRows;
        this.tui.cursorRow = contentRows;
        this.tui.previousViewportTop = 0;
        this.tui.previousLines = highlightedRootLines;
        this.tui.previousWidth = width;
        this.tui.previousHeight = rawRows;
        this.tui.maxLinesRendered = Math.max(
            this.tui.maxLinesRendered ?? 0,
            highlightedRootLines.length,
        );
        this.tui.previousKittyImageIds =
            this.tui.collectKittyImageIds(highlightedRootLines);
    }

    /**
     * Incremental repaint that patches only screen rows affected by a set of
     * changed components.  Skips cluster, sidebar, DEC sync, and scroll region
     * setup — assumes those are unchanged from the last full paint.
     *
     * Used for small animated updates (spinners, progress indicators) where the
     * overhead of a full paintFullFrame would cause visible jank.
     */
    incrementalRepaint(changed: Set<object>): void {
        if (changed.size === 0) return;
        const width = this.getSidebarLayout().mainWidth;
        const rows = this.visibleScrollableRows;
        const start = this.visibleRootStart;

        // Build set of screen rows that need updating
        const affectedRows = new Set<number>();
        for (const comp of changed) {
            const range = this.rootComponentLineRanges.find(
                r => r.component === comp,
            );
            if (!range) continue;
            const rStart = Math.max(0, range.startLine - start);
            const rEnd = Math.min(rows, rStart + range.lineCount);
            for (let r = rStart; r < rEnd; r++) affectedRows.add(r);
        }
        if (affectedRows.size === 0) return;

        const hasSelection = this.selectionManager.area !== null;
        let buf = disableAutoWrap();
        for (const row of [...affectedRows].sort((a, b) => a - b)) {
            const line = this.visibleRootLines[row] ?? "";
            const highlighted = hasSelection
                ? this.selectionManager.renderSelectionHighlight(
                      line,
                      start + row,
                      "root",
                  )
                : line;
            const content = sanitizeLine(highlighted, width);
            const vis = visibleWidth(content);
            buf += moveCursor(row + 1, 1);
            buf += vis >= width
                ? content + "\x1b[0m"
                : content + "\x1b[0m" + " ".repeat(width - vis);
        }
        buf += this.getMouseReportingGuard();
        buf += enableAutoWrap();
        this.originalWrite(buf);
    }

    /**
     * Single entry point for the compositor's render loop.  Called by the
     * patched doRender for every non-overlay frame.
     *
     * 1. Calls refreshRootWindow ONCE to update root state from children.
     * 2. If only a few lines changed → incrementalRepaint (no cluster/sidebar).
     * 3. Otherwise → full paint from the already-fresh rootLines (no double
     *    refreshRootWindow).
     */
    renderFrame(): void {
        if (this.hasVisibleOverlay()) return;
        const rawRows = this.getRawRows();
        const width = this.getSidebarLayout().mainWidth;

        // One call — renders children, updates rootLines, populates cache.
        this.refreshRootWindow(width);

        const changed = this.getAndClearChangedComponents();
        if (changed.size > 0 && this.estimateAffectedLines(changed) <= 10) {
            this.incrementalRepaint(changed);
            // Cluster + sidebar may have changed (editor grew/shrunk) even
            // if root changes were small.  Always repaint them to keep the
            // editor area in sync with the current scrollable root height.
            // write() invalidated renderPassCluster, so getCluster() fetches
            // fresh editor content here.
            this.renderPassCluster = null;
            const cluster = this.getCluster(width, rawRows);
            const clusterAndSidebar =
                buildFixedClusterPaint(
                    this.decorateCluster(cluster),
                    rawRows,
                    width,
                    this.getShowHardwareCursor(),
                ) +
                this.buildSidebarPaint() +
                this.getMouseReportingGuard();
            this.originalWrite(clusterAndSidebar);
            return;
        }

        // Full paint from the rootLines that refreshRootWindow just produced.
        this.renderPassCluster = null;
        const cluster = this.getCluster(width, rawRows);
        const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
        const highlightedRootLines = this.visibleRootLines.map((line, index) =>
            this.selectionManager.renderSelectionHighlight(
                line,
                this.visibleRootStart + index,
                "root",
            ),
        );

        let buffer =
            beginSynchronizedOutput() +
            disableAutoWrap() +
            setScrollRegion(1, scrollableRows);

        for (let row = 0; row < scrollableRows; row++) {
            if (row > 0) buffer += "\r\n";
            buffer += moveCursor(row + 1, 1);
            const content = sanitizeLine(
                highlightedRootLines[row] ?? "",
                width,
            );
            const vis = visibleWidth(content);
            buffer += vis >= width
                ? content + "\x1b[0m"
                : content + "\x1b[0m" + " ".repeat(width - vis);
        }

        buffer += buildFixedClusterPaint(
            this.decorateCluster(cluster),
            rawRows,
            width,
            this.getShowHardwareCursor(),
        );
        buffer += this.buildSidebarPaint();
        buffer += enableAutoWrap();
        buffer += this.getMouseReportingGuard();
        buffer += endSynchronizedOutput();
        this.originalWrite(buffer);

        // Keep Pi's cursor/viewport bookkeeping consistent.
        const contentRows = Math.max(0, highlightedRootLines.length - 1);
        this.tui.hardwareCursorRow = contentRows;
        this.tui.cursorRow = contentRows;
        this.tui.previousViewportTop = 0;
        this.tui.previousLines = highlightedRootLines;
        this.tui.previousWidth = width;
        this.tui.previousHeight = rawRows;
        this.tui.maxLinesRendered = Math.max(
            this.tui.maxLinesRendered ?? 0,
            highlightedRootLines.length,
        );
        this.tui.previousKittyImageIds =
            this.tui.collectKittyImageIds(highlightedRootLines);
    }

    paintIntermediateFrame(message: string): void {
        const rows = this.getRawRows();
        const layout = this.getSidebarLayout();
        const scrollRows = Math.max(1, rows - 3);

        let buf = beginSynchronizedOutput() + disableAutoWrap();
        for (let r = 1; r <= scrollRows; r++) {
            buf += moveCursor(r, 1) + clearToEndOfLine();
            if (r === Math.floor(scrollRows / 2) && message.length <= layout.mainWidth) {
                const pad = Math.max(0, Math.floor((layout.mainWidth - message.length) / 2));
                buf += " ".repeat(pad) + message + "\x1b[0m";
            }
        }
        // Minimal cluster placeholder
        buf += buildFixedClusterPaint(
            { lines: [""], cursor: null },
            rows, layout.mainWidth, false,
        );
        buf += this.buildSidebarPaint() + enableAutoWrap() + this.getMouseReportingGuard() + endSynchronizedOutput();
        this.originalWrite(buf);
    }

    private renderOverlayFrame(): string[] {
        if (!this.originalRender) return [];

        const rawRows = this.getRawRows();
        const layout = this.getSidebarLayout();
        const cluster = this.getCluster(layout.mainWidth, rawRows);
        const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
        this.rangeMapper.setWidth(layout.mainWidth);
        const rootLines = this.originalRender(layout.mainWidth);
        const mainLines = [...rootLines];
        while (mainLines.length < scrollableRows) mainLines.push("");
        mainLines.push(...this.decorateCluster(cluster).lines);

        const sidebarLines =
            this.sidebar && layout.sidebarWidth > 0
                ? (() => {
                    try {
                        return this.sidebar!.component.render(layout.sidebarWidth);
                    } catch {
                        return [];
                    }
                })()
                : [];
        const sidebarStart = Math.max(0, mainLines.length - rawRows);
        return mainLines.map((mainLine, index) =>
            composeOverlayFrameLine(
                mainLine,
                sidebarLines[index - sidebarStart] ?? "",
                layout.mainWidth,
                layout.sidebarWidth,
            ),
        );
    }

    // ── Component line ranges ───────────────────────────────

    private updateRootComponentLineRanges(
        width: number,
        rootLineCount: number,
        scrollableRows: number,
        rootChildren: readonly unknown[] = this.getRootChildren(),
    ): void {
        const visibleStart = Math.max(
            0,
            rootLineCount - scrollableRows - this.scrollOffset,
        );
        const visibleEnd = Math.min(
            rootLineCount,
            visibleStart + scrollableRows,
        );
        const ranges = this.rangeMapper.buildRanges(
            rootChildren,
            width,
            visibleStart,
            visibleEnd,
            RANGE_MAP_OVERSCAN_LINES,
        );
        const mappedTotal =
            ranges.length > 0
                ? ranges[ranges.length - 1].startLine +
                  ranges[ranges.length - 1].lineCount
                : 0;
        this.rootComponentLineRanges = ranges;
        this.rootComponentRangesTrusted = mappedTotal === rootLineCount;
    }

    /**
     * Refresh component-to-line mapping for the current scroll offset without
     * re-rendering the root content. Used during scrolling so hover/click
     * hit-testing stays accurate for the newly visible viewport.
     */
    refreshRootComponentRanges(): void {
        // Clear the range-mapper line cache so getLines() re-renders
        // every component fresh.  This is necessary because Pi may update
        // component state (e.g. streaming tool output) without replacing
        // the component object, and the keyed cache would otherwise
        // return stale line counts.
        this.rangeMapper.clear();
        const width = this.getSidebarLayout().mainWidth;
        const rootChildren = this.getRootChildren();
        this.updateRootComponentLineRanges(
            width,
            this.rootLines.length,
            this.getScrollableRows(),
            rootChildren,
        );
    }

    getRootComponentLineRanges(): readonly RootComponentLineRange[] {
        return this.rootComponentLineRanges;
    }

    getRootComponentPathAtLine(
        line: number,
    ): readonly RootComponentLineRange[] {
        return this.rootComponentLineRanges
            .filter(
                (range) =>
                    line >= range.startLine &&
                    line < range.startLine + range.lineCount,
            )
            .toSorted((left, right) => right.lineCount - left.lineCount);
    }

    getRootComponentAtLine(line: number): RootComponentLineRange | null {
        return this.getRootComponentPathAtLine(line).at(-1) ?? null;
    }

    // ── Cluster ─────────────────────────────────────────────

    getCluster(
        width: number,
        terminalRows: number,
    ): FixedEditorClusterRender {
        // Cache hit when dimensions AND generation match.  write() and
        // paintFullFrame() bump the generation so the next getCluster()
        // re-renders fresh content.  Spinner ticks keep the same generation
        // and reuse the cached cluster.
        if (
            this.renderPassCluster?.width === width &&
            this.renderPassCluster.terminalRows === terminalRows &&
            this.renderPassCluster.generation === this.clusterGeneration
        ) {
            return this.renderPassCluster.cluster;
        }

        const cluster = this.withClusterRender(() =>
            this.renderCluster(width, terminalRows),
        );
        this.visibleClusterLines = cluster.lines;
        this.renderPassCluster = {
            width,
            terminalRows,
            generation: this.clusterGeneration,
            cluster,
        };
        return cluster;
    }

    /** Bump the cluster generation so the next getCluster() re-renders. */
    invalidateClusterCache(): void {
        this.clusterGeneration++;
    }

    decorateCluster(
        cluster: FixedEditorClusterRender,
    ): FixedEditorClusterRender {
        if (this.selectionManager.area !== "cluster") return cluster;

        return {
            ...cluster,
            lines: cluster.lines.map((line, index) =>
                this.selectionManager.renderSelectionHighlight(
                    line,
                    index,
                    "cluster",
                ),
            ),
        };
    }

    private withClusterRender<T>(render: () => T): T {
        const wasRenderingCluster = this.renderingCluster;
        this.renderingCluster = true;
        try {
            return render();
        } finally {
            this.renderingCluster = wasRenderingCluster;
        }
    }

    // ── Sidebar ─────────────────────────────────────────────

    buildSidebarPaint(): string {
        const layout = this.getSidebarLayout();
        if (!this.sidebar || layout.sidebarWidth === 0) return "";

        const rows = this.getRawRows();
        let lines: string[];
        try {
            lines = this.sidebar.component.render(layout.sidebarWidth);
        } catch {
            lines = [];
        }
        let buffer = "";
        for (let row = 0; row < rows; row++) {
            buffer +=
                moveCursor(row + 1, layout.mainWidth + 1) +
                clearToEndOfLine() +
                sanitizeLine(lines[row] ?? "", layout.sidebarWidth);
        }
        return buffer;
    }

    // ── Patched renders / hidden ────────────────────────────

    hideRenderable(target: PatchedRenderable): void {
        if (this.patchedRenders.some((patch) => patch.target === target))
            return;
        const originalRender = target.render.bind(target);
        this.patchedRenders.push({ target, originalRender });
        target.render = () => [];
    }

    renderHidden(target: PatchedRenderable, width: number): string[] {
        const patch = this.patchedRenders.find(
            (candidate) => candidate.target === target,
        );
        const render = patch?.originalRender ?? target.render.bind(target);
        return render(width);
    }

    restorePatchedRenders(): void {
        for (const patch of this.patchedRenders.splice(0)) {
            patch.target.render = patch.originalRender;
        }
    }

    // ── Overlay check ───────────────────────────────────────

    hasVisibleOverlay(): boolean {
        if (this.checkingOverlay) return true;

        this.checkingOverlay = true;
        try {
            if (this.tui.hasOverlay()) {
                return true;
            }

            if (!Array.isArray(this.tui.overlayStack)) {
                return false;
            }

            return this.tui.overlayStack.some(
                (entry) => entry && entry.hidden !== true,
            );
        } catch {
            // If overlay state is inaccessible (e.g. corrupted overlay stack,
            // or a visible callback throws), conservatively assume an overlay
            // is active so the compositor defers to Pi's normal input handling
            // instead of attempting to process/misdirect the input itself.
            return true;
        } finally {
            this.checkingOverlay = false;
        }
    }

    // ── Terminal write interception ──────────────────────────

    write(data: string): void {
        const rawRows = this.getRawRows();
        const width = this.getSidebarLayout().mainWidth;

        // Overlay transition: Pi has issued \x1b[2J which erased everything,
        // so we must repaint cluster + sidebar along with the data.
        if (this.overlayTransitionRepaintPending) {
            this.overlayTransitionRepaintPending = false;
            const cluster = this.getCluster(width, rawRows);
            const buffer =
                beginSynchronizedOutput() +
                disableAutoWrap() +
                moveCursor(1, 1) +
                data +
                buildFixedClusterPaint(
                    this.decorateCluster(cluster),
                    rawRows,
                    width,
                    this.getShowHardwareCursor(),
                ) +
                this.buildSidebarPaint() +
                enableAutoWrap() +
                this.getMouseReportingGuard() +
                endSynchronizedOutput();
            this.originalWrite(buffer);
            return;
        }

        // Normal write: pass data through directly.  The editor's own cursor
        // positioning and character echo provide immediate visual feedback.
        // Cluster + sidebar decoration is handled by the next renderFrame().
        // This avoids wrapping every keystroke in ~500 bytes of cluster
        // repaint, making typing feel significantly more responsive.
        //
        // We do NOT bump clusterGeneration here.  The cluster (input bar) is
        // static during streaming (no user typing), so bumping it on every
        // write would waste a terminal-emulator render every frame.
        // handleInput() invalidates the cluster cache before processing user
        // input, so keyboard/mouse writes always see fresh cluster state.
        // System writes that change cluster state (rare) accept a one-frame
        // delay in the cluster render — imperceptible at 60fps.
        this.originalWrite(data);
    }
}
