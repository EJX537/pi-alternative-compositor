import {
    isLeftDrag,
    isLeftPress,
    isMouseMotion,
    isMouseRelease,
    isRightPress,
    mouseScrollDelta,
} from "./input.js";
import type { SelectionManager } from "./selection-manager.js";
import type { TerminalModeManager } from "./terminal-mode-manager.js";
import type { ComponentCollapseState } from "./collapse.js";
import type {
    RootComponentLineRange,
    SelectionLocation,
    SgrMousePacket,
} from "./types.js";
import { logDebug } from "./debug-log.js";

// ── MouseHandler ─────────────────────────────────────────────

/**
 * Handles SGR mouse packet processing: scroll, selection, collapse toggle.
 * Delegates selection state to SelectionManager and terminal control to
 * TerminalModeManager.
 */
export class MouseHandler {
    private readonly selectionManager: SelectionManager;
    private readonly modeManager: TerminalModeManager;
    private readonly collapseState: ComponentCollapseState;
    private readonly onCopySelection: ((text: string) => void) | null;
    private readonly getRootComponentPathAtLine: (
        line: number,
    ) => readonly RootComponentLineRange[];
    private readonly getRootLines: () => string[];
    private readonly getVisibleClusterLines: () => string[];
    private readonly scrollBy: (
        delta: number,
        options?: { preserveSelection?: boolean },
    ) => void;
    private readonly repaint: () => void;

    constructor(params: {
        selectionManager: SelectionManager;
        modeManager: TerminalModeManager;
        collapseState: ComponentCollapseState;
        onCopySelection: ((text: string) => void) | null;
        getRootComponentPathAtLine: (
            line: number,
        ) => readonly RootComponentLineRange[];
        getRootLines: () => string[];
        getVisibleClusterLines: () => string[];
        scrollBy: (
            delta: number,
            options?: { preserveSelection?: boolean },
        ) => void;
        repaint: () => void;
    }) {
        this.selectionManager = params.selectionManager;
        this.modeManager = params.modeManager;
        this.collapseState = params.collapseState;
        this.onCopySelection = params.onCopySelection;
        this.getRootComponentPathAtLine = params.getRootComponentPathAtLine;
        this.getRootLines = params.getRootLines;
        this.getVisibleClusterLines = params.getVisibleClusterLines;
        this.scrollBy = params.scrollBy;
        this.repaint = params.repaint;
    }

    /**
     * Process a single SGR mouse packet. Returns true if the packet was
     * consumed, false if it should fall through.
     */
    handleMousePacket(
        packet: SgrMousePacket,
        visibleRootStart: number,
        visibleScrollableRows: number,
        visibleRootLines: string[],
        visibleClusterLines: string[],
        sidebarMainWidth: number,
        scrollOffset: number,
        maxScrollOffset: number,
    ): boolean {
        logDebug(
            "mouse-packet:",
            "row=", packet.row,
            "col=", packet.col,
            "code=", packet.code,
            "final=", packet.final,
            "visibleRows=", visibleScrollableRows,
            "visibleRootStart=", visibleRootStart,
        );
        const delta = mouseScrollDelta(packet);
        if (delta !== 0) {
            this.selectionManager.clearSelection();
            this.scrollBy(delta);
            return true;
        }

        const location = this.selectionManager.selectionLocationForPacket(
            packet.row,
            packet.col,
            visibleRootStart,
            visibleScrollableRows,
            visibleClusterLines,
            sidebarMainWidth,
        );

        if (isRightPress(packet)) {
            this.handleRightClick(location);
            return true;
        }

        if (
            this.selectionManager.isDragging &&
            isMouseRelease(packet)
        ) {
            this.handleRelease(location, packet, visibleRootStart, visibleScrollableRows, visibleRootLines, visibleClusterLines);
            return true;
        }

        if (!location) {
            logDebug("mouse-location: null");
            return true;
        }
        logDebug("mouse-location:", "area=", location.area, "line=", location.point.line, "col=", location.point.col);

        if (isLeftPress(packet)) {
            this.handleLeftPress(location, visibleRootStart, visibleScrollableRows, visibleRootLines, visibleClusterLines);
            return true;
        }

        if (
            this.selectionManager.isDragging &&
            isLeftDrag(packet) &&
            location.area === this.selectionManager.area
        ) {
            if (
                !this.selectionManager.hadDrag &&
                this.selectionManager.leftPressLocation
            ) {
                const press = this.selectionManager.leftPressLocation;
                if (
                    press.area !== location.area ||
                    press.screenRow !== location.screenRow ||
                    Math.abs(press.screenCol - location.screenCol) > 2
                ) {
                    this.selectionManager.hadDrag = true;
                }
            } else {
                this.selectionManager.hadDrag = true;
            }
            this.selectionManager.lastPress = null;
            this.selectionManager.preserveFocusOnRelease = false;
            this.selectionManager.focus = location.point;

            const edgeScroll = this.selectionManager.scrollSelectionAtViewportEdge(
                packet.row,
                visibleScrollableRows,
                scrollOffset,
                maxScrollOffset,
                visibleRootLines,
            );
            if (edgeScroll.scrolled) {
                const delta = edgeScroll.nextOffset - scrollOffset;
                this.selectionManager.focus = {
                    line: location.point.line - delta,
                    col: location.point.col,
                };
                this.scrollBy(delta, { preserveSelection: true });
                return true;
            }

            this.repaint();
            return true;
        }

        if (
            isMouseMotion(packet) &&
            this.selectionManager.updateHover(location)
        ) {
            this.repaint();
            return true;
        }

        // The compositor owns the alternate screen and mouse reporting; every
        // handled packet must return true so the caller does not pass it on to
        // Pi's default input handling.
        return true;
    }

    // ── Private helpers ─────────────────────────────────────

    private handleRightClick(
        location: SelectionLocation | null,
    ): void {
        // Capture the selected text BEFORE clearing the selection, otherwise
        // isLocationInsideSelection always sees an empty area.
        const selectedText = this.selectionManager.isLocationInsideSelection(
            location,
        )
            ? this.getSelectedText()
            : "";
        this.selectionManager.clearSelection();
        this.selectionManager.preserveFocusOnRelease = false;
        if (selectedText) {
            this.onCopySelection?.(selectedText);
            this.selectionManager.lastPress = null;
            this.modeManager.pauseMouseReportingForContextMenu(selectedText);
            return;
        }

        this.selectionManager.lastPress = null;
        this.modeManager.pauseMouseReportingForContextMenu();
    }

    private handleRelease(
        location: SelectionLocation | null,
        packet: SgrMousePacket,
        visibleRootStart: number,
        visibleScrollableRows: number,
        visibleRootLines: string[],
        visibleClusterLines: string[],
    ): void {
        if (
            !this.selectionManager.hadDrag &&
            location &&
            this.selectionManager.leftPressLocation &&
            location.area === "root" &&
            this.selectionManager.isClick(
                this.selectionManager.leftPressLocation,
                location,
            )
        ) {
            const path = this.getRootComponentPathAtLine(location.point.line);
            logDebug("release-toggle: path=", path.length, "line=", location.point.line);
            const toggled = this.collapseState.toggle(path, location.point.line);
            logDebug("release-toggle-result:", toggled);
            if (toggled) {
                this.selectionManager.clearSelection();
                this.selectionManager.lastPress = null;
                this.selectionManager.leftPressLocation = null;
                this.selectionManager.hadDrag = false;
                this.repaint();
                return;
            }
        }

        // Finish the selection
        this.selectionManager.finishSelection(
            packet.row,
            packet.col,
            location,
            visibleRootStart,
            visibleScrollableRows,
            visibleRootLines,
            visibleClusterLines,
        );

        const selectedText = this.getSelectedText();
        if (selectedText) {
            this.selectionManager.lastPress = null;
            this.onCopySelection?.(selectedText);
        } else {
            this.selectionManager.clearSelection();
        }
        this.repaint();
    }

    private handleLeftPress(
        location: SelectionLocation,
        visibleRootStart: number,
        visibleScrollableRows: number,
        visibleRootLines: string[],
        visibleClusterLines: string[],
    ): void {
        this.selectionManager.leftPressLocation = location;
        this.selectionManager.hadDrag = false;
        this.selectionManager.startSelection(
            location,
            visibleRootStart,
            visibleScrollableRows,
            visibleRootLines,
            visibleClusterLines,
        );
    }

    private getSelectedText(): string {
        return this.selectionManager.getSelectedText(
            this.getRootLines(),
            this.getVisibleClusterLines(),
        );
    }
}
