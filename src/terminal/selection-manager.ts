import { visibleWidth } from "@earendil-works/pi-tui";
import {
    compareSelectionPoints,
    sliceColumns,
    stripAnsi,
} from "../compositor/text.js";
import type { ComponentCollapseState } from "./collapse.js";
import type {
    RootComponentLineRange,
    SelectionArea,
    SelectionLocation,
    SelectionPoint,
} from "./types.js";

const DOUBLE_CLICK_MS = 500;

// ── SelectionManager ─────────────────────────────────────────

/**
 * Owns selection state and all selection-related methods.
 * Controls highlight rendering for selection and hover effects.
 */
export class SelectionManager {
    // Private backing fields prefixed to avoid collision with method names.
    // External access is through public getter/setter properties.
    private _area: SelectionArea | null = null;
    private _anchor: SelectionPoint | null = null;
    private _focus: SelectionPoint | null = null;
    private _dragging = false;
    private _preserveFocus = false;
    private _lastPress: {
        area: SelectionArea;
        line: number;
        at: number;
    } | null = null;
    private _leftPressLoc: SelectionLocation | null = null;
    private _hadDrag = false;
    private _hoverLine: number | null = null;

    // ── Public accessors ──────────────────────────────────

    get isDragging(): boolean {
        return this._dragging;
    }

    get area(): SelectionArea | null {
        return this._area;
    }

    set area(value: SelectionArea | null) {
        this._area = value;
    }

    get anchor(): SelectionPoint | null {
        return this._anchor;
    }

    set anchor(value: SelectionPoint | null) {
        this._anchor = value;
    }

    get focus(): SelectionPoint | null {
        return this._focus;
    }

    set focus(value: SelectionPoint | null) {
        this._focus = value;
    }

    get preserveFocusOnRelease(): boolean {
        return this._preserveFocus;
    }

    set preserveFocusOnRelease(value: boolean) {
        this._preserveFocus = value;
    }

    get lastPress(): { area: SelectionArea; line: number; at: number } | null {
        return this._lastPress;
    }

    set lastPress(
        value: { area: SelectionArea; line: number; at: number } | null,
    ) {
        this._lastPress = value;
    }

    get leftPressLocation(): SelectionLocation | null {
        return this._leftPressLoc;
    }

    set leftPressLocation(value: SelectionLocation | null) {
        this._leftPressLoc = value;
    }

    get hadDrag(): boolean {
        return this._hadDrag;
    }

    set hadDrag(value: boolean) {
        this._hadDrag = value;
    }

    get hoverRootLine(): number | null {
        return this._hoverLine;
    }

    set hoverRootLine(value: number | null) {
        this._hoverLine = value;
    }

    // ── Selection state management ──────────────────────────

    startSelection(
        location: SelectionLocation,
        visibleRootStart: number,
        visibleScrollableRows: number,
        visibleRootLines: string[],
        visibleClusterLines: string[],
    ): void {
        const now = Date.now();
        const line = location.point.line;
        if (
            this._lastPress &&
            this._lastPress.area === location.area &&
            this._lastPress.line === line &&
            now - this._lastPress.at <= DOUBLE_CLICK_MS
        ) {
            this._area = location.area;
            this._anchor = { line, col: 0 };
            this._focus = {
                line,
                col: this.selectionLineWidth(
                    location.area,
                    line,
                    visibleRootStart,
                    visibleRootLines,
                    visibleClusterLines,
                ),
            };
            this._dragging = true;
            this._preserveFocus = true;
            this._lastPress = null;
            return;
        }

        this._area = location.area;
        this._anchor = location.point;
        this._focus = location.point;
        this._dragging = true;
        this._preserveFocus = false;
        this._lastPress = {
            area: location.area,
            line,
            at: now,
        };
    }

    finishSelection(
        packetRow: number,
        packetCol: number,
        location: SelectionLocation | null,
        visibleRootStart: number,
        visibleScrollableRows: number,
        visibleRootLines: string[],
        visibleClusterLines: string[],
    ): void {
        if (!this._preserveFocus) {
            this._focus =
                location?.area === this._area
                    ? location.point
                    : this.clampedSelectionPointForPacket(
                          packetRow,
                          packetCol,
                          this._area,
                          visibleRootStart,
                          visibleScrollableRows,
                          visibleClusterLines,
                      );
        }

        this._preserveFocus = false;
        this._dragging = false;
    }

    clearSelection(): void {
        this._area = null;
        this._anchor = null;
        this._focus = null;
        this._dragging = false;
        this._preserveFocus = false;
    }

    // ── Selection queries ────────────────────────────────────

    getSelectedText(
        rootLines: string[],
        visibleClusterLines: string[],
    ): string {
        if (!this._area || !this._anchor || !this._focus) return "";

        const start =
            compareSelectionPoints(this._anchor, this._focus) <= 0
                ? this._anchor
                : this._focus;
        const end =
            start === this._anchor
                ? this._focus
                : this._anchor;
        if (start.line === end.line && start.col === end.col) return "";

        const lines = this._area === "root" ? rootLines : visibleClusterLines;
        const selected: string[] = [];
        for (let lineIndex = start.line; lineIndex <= end.line; lineIndex++) {
            const line = stripAnsi(lines[lineIndex] ?? "");
            const startCol = lineIndex === start.line ? start.col : 0;
            const endCol =
                lineIndex === end.line ? end.col : Number.POSITIVE_INFINITY;
            selected.push(sliceColumns(line, startCol, endCol));
        }

        return selected
            .join("\n")
            .replace(/[ \t]+$/gm, "")
            .trimEnd();
    }

    getSelectionRangeForLine(
        lineIndex: number,
        area: SelectionArea,
    ): { startCol: number; endCol: number } | null {
        if (this._area !== area || !this._anchor || !this._focus)
            return null;

        const start =
            compareSelectionPoints(this._anchor, this._focus) <= 0
                ? this._anchor
                : this._focus;
        const end =
            start === this._anchor
                ? this._focus
                : this._anchor;
        if (lineIndex < start.line || lineIndex > end.line) return null;

        return {
            startCol: lineIndex === start.line ? start.col : 0,
            endCol: lineIndex === end.line ? end.col : Number.POSITIVE_INFINITY,
        };
    }

    isLocationInsideSelection(location: SelectionLocation | null): boolean {
        if (!location || location.area !== this._area) return false;
        const range = this.getSelectionRangeForLine(
            location.point.line,
            location.area,
        );
        return Boolean(
            range &&
                location.point.col >= range.startCol &&
                location.point.col < range.endCol,
        );
    }

    selectionLineWidth(
        area: SelectionArea,
        lineIndex: number,
        visibleRootStart: number,
        visibleRootLines: string[],
        visibleClusterLines: string[],
    ): number {
        const lines = area === "root" ? visibleRootLines : visibleClusterLines;
        const firstLine = area === "root" ? visibleRootStart : 0;
        return visibleWidth(stripAnsi(lines[lineIndex - firstLine] ?? ""));
    }

    renderSelectionHighlight(
        line: string,
        lineIndex: number,
        area: SelectionArea,
        collapseState: ComponentCollapseState,
        getRootComponentPathAtLine: (
            line: number,
        ) => readonly RootComponentLineRange[],
    ): string {
        const range = this.getSelectionRangeForLine(lineIndex, area);
        const hovered =
            area === "root" &&
            lineIndex === this._hoverLine &&
            this.isCollapsibleLine(
                lineIndex,
                collapseState,
                getRootComponentPathAtLine,
            );
        const HOVER_BACKGROUND = "\x1b[48;5;240m";
        const HOVER_BACKGROUND_RESET = "\x1b[49m";
        if (!range) {
            return hovered
                ? `${HOVER_BACKGROUND}${line}${HOVER_BACKGROUND_RESET}`
                : line;
        }

        const plain = stripAnsi(line);
        const startCol = Math.max(
            0,
            Math.min(range.startCol, visibleWidth(plain)),
        );
        const endCol = Math.max(
            startCol,
            Math.min(range.endCol, visibleWidth(plain)),
        );
        if (startCol === endCol) {
            return hovered
                ? `${HOVER_BACKGROUND}${line}${HOVER_BACKGROUND_RESET}`
                : line;
        }

        const before = sliceColumns(plain, 0, startCol);
        const selected = sliceColumns(plain, startCol, endCol);
        const after = sliceColumns(plain, endCol, Number.POSITIVE_INFINITY);
        const highlighted = `${before}\x1b[7m${selected}\x1b[27m${after}`;
        return hovered
            ? `${HOVER_BACKGROUND}${highlighted}${HOVER_BACKGROUND_RESET}`
            : highlighted;
    }

    clampedSelectionPointForPacket(
        packetRow: number,
        packetCol: number,
        area: SelectionArea | null,
        visibleRootStart: number,
        visibleScrollableRows: number,
        visibleClusterLines: string[],
    ): SelectionPoint {
        if (area === "cluster") {
            return {
                line: Math.max(
                    0,
                    Math.min(
                        packetRow - visibleScrollableRows - 1,
                        visibleClusterLines.length - 1,
                    ),
                ),
                col: Math.max(0, packetCol - 1),
            };
        }

        const row = Math.max(1, Math.min(packetRow, visibleScrollableRows));
        return {
            line: visibleRootStart + row - 1,
            col: Math.max(0, packetCol - 1),
        };
    }

    selectionLocationForPacket(
        packetRow: number,
        packetCol: number,
        visibleRootStart: number,
        visibleScrollableRows: number,
        visibleClusterLines: string[],
        sidebarMainWidth: number,
    ): SelectionLocation | null {
        if (packetRow < 1 || packetCol > sidebarMainWidth) return null;

        const col = Math.max(0, packetCol - 1);
        if (packetRow <= visibleScrollableRows) {
            return {
                area: "root",
                point: {
                    line: visibleRootStart + packetRow - 1,
                    col,
                },
                screenRow: packetRow,
                screenCol: packetCol,
            };
        }

        const clusterLine = packetRow - visibleScrollableRows - 1;
        if (clusterLine >= visibleClusterLines.length) return null;

        return {
            area: "cluster",
            point: { line: clusterLine, col },
            screenRow: packetRow,
            screenCol: packetCol,
        };
    }

    scrollSelectionAtViewportEdge(
        packetRow: number,
        visibleScrollableRows: number,
        scrollOffset: number,
        maxScrollOffset: number,
        visibleRootLines: string[],
    ): {
        scrolled: boolean;
        nextOffset: number;
    } {
        if (!this._dragging || this._area !== "root") {
            return { scrolled: false, nextOffset: scrollOffset };
        }

        const delta =
            packetRow <= 1
                ? 1
                : packetRow >= visibleScrollableRows
                  ? -1
                  : 0;
        if (delta === 0) return { scrolled: false, nextOffset: scrollOffset };

        const nextOffset = Math.max(
            0,
            Math.min(scrollOffset + delta, maxScrollOffset),
        );
        if (nextOffset === scrollOffset) {
            return { scrolled: false, nextOffset: scrollOffset };
        }

        this._lastPress = null;
        this._preserveFocus = true;
        return { scrolled: true, nextOffset };
    }

    updateHover(location: SelectionLocation | null): boolean {
        const next = location?.area === "root" ? location.point.line : null;
        if (next !== this._hoverLine) {
            this._hoverLine = next;
            return true;
        }
        return false;
    }

    isClick(press: SelectionLocation, release: SelectionLocation): boolean {
        return (
            press.area === release.area &&
            press.screenRow === release.screenRow &&
            Math.abs(press.screenCol - release.screenCol) <= 2
        );
    }

    // ── Helpers ──────────────────────────────────────────────

    private isCollapsibleLine(
        line: number,
        collapseState: ComponentCollapseState,
        getRootComponentPathAtLine: (
            line: number,
        ) => readonly RootComponentLineRange[],
    ): boolean {
        const path = getRootComponentPathAtLine(line);
        return path.some((range) =>
            collapseState.isCollapsibleComponent(range.component),
        );
    }
}
