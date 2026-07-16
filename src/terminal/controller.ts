import { ComponentCollapseState } from "./collapse.js";
import { ComponentRangeMapper } from "./range-mapper.js";
import { MouseHandler } from "./mouse-handler.js";
import { RenderEngine } from "./render-engine.js";
import { SelectionManager } from "./selection-manager.js";
import { TerminalModeManager } from "./terminal-mode-manager.js";
import {
    isMouseMotion,
    isRootSubmitInput,
    mouseBaseButton,
    mouseScrollDelta,
    parseKeyboardScrollDelta,
    parseSgrMousePackets,
} from "./input.js";
import type { SgrMousePacket } from "./input.js";
import { descriptorForColumns, descriptorForRows } from "../pi/dimensions.js";
import {
    normalizeOverlayCompositionLine,
} from "../compositor/text.js";
import type { Terminal } from "@earendil-works/pi-tui";
import type { TerminalInternals, TuiInternals } from "../pi/internals.js";
import type {
    DisposeOptions,
    PatchedRenderable,
    RootComponentLineRange,
    TerminalSplitCompositorOptions,
} from "./types.js";
import { logDebug } from "./debug-log.js";

// ── TerminalSplitCompositor ──────────────────────────────────

export class TerminalSplitCompositor {
    private readonly tui: TuiInternals;
    private readonly terminal: Terminal & TerminalInternals;
    private readonly getShowHardwareCursor: () => boolean;
    private readonly mouseScroll: boolean;
    private readonly onCopySelection: ((text: string) => void) | null;
    private readonly originalWrite: (data: string) => void;
    private readonly originalDoRender: (() => void) | null;
    private readonly originalRender: ((width: number) => string[]) | null;
    private originalCompositeLineAt:
        | ((
              baseLine: string,
              overlayLine: string,
              startCol: number,
              overlayWidth: number,
              totalWidth: number,
          ) => string)
        | null = null;
    private removeInputListener: (() => void) | null = null;
    private originalAddInputListener:
        | ((
              listener: (
                  data: string,
              ) => { consume?: boolean; data?: string } | undefined,
          ) => () => void)
        | null = null;
    private addingOurInputListener = false;
    private emergencyCleanup: (() => void) | null = null;
    private installed = false;
    private disposed = false;
    private writing = false;
    private renderPassActive = false;
    private originalRowsDescriptor: PropertyDescriptor | undefined;
    private originalColumnsDescriptor: PropertyDescriptor | undefined;

    // Sub-managers
    readonly collapseState = new ComponentCollapseState();
    readonly rangeMapper = new ComponentRangeMapper();
    readonly selectionManager = new SelectionManager();
    readonly modeManager: TerminalModeManager;
    readonly mouseHandler: MouseHandler;
    readonly renderEngine: RenderEngine;

    constructor(options: TerminalSplitCompositorOptions) {
        /*
         * Options use TuiInternals / Terminal & TerminalInternals so the
         * compositor can access private members needed to overload the
         * render pipeline.  The cast from TUI to TuiInternals happens at
         * the call site (src/index.ts); here everything is already typed.
         */
        this.tui = options.tui;
        this.terminal = options.terminal;
        this.getShowHardwareCursor =
            options.getShowHardwareCursor ?? (() => false);
        this.mouseScroll = options.mouseScroll !== false;
        this.onCopySelection = options.onCopySelection ?? null;
        this.originalWrite = this.terminal.write.bind(this.terminal);
        this.originalDoRender = this.tui.doRender.bind(this.tui);
        this.originalRender = this.tui.render.bind(this.tui);

        const rowsDescriptor = descriptorForRows(this.terminal);
        const columnsDescriptor = descriptorForColumns(this.terminal);
        this.originalRowsDescriptor = rowsDescriptor;
        this.originalColumnsDescriptor = columnsDescriptor;

        this.modeManager = new TerminalModeManager(
            this.terminal,
            this.mouseScroll,
            this.originalWrite,
            () => this.onCopySelection,
            () => this.getSelectedText(),
        );

        this.renderEngine = new RenderEngine({
            tui: this.tui,
            terminal: this.terminal,
            originalWrite: this.originalWrite,
            renderCluster: options.renderCluster,
            getShowHardwareCursor: this.getShowHardwareCursor,
            sidebar: options.sidebar,
            rowsDescriptor,
            columnsDescriptor,
            originalRender: this.originalRender,
            originalDoRender: this.originalDoRender,
            collapseState: this.collapseState,
            rangeMapper: this.rangeMapper,
            selectionManager: this.selectionManager,
            getMouseReportingGuard: () =>
                this.modeManager.mouseReportingStateGuard(),
        });

        this.mouseHandler = new MouseHandler({
            selectionManager: this.selectionManager,
            modeManager: this.modeManager,
            collapseState: this.collapseState,
            onCopySelection: this.onCopySelection,
            getRootComponentPathAtLine: (line) =>
                this.renderEngine.getRootComponentPathAtLine(line),
            getRootLines: () => this.renderEngine.currentRootLines,
            getVisibleClusterLines: () =>
                this.renderEngine.currentVisibleClusterLines,
            scrollBy: (delta, options) => this.scrollBy(delta, options),
            repaint: () => this.repaint(),
        });
    }

    // ── Lifecycle ─────────────────────────────────────────────

    install(): void {
        if (this.installed) return;

        this.originalWrite(this.modeManager.buildInstallSequence());
        this.emergencyCleanup = () => {
            if (!this.disposed) {
                this.restoreTerminalStateForExit();
            }
        };
        process.once("exit", this.emergencyCleanup);

        Object.defineProperty(this.terminal, "rows", {
            configurable: true,
            get: () => this.renderEngine.getScrollableRows(),
        });
        Object.defineProperty(this.terminal, "columns", {
            configurable: true,
            get: () => this.renderEngine.getMainWidth(),
        });

        if (this.originalRender) {
            this.tui.render = (width: number) =>
                this.renderEngine.renderScrollableRoot(width);
        }

        this.originalAddInputListener = this.tui.addInputListener.bind(
            this.tui,
        );
        const addOurInputListener = () => {
            this.removeInputListener?.();
            this.addingOurInputListener = true;
            this.removeInputListener = this.originalAddInputListener!(
                (data: string) => this.handleInput(data),
            );
            this.addingOurInputListener = false;
        };
        this.tui.addInputListener = (listener) => {
            const result = this.originalAddInputListener!(listener);
            if (!this.addingOurInputListener) {
                addOurInputListener();
            }
            return result;
        };
        addOurInputListener();

        this.terminal.write = (data: string) => this.write(data);
        if (this.originalDoRender) {
            this.tui.doRender = () => {
                this.renderPassActive = true;
                this.renderEngine.setRenderPassActive(true);
                try {
                    if (this.renderEngine.hasVisibleOverlay()) {
                        // Overlays are rendered by Pi's own pipeline so modal
                        // focus, compositing, and cursor positioning stay correct.
                        this.originalDoRender?.();
                    } else {
                        // Normal renders are owned entirely by the compositor:
                        // one terminal write that refreshes root + cluster.
                        this.requestRepaint();
                    }
                } finally {
                    this.renderPassActive = false;
                    this.renderEngine.setRenderPassActive(false);
                }
            };
        }
        this.originalCompositeLineAt = this.tui.compositeLineAt.bind(
            this.tui,
        );
        this.tui.compositeLineAt = (
            baseLine: string,
            overlayLine: string,
            startCol: number,
            overlayWidth: number,
            totalWidth: number,
        ) =>
            this.originalCompositeLineAt?.(
                normalizeOverlayCompositionLine(baseLine),
                normalizeOverlayCompositionLine(overlayLine),
                startCol,
                overlayWidth,
                totalWidth,
            ) ?? "";

        // Eagerly refresh the root window state so that mouse hit-testing
        // data (visibleScrollableRows, rootComponentLineRanges) is populated
        // immediately, before the first async doRender() fires. Without this,
        // mouse events arriving during the startup window see default values
        // (scrollableRows === 0, ranges === []) and clicks are silently ignored.
        try {
            this.renderEngine.refreshRootWindow(
                this.renderEngine.getSidebarLayout().mainWidth,
            );
            logDebug(
                "install-eager-refresh: ranges=",
                this.renderEngine.currentRootComponentLineRanges.length,
                "visibleRows=",
                this.renderEngine.currentVisibleScrollableRows,
                "rootLines=",
                this.renderEngine.currentRootLines.length,
            );
        } catch (err) {
            logDebug("install-eager-refresh-error:", err);
        }

        this.installed = true;
    }

    hideRenderable(target: PatchedRenderable): void {
        this.renderEngine.hideRenderable(target);
    }

    renderHidden(target: PatchedRenderable, width: number): string[] {
        return this.renderEngine.renderHidden(target, width);
    }

    jumpToPreviousRootTarget(targetLines: readonly number[]): boolean {
        return this.jumpToRootTarget(targetLines, "previous");
    }

    jumpToNextRootTarget(targetLines: readonly number[]): boolean {
        return this.jumpToRootTarget(targetLines, "next");
    }

    jumpToRootBottom(): boolean {
        if (
            this.disposed ||
            this.renderEngine.hasVisibleOverlay() ||
            this.renderEngine.currentScrollOffset === 0
        )
            return false;

        this.selectionManager.clearSelection();
        this.selectionManager.lastPress = null;
        this.selectionManager.leftPressLocation = null;
        this.selectionManager.hadDrag = false;
        this.renderEngine.currentScrollOffset = 0;
        this.requestRender();
        return true;
    }

    getRootComponentLineRanges(): readonly RootComponentLineRange[] {
        return this.renderEngine.getRootComponentLineRanges();
    }

    getRootComponentPathAtLine(
        line: number,
    ): readonly RootComponentLineRange[] {
        return this.renderEngine.getRootComponentPathAtLine(line);
    }

    getRootComponentAtLine(line: number): RootComponentLineRange | null {
        return this.renderEngine.getRootComponentAtLine(line);
    }

    get visibleRootStart(): number {
        return this.renderEngine.currentVisibleRootStart;
    }

    get selectionDragging(): boolean {
        return this.selectionManager.isDragging;
    }

    setClusterStartIndex(index: number): void {
        this.renderEngine.setClusterStartIndex(index);
    }

    private handleMousePacket(packet: SgrMousePacket): void {
        this.mouseHandler.handleMousePacket(
            packet,
            this.renderEngine.currentVisibleRootStart,
            this.renderEngine.currentVisibleScrollableRows,
            this.renderEngine.currentVisibleRootLines,
            this.renderEngine.currentVisibleClusterLines,
            this.renderEngine.getSidebarLayout().mainWidth,
            this.renderEngine.currentScrollOffset,
            this.renderEngine.currentMaxScrollOffset,
        );
    }

    requestRepaint(): void {
        if (this.disposed) return;
        this.renderEngine.paintFullFrame();
    }

    dispose(options: DisposeOptions = {}): void {
        if (this.disposed) return;
        this.disposed = true;
        this.modeManager.markDisposed();

        this.renderEngine.restorePatchedRenders();

        this.removeInputListener?.();
        this.removeInputListener = null;
        if (this.originalAddInputListener) {
            this.tui.addInputListener = this.originalAddInputListener;
            this.originalAddInputListener = null;
        }
        if (this.emergencyCleanup) {
            process.removeListener("exit", this.emergencyCleanup);
            this.emergencyCleanup = null;
        }
        this.modeManager.clearTimers();

        this.terminal.write = this.originalWrite;
        if (this.originalDoRender) {
            this.tui.doRender = this.originalDoRender;
        }
        if (this.originalRender) {
            this.tui.render = this.originalRender;
        }
        if (this.originalCompositeLineAt) {
            this.tui.compositeLineAt = this.originalCompositeLineAt;
            this.originalCompositeLineAt = null;
        }

        if (this.originalRowsDescriptor) {
            Object.defineProperty(
                this.terminal,
                "rows",
                this.originalRowsDescriptor,
            );
        } else {
            Reflect.deleteProperty(this.terminal, "rows");
        }
        if (this.originalColumnsDescriptor) {
            Object.defineProperty(
                this.terminal,
                "columns",
                this.originalColumnsDescriptor,
            );
        } else {
            Reflect.deleteProperty(this.terminal, "columns");
        }

        const restoreSequence = this.modeManager.restoreTerminalState(options);
        if (restoreSequence.length > 0) {
            this.originalWrite(restoreSequence);
        }
    }

    // ── Private: input ────────────────────────────────────────

    private handleInput(
        data: string,
    ): { consume?: boolean; data?: string } | undefined {
        if (this.disposed || this.renderEngine.hasVisibleOverlay())
            return undefined;

        const mouseResult = this.mouseScroll
            ? parseSgrMousePackets(data)
            : null;
        if (mouseResult && mouseResult.packets.length > 0) {
            logDebug(
                "handleInput-mouse: packets=",
                mouseResult.packets.length,
                "renderPassActive=",
                this.renderPassActive,
                "ranges=",
                this.renderEngine.currentRootComponentLineRanges.length,
                "visibleRows=",
                this.renderEngine.currentVisibleScrollableRows,
            );
            // Mouse hit-testing state is normally refreshed by paintFullFrame(),
            // but on fresh startup the compositor installs before Pi populates
            // the chat. If a render is missed or coalesced, the line ranges can
            // stay stale. Refresh lazily on press/release so clicks never
            // operate on empty/outdated ranges. Skip scroll/motion: scroll
            // events are frequent and clearing caches every wheel tick causes
            // noticeable lag.
            const base = (code: number) => mouseBaseButton(code);
            const needsFreshState = mouseResult.packets.some(
                (packet) =>
                    !isMouseMotion(packet) &&
                    base(packet.code) !== 64 &&
                    base(packet.code) !== 65,
            );
            if (needsFreshState && !this.renderPassActive) {
                try {
                    const width = this.renderEngine.getSidebarLayout().mainWidth;
                    this.renderEngine.forceRefreshRootState(width);
                    logDebug(
                        "lazy-refresh: ranges=",
                        this.renderEngine.currentRootComponentLineRanges.length,
                        "visibleRows=",
                        this.renderEngine.currentVisibleScrollableRows,
                        "rootLines=",
                        this.renderEngine.currentRootLines.length,
                    );
                } catch (err) {
                    logDebug("lazy-refresh-error:", err);
                }
            }
            // Mouse wheel events often arrive in bursts from a single
            // physical scroll gesture. Coalesce their deltas and apply a
            // single scroll + repaint instead of repainting once per tick.
            let wheelDelta = 0;
            for (const packet of mouseResult.packets) {
                const delta = mouseScrollDelta(packet);
                if (delta !== 0) {
                    wheelDelta += delta;
                    continue;
                }
                this.mouseHandler.handleMousePacket(
                    packet,
                    this.renderEngine.currentVisibleRootStart,
                    this.renderEngine.currentVisibleScrollableRows,
                    this.renderEngine.currentVisibleRootLines,
                    this.renderEngine.currentVisibleClusterLines,
                    this.renderEngine.getSidebarLayout().mainWidth,
                    this.renderEngine.currentScrollOffset,
                    this.renderEngine.currentMaxScrollOffset,
                );
            }
            if (wheelDelta !== 0) {
                this.scrollBy(wheelDelta);
            }
            if (mouseResult.consumed === data.length) {
                return { consume: true };
            }
            return { data: data.slice(mouseResult.consumed) };
        }

        if (isRootSubmitInput(data)) {
            this.jumpToRootBottom();
            return undefined;
        }

        const keyboardDelta = parseKeyboardScrollDelta(data);
        if (keyboardDelta === 0) return undefined;

        this.scrollBy(keyboardDelta);
        return { consume: true };
    }

    // ── Private: scrolling ────────────────────────────────────

    private scrollBy(
        delta: number,
        options?: { preserveSelection?: boolean },
    ): void {
        const width = this.renderEngine.getSidebarLayout().mainWidth;

        const nextOffset = Math.max(
            0,
            Math.min(
                this.renderEngine.currentScrollOffset + delta,
                this.renderEngine.currentMaxScrollOffset,
            ),
        );
        if (nextOffset === this.renderEngine.currentScrollOffset) return;

        if (!options?.preserveSelection) {
            this.selectionManager.clearSelection();
            this.selectionManager.lastPress = null;
            this.selectionManager.leftPressLocation = null;
            this.selectionManager.hadDrag = false;
        }

        // Share the cluster cache between range refresh and viewport repaint
        // so the fixed editor area is rendered only once per scroll.
        this.renderEngine.setRenderPassActive(true);
        try {
            this.renderEngine.currentScrollOffset = nextOffset;
            this.renderEngine.refreshRootComponentRanges();
            this.renderEngine.repaintScrollableViewport(width);
        } finally {
            this.renderEngine.setRenderPassActive(false);
        }
    }

    private jumpToRootTarget(
        targetLines: readonly number[],
        direction: "previous" | "next",
    ): boolean {
        if (
            this.disposed ||
            targetLines.length === 0 ||
            this.renderEngine.hasVisibleOverlay()
        )
            return false;

        const start = this.renderEngine.currentVisibleRootStart;
        const candidates =
            direction === "previous"
                ? targetLines
                      .filter((line) => line < start)
                      .toSorted((a, b) => b - a)
                : targetLines
                      .filter((line) => line > start)
                      .toSorted((a, b) => a - b);

        for (const target of candidates) {
            const nextOffset = Math.max(
                0,
                Math.min(
                    this.renderEngine.currentLastRootLineCount -
                        Math.max(
                            1,
                            this.renderEngine.currentVisibleScrollableRows,
                        ) -
                        target,
                    this.renderEngine.currentMaxScrollOffset,
                ),
            );
            if (
                nextOffset === this.renderEngine.currentScrollOffset
            )
                continue;

            this.selectionManager.clearSelection();
            this.selectionManager.lastPress = null;
            this.selectionManager.leftPressLocation = null;
            this.selectionManager.hadDrag = false;
            this.renderEngine.currentScrollOffset = nextOffset;
            this.requestRender();
            return true;
        }

        return false;
    }

    // ── Private: terminal write interception ──────────────────

    private write(data: string): void {
        if (
            this.disposed ||
            this.writing ||
            this.renderEngine.hasVisibleOverlay()
        ) {
            this.originalWrite(data);
            return;
        }

        this.writing = true;
        try {
            this.renderEngine.write(data);
        } finally {
            this.writing = false;
        }
    }

    // ── Private: utilities ────────────────────────────────────

    requestRender(): void {
        this.tui.requestRender();
    }

    private repaint(): void {
        if (this.disposed) return;
        const width = this.renderEngine.getSidebarLayout().mainWidth;
        this.renderEngine.repaintScrollableViewport(width);
    }

    private restoreTerminalStateForExit(): void {
        try {
            this.originalWrite(
                this.modeManager.restoreTerminalStateForExit(),
            );
        } catch {
            // Process-exit cleanup cannot report useful errors and must not throw.
        }
    }

    private getSelectedText(): string {
        return this.selectionManager.getSelectedText(
            this.renderEngine.currentRootLines,
            this.renderEngine.currentVisibleClusterLines,
        );
    }
}
