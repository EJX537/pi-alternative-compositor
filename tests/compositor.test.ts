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
        render: () => [],
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

describe("TerminalSplitCompositor installation", () => {
    it("owns alternate-screen initialization", () => {
        const { options, writes } = createOptions();
        const compositor = new TerminalSplitCompositor(options);

        compositor.install();
        compositor.dispose();

        expect(writes[0]).toContain("\x1b[?1049h");
        expect(writes[0]).toContain("\x1b[2J");
        expect(writes.at(-1)).toContain("\x1b[?1049l");
    });

    it("keeps the alternate screen active during live session replacement", () => {
        const { options, writes } = createOptions();
        const compositor = new TerminalSplitCompositor(options);

        compositor.install();
        compositor.dispose({ exitAlternateScreen: false });

        const cleanup = writes.at(-1) ?? "";
        expect(cleanup).toContain("\x1b[r");
        expect(cleanup).toContain("\x1b[?1006l\x1b[?1002l\x1b[?1003l\x1b[?1000l");
        expect(cleanup).toContain("\x1b[?1007h");
        expect(cleanup).not.toContain("\x1b[?1049l");

        const writeCount = writes.length;
        compositor.dispose();
        expect(writes).toHaveLength(writeCount);
    });

    it("avoids alternate-screen flicker across /reload", () => {
        const key = Symbol.for(
            "pi-fixed-editor-compositor.alternateScreenActive",
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (globalThis as any)[key];

        // First install: enters alternate screen and erases.
        const { options: options1, writes: writes1 } = createOptions();
        const compositor1 = new TerminalSplitCompositor(options1);
        compositor1.install();
        expect(writes1[0]).toContain("\x1b[?1049h");
        expect(writes1[0]).toContain("\x1b[2J");

        // Dispose for reload: emit nothing; leave modes for the next instance.
        compositor1.dispose({ reason: "reload" });
        const nonEmptyWrites1 = writes1.filter((w) => w.length > 0);
        expect(nonEmptyWrites1).toHaveLength(1);

        // New install after reload: do not re-enter or erase again.
        const { options: options2, writes: writes2 } = createOptions();
        const compositor2 = new TerminalSplitCompositor(options2);
        compositor2.install();
        const install2 = writes2[0] ?? "";
        expect(install2).not.toContain("\x1b[?1049h");
        expect(install2).not.toContain("\x1b[2J");
        expect(install2).not.toContain("\x1b[H");

        // Non-reload disposal still exits alternate screen and resets the flag.
        compositor2.dispose({ reason: "quit" });
        const cleanup2 = writes2.at(-1) ?? "";
        expect(cleanup2).toContain("\x1b[?1049l");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((globalThis as any)[key]).toBe(false);
    });

    it("forces the complete terminal-mode reset before exiting on process exit", () => {
        const { options, writes } = createOptions();
        (
            options.terminal as unknown as { kittyProtocolActive: boolean }
        ).kittyProtocolActive = true;
        const previousExitListeners = new Set(process.listeners("exit"));
        const compositor = new TerminalSplitCompositor(options);

        compositor.install();
        const emergencyCleanup = process
            .listeners("exit")
            .find((listener) => !previousExitListeners.has(listener));
        expect(emergencyCleanup).toBeTypeOf("function");

        // Invoke only the handler installed by this compositor: emitting the
        // process event would also run Vitest's own exit handlers.
        emergencyCleanup?.(0);
        process.removeListener("exit", emergencyCleanup!);

        const cleanup = writes.at(-1) ?? "";
        expect(cleanup).toContain("\x1b[r");
        expect(cleanup).toContain("\x1b[?1006l\x1b[?1002l\x1b[?1003l\x1b[?1000l");
        expect(cleanup).toContain("\x1b[<u");
        expect(cleanup).toContain("\x1b[?1007h");
        expect(cleanup).toContain("\x1b[?1049l");
        expect(cleanup).toContain("\x1b[<999u\x1b[>4;0m");
        expect(cleanup.indexOf("\x1b[r")).toBeLessThan(
            cleanup.indexOf("\x1b[?1006l"),
        );
        expect(cleanup.indexOf("\x1b[?1007h")).toBeLessThan(
            cleanup.indexOf("\x1b[?1049l"),
        );

        compositor.dispose();
    });

    it("maps every root child to its flattened line range", () => {
        const { options } = createOptions();
        const prefix = { render: () => ["status"] };
        const chat = { render: () => ["message one", "message two"] };
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [prefix, chat];
        tui.render = () => ["status", "message one", "message two"];
        const compositor = new TerminalSplitCompositor(options);

        compositor.install();
        tui.render(80);

        expect(compositor.getRootComponentLineRanges()).toEqual([
            { component: prefix, startLine: 0, lineCount: 1 },
            { component: chat, startLine: 1, lineCount: 2 },
        ]);
        expect(compositor.getRootComponentAtLine(2)?.component).toBe(chat);
        expect(compositor.getRootComponentAtLine(3)).toBeNull();

        compositor.dispose();
    });

    it("resolves the innermost verified nested component for a root line", () => {
        const { options } = createOptions();
        const tool = { render: () => ["tool line"] };
        const message = {
            children: [tool],
            render: () => tool.render(80),
        };
        const chat = {
            children: [message],
            render: () => message.render(80),
        };
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [chat];
        tui.render = () => chat.render(80);
        const compositor = new TerminalSplitCompositor(options);

        compositor.install();
        tui.render(80);

        expect(compositor.getRootComponentAtLine(0)?.component).toBe(tool);
        expect(
            compositor.getRootComponentPathAtLine(0).map(
                (range) => range.component,
            ),
        ).toEqual([chat, message, tool]);
        expect(compositor.getRootComponentLineRanges()).toHaveLength(3);
        compositor.dispose();
    });

    it("collapses an addressed tool with a single left click without changing drag selection", () => {
        const { options } = createOptions();
        const expanded: boolean[] = [];
        const tool = {
            toolCallId: "tool-1",
            toolName: "read",
            expanded: true,
            setExpanded: (value: boolean) => expanded.push(value),
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
            handleMousePacket(packet: { code: number; col: number; row: number; final: "M" | "m" }): void;
            selectionDragging: boolean;
        };

        compositor.install();
        tui.render(80);
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "m" });
        expect(expanded).toEqual([false]);
        expect(internal.selectionDragging).toBe(false);

        tool.expanded = false;
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "m" });
        expect(expanded).toEqual([false, true]);

        // A bare drag still starts and finishes a selection on non-collapsible
        // content without toggling anything.
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 32, col: 4, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 4, row: 1, final: "m" });
        expect(internal.selectionDragging).toBe(false);
        compositor.dispose();
    });

    it("toggles collapse again after expanding changes the component size", () => {
        const { options } = createOptions();
        const expanded: boolean[] = [];
        const tool = {
            toolCallId: "tool-resize",
            toolName: "read",
            expanded: false,
            setExpanded: (value: boolean) => expanded.push(value),
            render: () =>
                tool.expanded
                    ? ["expanded line 1", "expanded line 2", "expanded line 3"]
                    : ["collapsed"],
        };
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [tool];
        tui.render = () => tool.render();
        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            handleMousePacket(packet: { code: number; col: number; row: number; final: "M" | "m" }): void;
        };

        compositor.install();
        tui.render(80);

        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "m" });
        expect(expanded.at(-1)).toBe(true);

        tui.render(80);

        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "m" });
        expect(expanded.at(-1)).toBe(false);

        compositor.dispose();
    });

    it("toggles collapse even with tiny mouse drift during the click", () => {
        const { options } = createOptions();
        const expanded: boolean[] = [];
        const tool = {
            toolCallId: "tool-drift",
            toolName: "read",
            expanded: true,
            setExpanded: (value: boolean) => expanded.push(value),
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
            handleMousePacket(packet: { code: number; col: number; row: number; final: "M" | "m" }): void;
        };

        compositor.install();
        tui.render(80);

        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 32, col: 2, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 2, row: 1, final: "m" });
        expect(expanded.at(-1)).toBe(false);

        compositor.dispose();
    });

    it("jumps the viewport to a collapsed cell that was far above", () => {
        const { options } = createOptions();
        options.renderCluster = () => ({
            lines: Array.from({ length: 20 }, () => "cluster"),
            cursor: null,
        });
        const tool = {
            toolCallId: "tool-far-above",
            toolName: "read",
            expanded: true,
            setExpanded: () => {},
            render: () =>
                tool.expanded
                    ? Array.from({ length: 10 }, (_, i) => `tool ${i}`)
                    : ["tool collapsed"],
        };
        const filler = {
            render: () => Array.from({ length: 10 }, (_, i) => `filler ${i}`),
        };
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [tool, filler];
        tui.render = () => [
            ...tool.render(),
            ...filler.render(),
        ];
        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            collapseState: { toggle: (path: unknown[]) => boolean };
            visibleRootStart: number;
        };

        compositor.install();
        tui.render(80);

        // Viewport starts near the bottom; the tool is above the visible area.
        expect(internal.visibleRootStart).toBeGreaterThan(0);

        // Collapse the tool via the extension state (simulates a click or
        // keyboard action on the tool even when it is above the viewport).
        const path = compositor.getRootComponentPathAtLine(0);
        internal.collapseState.toggle(path);
        tui.render(80);

        // The viewport should jump so the now-collapsed tool is at the top.
        expect(internal.visibleRootStart).toBe(0);
        expect(compositor.getRootComponentAtLine(0)?.component).toBe(tool);

        compositor.dispose();
    });

    it("prefers a tool over its enclosing assistant and restores collapse after rebuild", () => {
        const { options } = createOptions();
        const hidden: boolean[] = [];
        const expanded: boolean[] = [];
        const tool = {
            toolCallId: "tool-2",
            toolName: "bash",
            expanded: true,
            setExpanded: (value: boolean) => expanded.push(value),
            render: () => ["tool output"],
        };
        const assistant = {
            lastMessage: { role: "assistant", id: "message-1" },
            hideThinkingBlock: false,
            setHideThinkingBlock: (value: boolean) => hidden.push(value),
            children: [tool],
            render: () => tool.render(),
        };
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        let current: { render: () => string[] } = assistant;
        tui.children = [assistant];
        tui.render = () => current.render();
        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            handleMousePacket(packet: { code: number; col: number; row: number; final: "M" | "m" }): void;
        };

        compositor.install();
        tui.render(80);
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "m" });
        expect(expanded).toEqual([false]);
        expect(hidden).toEqual([]);

        const rebuiltHidden: boolean[] = [];
        const rebuilt = {
            lastMessage: { role: "assistant", id: "message-1" },
            hideThinkingBlock: false,
            setHideThinkingBlock: (value: boolean) => rebuiltHidden.push(value),
            render: () => ["thinking"],
        };
        // Toggle thinking on the original message, then emulate Pi recreating it.
        tui.children = [assistant];
        assistant.children = [];
        assistant.render = () => ["thinking"];
        assistant.hideThinkingBlock = false;
        tui.render(80);
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "m" });
        expect(hidden).toEqual([true]);
        current = rebuilt;
        tui.children = [rebuilt];
        tui.render(80);
        expect(rebuiltHidden).toContain(true);
        compositor.dispose();
    });

    it("copies selected text on right-click", () => {
        const { options } = createOptions();
        const copiedTexts: string[] = [];
        options.onCopySelection = (text: string) => copiedTexts.push(text);

        const rootChild = { render: () => ["selectable text here"] };
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [rootChild];
        tui.render = () => rootChild.render();
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

        // Left-press at column 1, drag to column 11, release at column 11
        // to select the first 10 characters ("selectable").
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 32, col: 11, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 11, row: 1, final: "m" });

        // Right-click inside the selected range.
        internal.handleMousePacket({ code: 2, col: 5, row: 1, final: "M" });

        // onCopySelection fires once on left-release and once on right-click.
        expect(copiedTexts).toEqual(["selectable", "selectable"]);
        expect(
            compositor.selectionManager.getSelectedText(
                tui.render(),
                [],
            ),
        ).toBe("");

        compositor.dispose();
    });

    it("toggles a tool through multiple clicks even when Pi rebuilds it with a default expanded state", () => {
        const { options } = createOptions();
        const expanded: boolean[] = [];
        const makeTool = () => ({
            toolCallId: "tool-multi",
            toolName: "read",
            // Pi may rebuild the component without preserving the last expanded
            // value, so the compositor must rely on its local override.
            expanded: true,
            setExpanded: (value: boolean) => expanded.push(value),
            render: () => ["tool output"],
        });
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        let tool = makeTool();
        tui.children = [tool];
        tui.render = () => tool.render();
        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            handleMousePacket(packet: { code: number; col: number; row: number; final: "M" | "m" }): void;
        };

        compositor.install();
        tui.render(80);

        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "m" });
        expect(expanded.at(-1)).toBe(false);

        // Simulate Pi recreating the component with its default expanded state.
        tool = makeTool();
        tui.children = [tool];
        tui.render(80);
        expanded.length = 0;
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "m" });
        expect(expanded.at(-1)).toBe(true);

        tool = makeTool();
        tui.children = [tool];
        tui.render(80);
        expanded.length = 0;
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "m" });
        expect(expanded.at(-1)).toBe(false);

        compositor.dispose();
    });

    it("toggles an assistant message through multiple clicks even when Pi rebuilds it", () => {
        const { options } = createOptions();
        const hidden: boolean[] = [];
        const makeAssistant = () => ({
            lastMessage: { role: "assistant", id: "msg-multi" },
            hideThinkingBlock: false,
            setHideThinkingBlock: (value: boolean) => hidden.push(value),
            render: () => ["thinking"],
        });
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        let assistant = makeAssistant();
        tui.children = [assistant];
        tui.render = () => assistant.render();
        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            handleMousePacket(packet: { code: number; col: number; row: number; final: "M" | "m" }): void;
        };

        compositor.install();
        tui.render(80);

        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "m" });
        expect(hidden.at(-1)).toBe(true);

        assistant = makeAssistant();
        tui.children = [assistant];
        tui.render(80);
        hidden.length = 0;
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "m" });
        expect(hidden.at(-1)).toBe(false);

        assistant = makeAssistant();
        tui.children = [assistant];
        tui.render(80);
        hidden.length = 0;
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "m" });
        expect(hidden.at(-1)).toBe(true);

        compositor.dispose();
    });

    it("ignores single clicks for unknown components, sidebar clicks, and malformed packets", () => {
        const { options } = createOptions();
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [{ render: () => ["plain"] }];
        tui.render = () => ["plain"];
        options.sidebar = { breakpoint: "sm", render: () => ["side"] };
        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            handleMousePacket(packet: { code: number; col: number; row: number; final: "M" | "m" }): void;
        };

        compositor.install();
        tui.render(54);
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 1, row: 1, final: "m" });
        internal.handleMousePacket({ code: 0, col: 80, row: 1, final: "M" });
        internal.handleMousePacket({ code: 0, col: 80, row: 1, final: "m" });
        internal.handleMousePacket({ code: Number.NaN, col: 1, row: 1, final: "M" });
        expect(compositor.getRootComponentPathAtLine(9)).toEqual([]);
        compositor.dispose();
    });

    it("does not apply hover highlight on mouse motion (feature removed)", () => {
        const { options } = createOptions();
        const assistant = {
            lastMessage: { role: "assistant", id: "msg-hover" },
            hideThinkingBlock: false,
            setHideThinkingBlock: () => {},
            render: () => ["assistant line"],
        };
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [assistant];
        tui.render = () => assistant.render();
        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            handleMousePacket(packet: { code: number; col: number; row: number; final: "M" | "m" }): void;
        };

        compositor.install();
        const linesBefore = tui.render(80);
        expect(linesBefore[0]).not.toContain("\x1b[48;5;240m");

        // Mouse motion events should NOT produce hover highlight.
        internal.handleMousePacket({ code: 35, col: 1, row: 1, final: "M" });
        expect(tui.render(80)[0]).not.toContain("\x1b[48;5;240m");
        compositor.dispose();
    });

    it("records every root-child range while limiting descendant mapping to the visible window plus overscan", () => {
        const { options } = createOptions();
        const children = Array.from({ length: 100 }, (_, index) => ({
            id: index,
            render: () => [`line ${index}`],
        }));
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = children;
        tui.render = () => children.flatMap((child) => child.render());
        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            scrollBy(delta: number): void;
        };

        compositor.install();
        tui.render(80);
        const initialRanges = compositor.getRootComponentLineRanges();
        expect(initialRanges.length).toBe(100);

        internal.scrollBy(50);
        const scrolledRanges = compositor.getRootComponentLineRanges();
        expect(scrolledRanges.length).toBe(100);
        expect(scrolledRanges.some((range) => range.startLine >= 40)).toBe(true);
        compositor.dispose();
    });

    it("keeps the line map for hit-testing but marks it untrusted when root flattening differs", () => {
        const { options } = createOptions();
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [{ render: () => ["child"] }];
        tui.render = () => ["different", "flattening"];
        const compositor = new TerminalSplitCompositor(options);

        compositor.install();
        tui.render(80);

        // The map is kept so hover/click collapse still has something to hit.
        expect(compositor.getRootComponentLineRanges().length).toBeGreaterThan(
            0,
        );
        compositor.dispose();
    });

    it("keeps the top component anchored when later root content shrinks", () => {
        const { options } = createOptions();
        options.renderCluster = () => ({
            lines: Array.from({ length: 20 }, () => "editor"),
            cursor: null,
        });
        const prefix = { render: () => ["header", "prompt"] };
        let chatLines = Array.from({ length: 8 }, (_, index) => `message ${index}`);
        const chat = { render: () => chatLines };
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [prefix, chat];
        tui.render = () => [...prefix.render(), ...chat.render()];
        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            scrollBy(delta: number): void;
            visibleRootStart: number;
        };

        compositor.install();
        tui.render(80);
        internal.scrollBy(4);
        expect(internal.visibleRootStart).toBe(2);

        chatLines = chatLines.slice(0, 4);
        tui.render(80);

        // The chat component was at the top of the viewport. Its first line
        // stays there even though content below it collapsed.
        expect(internal.visibleRootStart).toBe(2);
        expect(compositor.getRootComponentAtLine(2)?.component).toBe(chat);
        compositor.dispose();
    });

    it("reserves columns and paints the sidebar at the physical right edge", () => {
        const { options, writes } = createOptions();
        options.renderCluster = () => ({ lines: ["editor"], cursor: null });
        let visible = true;
        options.sidebar = {
            breakpoint: "sm",
            visible: () => visible,
            render: () => ["sidebar"],
        };
        const compositor = new TerminalSplitCompositor(options);

        compositor.install();
        expect(options.terminal.columns).toBe(54);
        visible = false;
        expect(options.terminal.columns).toBe(80);
        visible = true;

        options.terminal.write("root");
        expect(writes.at(-1)).toContain("\x1b[1;55H\x1b[Ksidebar");

        compositor.dispose();
        expect(options.terminal.columns).toBe(80);
    });

    it("lets a full-width Pi overlay cover the compositor sidebar", () => {
        const { options, writes } = createOptions();
        const tui = options.tui as unknown as {
            hasOverlay: () => boolean;
            doRender: () => void;
        };
        tui.hasOverlay = () => true;
        options.renderCluster = () => ({ lines: ["editor"], cursor: null });
        options.sidebar = {
            breakpoint: "sm",
            render: () => ["sidebar"],
        };
        const compositor = new TerminalSplitCompositor(options);

        compositor.install();
        // The overlay sees the physical terminal rather than the narrowed pane.
        expect(options.terminal.columns).toBe(80);
        const overlayBaseFrame = (
            options.tui as unknown as { render: (width: number) => string[] }
        ).render(80);
        expect(overlayBaseFrame).toHaveLength(24);
        expect(overlayBaseFrame[0]).toContain("sidebar");

        const writesBeforeOverlayRender = writes.length;
        tui.doRender();
        expect(writes).toHaveLength(writesBeforeOverlayRender);
        compositor.dispose();
    });

    it("writes the terminal exactly once during a normal render frame", () => {
        const { options, writes } = createOptions();
        options.renderCluster = () => ({
            lines: ["cluster line"],
            cursor: null,
        });
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
            doRender: () => void;
        };
        tui.children = [{ render: () => ["root line"] }];
        tui.render = () => ["root line"];
        const compositor = new TerminalSplitCompositor(options);

        compositor.install();
        const writesBeforeRender = writes.length;
        tui.doRender();

        expect(writes).toHaveLength(writesBeforeRender + 1);
        const frame = writes.at(-1) ?? "";
        expect(frame).toContain("root line");
        expect(frame).toContain("cluster line");
        expect(frame).toContain("\x1b[?2026h");
        expect(frame).toContain("\x1b[?2026l");

        compositor.dispose();
    });

    it("updates Pi bookkeeping after a compositor-owned render", () => {
        const { options, writes } = createOptions();
        options.renderCluster = () => ({
            lines: ["editor"],
            cursor: null,
        });
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
            doRender: () => void;
            hardwareCursorRow: number;
            previousViewportTop: number;
            previousWidth: number;
            previousHeight: number;
            previousLines: string[];
        };
        tui.children = [
            { render: () => ["one", "two", "three"] },
        ];
        tui.render = () => ["one", "two", "three"];
        const compositor = new TerminalSplitCompositor(options);

        compositor.install();
        tui.doRender();

        expect(writes).toHaveLength(2); // install sequence + one frame write
        // visibleRootLines is padded to the scrollable height (23 rows here),
        // so Pi's cursor/viewport bookkeeping reflects the padded viewport.
        expect(tui.hardwareCursorRow).toBe(22);
        expect(tui.previousViewportTop).toBe(0);
        expect(tui.previousWidth).toBe(80);
        expect(tui.previousHeight).toBe(24);
        expect(tui.previousLines.slice(0, 3)).toEqual([
            "one",
            "two",
            "three",
        ]);
        expect(tui.previousLines).toHaveLength(23);

        compositor.dispose();
    });

    it("falls back to Pi's renderer when an overlay is visible", () => {
        const { options, writes } = createOptions();
        options.renderCluster = () => ({
            lines: ["editor"],
            cursor: null,
        });
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
            doRender: () => void;
            hasOverlay: () => boolean;
        };
        let piRenderCalls = 0;
        const originalDoRender = tui.doRender;
        tui.doRender = () => {
            piRenderCalls += 1;
            originalDoRender();
        };
        tui.hasOverlay = () => true;
        tui.children = [{ render: () => ["root"] }];
        tui.render = () => ["root"];
        const compositor = new TerminalSplitCompositor(options);

        compositor.install();
        const writesBeforeRender = writes.length;
        tui.doRender();

        expect(piRenderCalls).toBe(1);
        expect(writes).toHaveLength(writesBeforeRender);

        compositor.dispose();
    });
});

describe("drag-selection viewport-edge auto-scroll", () => {
    it("scrolls up by one line at the top edge while preserving the selection", () => {
        const { options } = createOptions();
        const lines = Array.from({ length: 50 }, (_, index) => `line ${index}`);
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [{ render: () => lines }];
        tui.render = () => lines;
        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            handleMousePacket(packet: {
                code: number;
                col: number;
                row: number;
                final: "M" | "m";
            }): void;
            selectionManager: {
                anchor: { line: number; col: number } | null;
                focus: { line: number; col: number } | null;
                isDragging: boolean;
            };
            renderEngine: { currentScrollOffset: number };
        };

        compositor.install();
        tui.render(80);

        const initialOffset = internal.renderEngine.currentScrollOffset;

        // Press on the second visible row, then drag to the top edge.
        internal.handleMousePacket({ code: 0, col: 1, row: 2, final: "M" });
        internal.handleMousePacket({ code: 32, col: 1, row: 1, final: "M" });

        expect(internal.renderEngine.currentScrollOffset).toBe(
            initialOffset + 1,
        );
        expect(internal.selectionManager.isDragging).toBe(true);
        expect(internal.selectionManager.anchor).not.toBeNull();
        expect(internal.selectionManager.focus).not.toBeNull();

        compositor.dispose();
    });

    it("scrolls down by one line at the bottom edge while preserving the selection", () => {
        const { options } = createOptions();
        const lines = Array.from({ length: 50 }, (_, index) => `line ${index}`);
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [{ render: () => lines }];
        tui.render = () => lines;
        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            handleMousePacket(packet: {
                code: number;
                col: number;
                row: number;
                final: "M" | "m";
            }): void;
            scrollBy(delta: number): void;
            selectionManager: {
                anchor: { line: number; col: number } | null;
                focus: { line: number; col: number } | null;
                isDragging: boolean;
            };
            renderEngine: { currentScrollOffset: number };
        };

        compositor.install();
        tui.render(80);

        // Move away from the bottom so there is room to scroll down.
        internal.scrollBy(10);
        const offsetBeforeEdge = internal.renderEngine.currentScrollOffset;
        expect(offsetBeforeEdge).toBeGreaterThan(0);

        // Press in the middle of the viewport, then drag to the bottom edge.
        internal.handleMousePacket({ code: 0, col: 1, row: 5, final: "M" });
        internal.handleMousePacket({ code: 32, col: 1, row: 24, final: "M" });

        expect(internal.renderEngine.currentScrollOffset).toBe(
            offsetBeforeEdge - 1,
        );
        expect(internal.selectionManager.isDragging).toBe(true);
        expect(internal.selectionManager.anchor).not.toBeNull();
        expect(internal.selectionManager.focus).not.toBeNull();

        compositor.dispose();
    });

    it("does not auto-scroll when the drag is inside the viewport", () => {
        const { options } = createOptions();
        const lines = Array.from({ length: 50 }, (_, index) => `line ${index}`);
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [{ render: () => lines }];
        tui.render = () => lines;
        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            handleMousePacket(packet: {
                code: number;
                col: number;
                row: number;
                final: "M" | "m";
            }): void;
            selectionManager: {
                anchor: { line: number; col: number } | null;
                focus: { line: number; col: number } | null;
                isDragging: boolean;
            };
            renderEngine: { currentScrollOffset: number };
        };

        compositor.install();
        tui.render(80);

        const initialOffset = internal.renderEngine.currentScrollOffset;

        internal.handleMousePacket({ code: 0, col: 1, row: 5, final: "M" });
        internal.handleMousePacket({ code: 32, col: 10, row: 5, final: "M" });

        expect(internal.renderEngine.currentScrollOffset).toBe(initialOffset);
        expect(internal.selectionManager.isDragging).toBe(true);
        expect(internal.selectionManager.anchor).not.toBeNull();

        compositor.dispose();
    });

    it("wheel scroll still clears the active selection", () => {
        const { options } = createOptions();
        const lines = Array.from({ length: 50 }, (_, index) => `line ${index}`);
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [{ render: () => lines }];
        tui.render = () => lines;
        const compositor = new TerminalSplitCompositor(options);
        const internal = compositor as unknown as {
            handleMousePacket(packet: {
                code: number;
                col: number;
                row: number;
                final: "M" | "m";
            }): void;
            selectionManager: {
                anchor: { line: number; col: number } | null;
                focus: { line: number; col: number } | null;
                isDragging: boolean;
            };
        };

        compositor.install();
        tui.render(80);

        internal.handleMousePacket({ code: 0, col: 1, row: 5, final: "M" });
        internal.handleMousePacket({ code: 32, col: 10, row: 5, final: "M" });
        expect(internal.selectionManager.isDragging).toBe(true);
        expect(internal.selectionManager.anchor).not.toBeNull();

        internal.handleMousePacket({ code: 64, col: 1, row: 1, final: "M" });

        expect(internal.selectionManager.isDragging).toBe(false);
        expect(internal.selectionManager.anchor).toBeNull();
        expect(internal.selectionManager.focus).toBeNull();

        compositor.dispose();
    });
});

describe("root render cache", () => {
    it("invalidates a parent assistant when a nested tool is collapsed", () => {
        const { options } = createOptions();
        let assistantRenderCount = 0;

        const header = {
            render: () => ["assistant header"],
        };

        const tool = {
            toolCallId: "nested-tool",
            toolName: "read",
            expanded: true,
            setExpanded(value: boolean) {
                this.expanded = value;
            },
            render: () =>
                tool.expanded
                    ? ["tool expanded line 1", "tool expanded line 2"]
                    : ["tool collapsed"],
        };

        const assistant = {
            lastMessage: { role: "assistant" as const, id: "nested-assistant" },
            hideThinkingBlock: false,
            setHideThinkingBlock(value: boolean) {
                this.hideThinkingBlock = value;
            },
            children: [header, tool],
            render: () => {
                assistantRenderCount++;
                return [...header.render(80), ...tool.render(80)];
            },
        };

        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [assistant];
        tui.render = () => assistant.render(80);

        const compositor = new TerminalSplitCompositor(options);
        compositor.install();

        // First render: assistant renders with expanded tool (3 lines).
        const before = tui.render(80);
        expect(before[0]).toBe("assistant header");
        expect(before[1]).toBe("tool expanded line 1");
        expect(before[2]).toBe("tool expanded line 2");
        expect(assistantRenderCount).toBe(1);

        // Second render with unchanged state: cache hit, assistant not re-rendered.
        tui.render(80);
        expect(assistantRenderCount).toBe(1);

        // Collapse the nested tool.  The assistant's signature must change because
        // it includes its descendants, so the assistant re-renders.
        const path = compositor.getRootComponentPathAtLine(1);
        const internal = compositor as unknown as {
            collapseState: { toggle: (path: unknown[]) => boolean };
        };
        expect(internal.collapseState.toggle(path)).toBe(true);

        const after = tui.render(80);
        expect(after[0]).toBe("assistant header");
        expect(after[1]).toBe("tool collapsed");
        expect(after[2]).toBe("");
        expect(assistantRenderCount).toBe(2);

        // Range mapper should report the new, smaller line count.
        const ranges = compositor.getRootComponentLineRanges();
        const assistantRange = ranges.find(
            (range) => range.component === assistant,
        );
        expect(assistantRange?.lineCount).toBe(2);

        compositor.dispose();
    });

    it("re-renders an assistant message when its content length changes", () => {
        const { options } = createOptions();
        let assistantRenderCount = 0;
        const message = {
            role: "assistant" as const,
            id: "streaming-message",
            content: "hello",
        };
        const assistant = {
            lastMessage: message,
            hideThinkingBlock: false,
            setHideThinkingBlock(value: boolean) {
                this.hideThinkingBlock = value;
            },
            render: () => {
                assistantRenderCount++;
                return [message.content];
            },
        };
        const tui = options.tui as unknown as {
            children: unknown[];
            render: (width: number) => string[];
        };
        tui.children = [assistant];
        tui.render = () => assistant.render(80);

        const compositor = new TerminalSplitCompositor(options);
        compositor.install();

        const before = tui.render(80);
        expect(before[0]).toBe("hello");
        expect(assistantRenderCount).toBe(1);

        // Cached frame.
        tui.render(80);
        expect(assistantRenderCount).toBe(1);

        // Simulate streaming: content length changes.
        message.content = "hello world";
        const after = tui.render(80);
        expect(after[0]).toBe("hello world");
        expect(assistantRenderCount).toBe(2);

        compositor.dispose();
    });
});
