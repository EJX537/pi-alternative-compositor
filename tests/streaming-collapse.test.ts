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
            renderCluster: () => ({ lines: [] as string[], cursor: null }),
        },
        writes,
    };
}

describe("Streaming collapse regressions", () => {
    it("can click a nested tool after its parent assistant grows during streaming", () => {
        const { options } = createOptions();

        const expanded: boolean[] = [];
        const tool = {
            toolCallId: "tool-streaming",
            toolName: "bash",
            expanded: true,
            setExpanded: (value: boolean) => expanded.push(value),
            render: () => ["tool output line"],
        };

        const assistant = {
            lastMessage: {
                role: "assistant" as const,
                id: "msg-1",
                content: ["assistant header"],
            },
            hideThinkingBlock: false,
            setHideThinkingBlock: () => {},
            children: [tool],
            render: function () {
                return [...this.lastMessage.content, ...tool.render()];
            },
        };

        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [assistant];
        tui.render = () => assistant.render();

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

        // Simulate streaming: assistant content grows, tool output stays the same.
        assistant.lastMessage.content = [
            "assistant header",
            "streaming line 1",
            "streaming line 2",
        ];
        tui.render(80);

        // The tool output is now at root line 3 (0-indexed).
        const ranges = compositor.getRootComponentLineRanges();
        const toolRanges = ranges
            .filter((r) => r.component === tool)
            .map((r) => ({ startLine: r.startLine, lineCount: r.lineCount }));
        expect(toolRanges).toEqual([{ startLine: 3, lineCount: 1 }]);

        const sm = (compositor as unknown as { selectionManager: { leftPressLocation: unknown; hadDrag: boolean; isDragging: boolean } }).selectionManager;
        internal.handleMousePacket({ code: 0, col: 1, row: 4, final: "M" });
        expect(sm.isDragging).toBe(true);
        internal.handleMousePacket({ code: 0, col: 1, row: 4, final: "m" });
        expect(sm.hadDrag).toBe(false);

        expect(expanded).toEqual([false]);

        compositor.dispose();
    });

    it("can click a tool inside a newly added message", () => {
        const { options } = createOptions();

        const expanded: boolean[] = [];
        const tool = {
            toolCallId: "tool-new-message",
            toolName: "bash",
            expanded: true,
            setExpanded: (value: boolean) => expanded.push(value),
            render: () => ["tool output line"],
        };

        const newMessage = {
            lastMessage: {
                role: "assistant" as const,
                id: "msg-new",
                content: ["new message header"],
            },
            hideThinkingBlock: false,
            setHideThinkingBlock: () => {},
            children: [tool],
            render: function () {
                return [...this.lastMessage.content, ...tool.render()];
            },
        };

        const oldMessage = {
            lastMessage: {
                role: "assistant" as const,
                id: "msg-old",
                content: ["old message"],
            },
            hideThinkingBlock: false,
            setHideThinkingBlock: () => {},
            render: function () {
                return this.lastMessage.content;
            },
        };

        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [oldMessage];
        tui.render = () =>
            tui.children.flatMap((c: { render: () => string[] }) => c.render());

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

        // A new message arrives.
        tui.children = [oldMessage, newMessage];
        tui.render(80);

        // The new message's tool is at root line 2 (old message line 1 + new header line 1).
        const ranges = compositor.getRootComponentLineRanges();
        expect(ranges).toContainEqual(
            expect.objectContaining({
                component: tool,
                startLine: 2,
                lineCount: 1,
            }),
        );

        internal.handleMousePacket(leftPress(3, 1));
        internal.handleMousePacket(leftRelease(3, 1));

        expect(expanded).toEqual([false]);

        compositor.dispose();
    });

});
