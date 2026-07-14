import { describe, expect, it } from "vitest";
import { TerminalSplitCompositor } from "../src/terminal/controller";
import type { TerminalSplitCompositorOptions } from "../src/terminal/types";

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
        children: [],
        focusedComponent: null,
        hardwareCursorRow: 1,
        previousViewportTop: 0,
        requestRender: () => {},
        addInputListener: () => () => {},
        hasOverlay: () => false,
        render: () => [],
        getShowHardwareCursor: () => false,
        doRender: () => {},
        compositeLineAt: (baseLine: string) => baseLine,
        overlayStack: [],
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

describe("Collapse anchor bug fixes", () => {
    it("retains a collapsed cell in view when its top was at the viewport boundary", () => {
        // Bug: when a tool with renderable output children was collapsed,
        // the viewport anchor captured a child component that vanished after
        // collapse, leaving no valid anchor. scrollOffset went unadjusted,
        // clamping to 0 lost the collapsed cell.
        const { options } = createOptions();
        options.renderCluster = () => ({
            lines: Array.from({ length: 20 }, () => "cluster"),
            cursor: null,
        });

        const outputChildren = Array.from({ length: 50 }, (_, i) => ({
            render: () => [`tool output ${i}`],
        }));
        const tool = {
            toolCallId: "tool-bug-boundary",
            toolName: "read",
            expanded: true,
            setExpanded(this: { expanded: boolean }, value: boolean) {
                this.expanded = value;
            },
            children: outputChildren,
            render: () =>
                tool.expanded
                    ? outputChildren.flatMap((c: { render: () => string[] }) => c.render())
                    : ["tool collapsed"],
        };

        const before = {
            render: () => Array.from({ length: 10 }, (_, i) => `before ${i}`),
        };
        const after = Array.from({ length: 100 }, (_, i) => ({
            render: () => [`after ${i}`],
        }));

        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [before, tool, ...after];
        tui.render = () => [
            ...before.render(),
            ...tool.render(),
            ...after.flatMap((c) => c.render()),
        ];

        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            scrollBy(delta: number): void;
            visibleRootStart: number;
        };
        const cs = compositor as unknown as {
            collapseState: { toggle: (path: unknown[]) => boolean };
        };

        compositor.install();
        tui.render(80);

        // Total=160 lines. Scroll so tool's top (line 10) is at viewport boundary
        internal.scrollBy(146);
        tui.render(80);
        expect(internal.visibleRootStart).toBe(10);

        // Collapse the tool
        const path = compositor.getRootComponentPathAtLine(10);
        cs.collapseState.toggle(path);
        expect(tool.expanded).toBe(false);

        tui.render(80);

        // After collapse: total=111 lines. The collapsed tool at line 10
        // MUST remain in the viewport.
        expect(internal.visibleRootStart).toBeLessThanOrEqual(10);
        expect(internal.visibleRootStart + 4).toBeGreaterThan(10);

        const at10 = compositor.getRootComponentAtLine(10);
        expect(at10?.component).toBe(tool);
        expect(at10?.lineCount).toBe(1);

        compositor.dispose();
    });

    it("retains a collapsed cell when its top was just above the viewport", () => {
        // The collapse-specific snap handles this case — regression guard.
        const { options } = createOptions();
        options.renderCluster = () => ({
            lines: Array.from({ length: 20 }, () => "cluster"),
            cursor: null,
        });

        const outputChildren = Array.from({ length: 50 }, (_, i) => ({
            render: () => [`tool output ${i}`],
        }));
        const tool = {
            toolCallId: "tool-bug-above",
            toolName: "read",
            expanded: true,
            setExpanded(this: { expanded: boolean }, value: boolean) {
                this.expanded = value;
            },
            children: outputChildren,
            render: () =>
                tool.expanded
                    ? outputChildren.flatMap((c: { render: () => string[] }) => c.render())
                    : ["tool collapsed"],
        };

        const before = {
            render: () => Array.from({ length: 10 }, (_, i) => `before ${i}`),
        };
        const after = Array.from({ length: 100 }, (_, i) => ({
            render: () => [`after ${i}`],
        }));

        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [before, tool, ...after];
        tui.render = () => [
            ...before.render(),
            ...tool.render(),
            ...after.flatMap((c) => c.render()),
        ];

        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            scrollBy(delta: number): void;
            visibleRootStart: number;
        };
        const cs = compositor as unknown as {
            collapseState: { toggle: (path: unknown[]) => boolean };
        };

        compositor.install();
        tui.render(80);

        // Tool at lines 10-59, scroll so viewport starts at line 14
        internal.scrollBy(142);
        tui.render(80);
        expect(internal.visibleRootStart).toBe(14);

        // Collapse
        const path = compositor.getRootComponentPathAtLine(14);
        cs.collapseState.toggle(path);
        expect(tool.expanded).toBe(false);

        tui.render(80);

        // Collapsed cell must be visible
        expect(internal.visibleRootStart).toBeLessThanOrEqual(10);
        expect(internal.visibleRootStart + 4).toBeGreaterThan(10);
        const at10 = compositor.getRootComponentAtLine(10);
        expect(at10?.component).toBe(tool);
        expect(at10?.lineCount).toBe(1);

        compositor.dispose();
    });

    it("pins a collapsed cell to its original screen row when its top is inside the viewport", () => {
        const { options } = createOptions();
        options.renderCluster = () => ({
            lines: Array.from({ length: 20 }, () => "cluster"),
            cursor: null,
        });

        const tool = {
            toolCallId: "tool-in-viewport",
            toolName: "read",
            expanded: true,
            setExpanded(this: { expanded: boolean }, value: boolean) {
                this.expanded = value;
            },
            render: () =>
                tool.expanded
                    ? Array.from({ length: 10 }, (_, i) => `tool ${i}`)
                    : ["tool collapsed"],
        };

        const before = {
            render: () => Array.from({ length: 10 }, (_, i) => `before ${i}`),
        };
        const after = Array.from({ length: 20 }, (_, i) => ({
            render: () => [`after ${i}`],
        }));

        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [before, tool, ...after];
        tui.render = () => [
            ...before.render(),
            ...tool.render(),
            ...after.flatMap((c) => c.render()),
        ];

        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            scrollBy(delta: number): void;
            visibleRootStart: number;
        };
        const cs = compositor as unknown as {
            collapseState: { toggle: (path: unknown[]) => boolean };
        };

        compositor.install();
        tui.render(80);

        // Total=40 lines. ScrollableRows=4. Scroll so tool top (line 10) is at
        // screen row 2: start = 40 - 4 - offset = 8, so offset = 28.
        internal.scrollBy(28);
        tui.render(80);
        expect(internal.visibleRootStart).toBe(8);

        // Collapse the tool
        const path = compositor.getRootComponentPathAtLine(10);
        cs.collapseState.toggle(path);
        expect(tool.expanded).toBe(false);

        tui.render(80);

        // After collapse: total=31 lines. The tool header stays at screen row 2.
        expect(internal.visibleRootStart).toBe(8);

        compositor.dispose();
    });

    it("pins an expanded cell to its original screen row when its top is inside the viewport", () => {
        const { options } = createOptions();
        options.renderCluster = () => ({
            lines: Array.from({ length: 20 }, () => "cluster"),
            cursor: null,
        });

        const tool = {
            toolCallId: "tool-expand-in-viewport",
            toolName: "read",
            expanded: false,
            setExpanded(this: { expanded: boolean }, value: boolean) {
                this.expanded = value;
            },
            render: () =>
                tool.expanded
                    ? Array.from({ length: 10 }, (_, i) => `tool ${i}`)
                    : ["tool collapsed"],
        };

        const before = {
            render: () => Array.from({ length: 10 }, (_, i) => `before ${i}`),
        };
        const after = Array.from({ length: 20 }, (_, i) => ({
            render: () => [`after ${i}`],
        }));

        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [before, tool, ...after];
        tui.render = () => [
            ...before.render(),
            ...tool.render(),
            ...after.flatMap((c) => c.render()),
        ];

        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            scrollBy(delta: number): void;
            visibleRootStart: number;
        };
        const cs = compositor as unknown as {
            collapseState: { toggle: (path: unknown[]) => boolean };
        };

        compositor.install();
        tui.render(80);

        // Total=31 lines. Scroll so viewport starts at 8 (tool top at row 2).
        internal.scrollBy(19);
        tui.render(80);
        expect(internal.visibleRootStart).toBe(8);

        // Expand the tool
        const path = compositor.getRootComponentPathAtLine(10);
        cs.collapseState.toggle(path);
        expect(tool.expanded).toBe(true);

        tui.render(80);

        // After expand: total=40 lines. The tool header stays at screen row 2.
        expect(internal.visibleRootStart).toBe(8);

        compositor.dispose();
    });
});
