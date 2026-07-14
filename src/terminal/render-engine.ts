import {
    beginSynchronizedOutput,
    endSynchronizedOutput,
    disableAutoWrap,
    enableAutoWrap,
    setScrollRegion,
    moveCursor,
    clearLine,
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
import {
    isAssistantComponent,
    isToolComponent,
    type ComponentCollapseState,
} from "./collapse.js";
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

const RANGE_MAP_OVERSCAN_LINES = 10;

type RootViewportAnchor = {
    component: RootComponentLineRange["component"];
    lineOffset: number;
};

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
    private readonly collapseState: ComponentCollapseState;
    private readonly rangeMapper: ComponentRangeMapper;
    private readonly selectionManager: SelectionManager;
    private readonly getMouseReportingGuard: () => string;
    private readonly childRenderCache = new ChildRenderCache();

    private patchedRenders: RenderPatch[] = [];
    private renderPassActive = false;
    private renderPassCluster: RenderPassCluster | null = null;
    private renderingCluster = false;
    private renderingScrollableRoot = false;
    private checkingOverlay = false;
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
        collapseState: ComponentCollapseState;
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
        if (!active) {
            this.renderPassCluster = null;
        }
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

    refreshRootWindow(width: number): number {
        if (!this.originalRender) return this.updateVisibleRootWindow();

        const rawRows = this.getRawRows();
        const renderWidth = Math.max(1, width);
        const cluster = this.getCluster(renderWidth, rawRows);
        const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
        const previousVisibleRootStart = this.visibleRootStart;
        const previousVisibleScrollableRows = this.visibleScrollableRows;

        const anchor = this.captureRootViewportAnchor();
        this.collapseState.reconcile(this.tui.children);

        // A collapse toggle can change a nested component's size without the
        // parent root child's own signature changing, so clear the range-mapper
        // cache before rendering.  The render cache will then seed fresh line
        // counts for all root children.
        if (this.collapseState.hasPendingToggle()) {
            this.rangeMapper.clear();
        }

        const { lines } = this.childRenderCache.render(
            this.tui.children,
            renderWidth,
            this.collapseState,
            this.rangeMapper,
        );
        this.rootLines = lines;
        this.updateRootComponentLineRanges(
            renderWidth,
            lines.length,
            scrollableRows,
        );

        const collapseToggle = this.collapseState.consumeLastToggle();
        const collapseAnchorRange = collapseToggle
            ? this.rootComponentLineRanges.find(
                  (candidate) => candidate.component === collapseToggle.component,
              )
            : undefined;

        // General viewport anchoring: keeps content at the first visible line
        // stable when total line count changes (content growth or shrinkage).
        const anchoredOffset = this.offsetForRootViewportAnchor(
            anchor,
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

        // Collapse/expand anchoring: keep the toggled cell stable on screen.
        // This overrides the general anchor because the user's action was on
        // this specific cell.
        if (collapseAnchorRange && collapseToggle) {
            const componentStart = collapseAnchorRange.startLine;
            const viewportTop = previousVisibleRootStart;
            const viewportBottom = viewportTop + previousVisibleScrollableRows;

            if (collapseToggle.startLine < viewportTop) {
                // Toggled cell was above the viewport: snap its header to the
                // top on collapse. On expansion, leave the viewport alone so
                // the user isn't pulled up by content growing above them.
                if (collapseToggle.collapsed) {
                    const desiredOffset =
                        lines.length - scrollableRows - componentStart;
                    this.scrollOffset = Math.max(
                        0,
                        Math.min(desiredOffset, lines.length - scrollableRows),
                    );
                }
            } else if (collapseToggle.startLine < viewportBottom) {
                // Toggled cell was inside the viewport: pin its header to the
                // same screen row it occupied before the toggle. This prevents
                // the viewport from drifting when nested content changes size.
                const oldScreenRow = collapseToggle.startLine - viewportTop;
                const desiredStart = componentStart - oldScreenRow;
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
                    this.collapseState,
                    (lineNum) => this.getRootComponentPathAtLine(lineNum),
                );
            });
        } finally {
            this.renderingScrollableRoot = false;
        }
    }

    repaintScrollableViewport(width: number): void {
        if (this.hasVisibleOverlay()) return;

        const rawRows = this.getRawRows();
        const cluster = this.getCluster(width, rawRows);
        const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
        const start = this.updateVisibleRootWindow(scrollableRows);
        let buffer =
            beginSynchronizedOutput() +
            disableAutoWrap() +
            setScrollRegion(1, scrollableRows) +
            moveCursor(1, 1);

        for (let row = 0; row < scrollableRows; row++) {
            if (row > 0) buffer += "\r\n";
            buffer += clearLine();
            buffer += sanitizeLine(
                this.selectionManager.renderSelectionHighlight(
                    this.visibleRootLines[row] ?? "",
                    start + row,
                    "root",
                    this.collapseState,
                    (lineNum) => this.getRootComponentPathAtLine(lineNum),
                ),
                width,
            );
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

        const rawRows = this.getRawRows();
        const width = this.getSidebarLayout().mainWidth;
        const highlightedRootLines = this.renderScrollableRoot(width);
        const cluster = this.getCluster(width, rawRows);
        const scrollableRows = Math.max(1, rawRows - cluster.lines.length);

        let buffer =
            beginSynchronizedOutput() +
            disableAutoWrap();

        for (let row = 0; row < scrollableRows; row++) {
            if (row > 0) buffer += "\r\n";
            buffer += moveCursor(row + 1, 1) + clearLine();
            buffer += sanitizeLine(highlightedRootLines[row] ?? "", width);
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

    private renderOverlayFrame(): string[] {
        if (!this.originalRender) return [];

        const rawRows = this.getRawRows();
        const layout = this.getSidebarLayout();
        const cluster = this.getCluster(layout.mainWidth, rawRows);
        const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
        this.collapseState.reconcile(this.tui.children);
        this.rangeMapper.setWidth(layout.mainWidth);
        const rootLines = this.originalRender(layout.mainWidth);
        const mainLines = [...rootLines];
        while (mainLines.length < scrollableRows) mainLines.push("");
        mainLines.push(...this.decorateCluster(cluster).lines);

        const sidebarLines =
            this.sidebar && layout.sidebarWidth > 0
                ? this.sidebar.render(layout.sidebarWidth, rawRows)
                : [];
        const sidebarStart = Math.max(0, mainLines.length - rawRows);
        return mainLines.map((mainLine, index) =>
            this.composeOverlayFrameLine(
                mainLine,
                sidebarLines[index - sidebarStart] ?? "",
                layout.mainWidth,
                layout.sidebarWidth,
            ),
        );
    }

    private composeOverlayFrameLine(
        mainLine: string,
        sidebarLine: string,
        mainWidth: number,
        sidebarWidth: number,
    ): string {
        const main = sanitizeLine(mainLine, mainWidth);
        const mainPadding = " ".repeat(
            Math.max(0, mainWidth - visibleWidth(main)),
        );
        const sidebar =
            sidebarWidth > 0 ? sanitizeLine(sidebarLine, sidebarWidth) : "";
        return `${main}${mainPadding}${sidebar}`;
    }

    // ── Component line ranges ───────────────────────────────

    private updateRootComponentLineRanges(
        width: number,
        rootLineCount: number,
        scrollableRows: number,
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
            this.tui.children,
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
        const width = this.getSidebarLayout().mainWidth;
        const rawRows = this.getRawRows();
        const cluster = this.getCluster(width, rawRows);
        const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
        this.updateRootComponentLineRanges(
            width,
            this.rootLines.length,
            scrollableRows,
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

    // ── Viewport anchor ─────────────────────────────────────

    private captureRootViewportAnchor(): RootViewportAnchor | null {
        if (this.scrollOffset === 0) return null;

        // Capture the outermost (root-level) component at the first visible line.
        // Root-level children are always in the component line ranges (the mapper
        // adds every root child unconditionally), so this anchor survives
        // collapse/expand. Using the innermost child would be wrong because that
        // child (e.g. a tool output line) may disappear when its parent collapses,
        // leaving us without a valid anchor.
        const rootComponents = new Set<object>(
            this.tui.children.filter(
                (c) => typeof c === "object" && c !== null,
            ) as object[],
        );
        const range = this.rootComponentLineRanges.find(
            (r) =>
                rootComponents.has(r.component as object) &&
                this.visibleRootStart >= r.startLine &&
                this.visibleRootStart < r.startLine + r.lineCount,
        );
        if (!range || range.lineCount === 0) return null;
        return {
            component: range.component,
            lineOffset: this.visibleRootStart - range.startLine,
        };
    }

    private offsetForRootViewportAnchor(
        anchor: RootViewportAnchor | null,
        lineCount: number,
        viewportRows: number,
    ): number | null {
        if (!anchor) return null;
        const range = this.rootComponentLineRanges.find(
            (candidate) => candidate.component === anchor.component,
        );
        if (!range || range.lineCount === 0 || lineCount === 0) return null;

        const desiredStart = Math.min(
            lineCount - 1,
            range.startLine +
                Math.min(anchor.lineOffset, range.lineCount - 1),
        );
        return Math.max(0, lineCount - viewportRows - desiredStart);
    }

    // ── Cluster ─────────────────────────────────────────────

    getCluster(
        width: number,
        terminalRows: number,
    ): FixedEditorClusterRender {
        if (
            this.renderPassActive &&
            this.renderPassCluster?.width === width &&
            this.renderPassCluster.terminalRows === terminalRows
        ) {
            return this.renderPassCluster.cluster;
        }

        const cluster = this.withClusterRender(() =>
            this.renderCluster(width, terminalRows),
        );
        this.visibleClusterLines = cluster.lines;
        if (this.renderPassActive) {
            this.renderPassCluster = { width, terminalRows, cluster };
        }
        return cluster;
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
                    this.collapseState,
                    () => [],
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
        const lines = this.sidebar.render(layout.sidebarWidth, rows);
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
        if (this.checkingOverlay) return false;

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
        } finally {
            this.checkingOverlay = false;
        }
    }

    // ── Terminal write interception ──────────────────────────

    write(data: string): void {
        const rawRows = this.getRawRows();
        const width = this.getSidebarLayout().mainWidth;
        const cluster = this.getCluster(width, rawRows);
        const reservedRows = cluster.lines.length;

        if (reservedRows === 0 || rawRows <= 2) {
            this.originalWrite(data);
            return;
        }

        const scrollBottom = Math.max(1, rawRows - reservedRows);
        const hardwareCursorRow = this.tui.hardwareCursorRow;
        const viewportTop = this.tui.previousViewportTop;
        const screenRow = Math.max(
            1,
            Math.min(scrollBottom, hardwareCursorRow - viewportTop + 1),
        );
        const buffer =
            beginSynchronizedOutput() +
            disableAutoWrap() +
            setScrollRegion(1, scrollBottom) +
            moveCursor(screenRow, 1) +
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
    }
}
