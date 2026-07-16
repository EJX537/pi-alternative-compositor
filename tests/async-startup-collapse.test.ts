/**
 * Test: Collapse on async startup path.
 *
 * All existing tests call tui.render(80) explicitly between compositor.install()
 * and the mouse click. This test reproduces the PRODUCTION startup scenario:
 * compositor.install() is called but only tui.requestRender() (a no-op mock)
 * follows — mimicking the real startup where doRender fires asynchronously.
 */
import { describe, expect, it } from "vitest";
import { TerminalSplitCompositor } from "../src/terminal/controller";
import type { TerminalSplitCompositorOptions } from "../src/terminal/types";

// SGR mouse helpers.
const leftPress = (row: number, col: number) => ({
    code: 0,
    col,
    row,
    final: "M" as const,
});
const leftRelease = (row: number, col: number) => ({
    code: 0,
    col,
    row,
    final: "m" as const,
});

function createOptions(): {
    options: TerminalSplitCompositorOptions;
    writes: string[];
} {
    const writes: string[] = [];
    const terminal = {
        columns: 80,
        rows: 24,
        modifyOtherKeysActive: false,
        write: (data: string) => writes.push(data),
    };
    const tui = {
        terminal,
        children: [] as unknown[],
        focusedComponent: null,
        hardwareCursorRow: 1,
        cursorRow: 0,
        previousViewportTop: 0,
        previousLines: [] as string[],
        previousKittyImageIds: new Set<number>(),
        previousWidth: 0,
        previousHeight: 0,
        maxLinesRendered: 0,
        requestRender: () => {},
        addInputListener: () => () => {},
        hasOverlay: () => false,
        render: () => [] as string[],
        getShowHardwareCursor: () => false,
        doRender: () => {},
        compositeLineAt: (baseLine: string) => baseLine,
        overlayStack: [],
        collectKittyImageIds: () => new Set<number>(),
    };

    return {
        options: {
            tui: tui as unknown as TerminalSplitCompositorOptions["tui"],
            terminal: terminal as unknown as TerminalSplitCompositorOptions["terminal"],
            renderCluster: () => ({ lines: [], cursor: null }),
        },
        writes,
    };
}

describe("Async-startup collapse", () => {
    it("(a) click-to-collapse FAILS when no explicit render() has populated state", () => {
        const { options } = createOptions();

        const expanded: boolean[] = [];
        const tool = {
            toolCallId: "tool-async",
            toolName: "read",
            expanded: true,
            setExpanded: (value: boolean) => expanded.push(value),
            render: () => ["tool output"],
        };

        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
            requestRender: () => void;
        };
        tui.children = [tool];
        tui.render = () => tool.render();

        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            handleMousePacket(packet: {
                code: number;
                col: number;
                row: number;
                final: "M" | "m";
            }): void;
            renderEngine: {
                currentVisibleScrollableRows: number;
                currentVisibleRootStart: number;
                currentRootComponentLineRanges: unknown[];
            };
        };

        compositor.install();

        // ── THE BUG: only requestRender() — a no-op — is called ──
        tui.requestRender();

        // The fix eagerly calls refreshRootWindow during install(),
        // so visibleScrollableRows AND rootComponentLineRanges are
        // populated immediately — no need to wait for an async render.

        expect(internal.renderEngine.currentVisibleScrollableRows).toBeGreaterThan(0);
        expect(
            internal.renderEngine.currentRootComponentLineRanges.length,
        ).toBeGreaterThan(0);

        // Clicking the tool now works immediately after install,
        // even though tui.requestRender() is a no-op mock.
        internal.handleMousePacket(leftPress(1, 1));
        internal.handleMousePacket(leftRelease(1, 1));

        expect(expanded).toEqual([false]);

        compositor.dispose();
    });

    it("(b) requestRender() is a no-op — does NOT populate component state", () => {
        const { options } = createOptions();

        const tool = {
            toolCallId: "tool-probe",
            toolName: "read",
            expanded: true,
            setExpanded: () => {},
            render: () => ["tool output"],
        };

        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [tool];
        tui.render = () => tool.render();

        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            renderEngine: {
                currentVisibleScrollableRows: number;
                currentVisibleRootStart: number;
                currentRootComponentLineRanges: unknown[];
            };
        };

        compositor.install();

        // The fix eagerly calls refreshRootWindow during install(),
        // so ALL hit-testing state is populated immediately.
        expect(internal.renderEngine.currentVisibleScrollableRows).toBeGreaterThan(0);
        expect(
            internal.renderEngine.currentRootComponentLineRanges.length,
        ).toBeGreaterThan(0);

        compositor.dispose();
    });

    it("(c) on event.reason='new' there are NO collapsible components in the chat", () => {
        // This test demonstrates that on a truly new session, the TUI has no
        // children with collapsible properties (no assistant components, no
        // tool components), so even if rendering works, there's nothing to
        // toggle — clicks silently do nothing.
        const { options } = createOptions();

        // Plain content component — not collapsible.
        const plain = {
            render: () => ["hello from a new session"],
        };

        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [plain];
        tui.render = () => plain.render();

        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            handleMousePacket(packet: {
                code: number;
                col: number;
                row: number;
                final: "M" | "m";
            }): void;
        };

        compositor.install();
        tui.render(80);

        // Even after render, the plain component is NOT collapsible.
        const ranges = compositor.getRootComponentPathAtLine(0);
        expect(ranges.length).toBeGreaterThan(0);
        for (const range of ranges) {
            expect(
                compositor.collapseState.isCollapsibleComponent(range.component),
            ).toBe(false);
        }

        // Click does nothing — there's nothing collapsible.
        internal.handleMousePacket(leftPress(1, 1));
        internal.handleMousePacket(leftRelease(1, 1));

        // No error, just no-op.
        compositor.dispose();
    });

    it("(d) mouse events arrive BEFORE first render → location.area is NOT 'root'", () => {
        const { options } = createOptions();

        const tool = {
            toolCallId: "tool-race",
            toolName: "read",
            expanded: true,
            setExpanded: () => {},
            render: () => ["tool output"],
        };

        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [tool];
        tui.render = () => tool.render();

        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            handleMousePacket(packet: {
                code: number;
                col: number;
                row: number;
                final: "M" | "m";
            }): void;
            renderEngine: {
                currentVisibleScrollableRows: number;
                currentVisibleRootStart: number;
            };
            selectionManager: {
                selectionLocationForPacket: (
                    packetRow: number,
                    packetCol: number,
                    visibleRootStart: number,
                    visibleScrollableRows: number,
                    visibleClusterLines: string[],
                    sidebarMainWidth: number,
                ) => unknown;
            };
        };

        compositor.install();

        // Capture the pre-render state
        const visibleScrollableRowsBefore =
            internal.renderEngine.currentVisibleScrollableRows;
        const visibleRootStartBefore =
            internal.renderEngine.currentVisibleRootStart;

        // Simulate a mouse event arriving before any render has populated state
        const location = internal.selectionManager.selectionLocationForPacket(
            1, // row 1 (top of terminal)
            1, // col 1
            visibleRootStartBefore,
            visibleScrollableRowsBefore,
            [], // empty cluster lines
            80, // mainWidth
        );

        // With the fix, visibleScrollableRows is eagerly populated during
        // install(), so location maps to area "root" instead of null.
        expect(location).not.toBeNull();
        expect(location!.area).toBe("root");

        compositor.dispose();
    });
});
