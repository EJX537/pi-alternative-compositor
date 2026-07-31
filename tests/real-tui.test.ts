/**
 * Real-TUI harness: the actual `TUI` class from @earendil-works/pi-tui,
 * driven against an in-memory xterm.js-backed VirtualTerminal.
 *
 * Unlike the mocked-TUI tests in compositor.test.ts, these exercise the
 * compositor's monkey-patches against pi's real internals (doRender,
 * requestRender, addInputListener, compositeLineAt, terminal.rows/columns,
 * previousLines bookkeeping) and assert on the *decoded screen* the
 * terminal emulator produces from the emitted bytes.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    Container,
    resetCapabilitiesCache,
    setCapabilities,
    Text,
    TUI,
    type Terminal,
} from "@earendil-works/pi-tui";
import { TerminalSplitCompositor } from "../src/terminal/controller.js";
import type { TerminalSplitCompositorOptions } from "../src/terminal/types.js";
import type { TuiInternals } from "../src/pi/internals.js";
import { VirtualTerminal } from "./virtual-terminal.js";

const ALT_SCREEN_KEY = Symbol.for(
    "pi-fixed-editor-compositor.alternateScreenActive",
);

interface Harness {
    terminal: VirtualTerminal;
    tui: TUI;
    compositor: TerminalSplitCompositor;
    root: Container;
}

const harnesses: Harness[] = [];

function createHarness(options: {
    cols?: number;
    rows?: number;
    clusterLines?: string[];
} = {}): Harness {
    const { cols = 80, rows = 24, clusterLines = ["[editor]"] } = options;
    const terminal = new VirtualTerminal(cols, rows);
    const tui = new TUI(terminal as Terminal);

    // Root chat content: a container with one text message (no padding,
    // so the rendered line is exactly the content).
    const root = new Container();
    root.addChild(new Text("hello world", 0, 0));
    tui.addChild(root);

    const compositor = new TerminalSplitCompositor({
        tui: tui as unknown as TuiInternals,
        terminal: terminal as unknown as TerminalSplitCompositorOptions["terminal"],
        renderCluster: () => ({ lines: clusterLines, cursor: null }),
        mouseScroll: false,
    });
    // children[0] is the scrollable root; everything after is the fixed
    // cluster (in prod, CompositorLifecycle computes this from the editor
    // container's position).
    compositor.setClusterStartIndex(1);

    const harness = { terminal, tui, root, compositor };
    harnesses.push(harness);
    return harness;
}

beforeAll(() => {
    // No image protocol / truecolor: keeps TUI.start() from emitting
    // terminal queries (CSI 16 t) and makes the output deterministic.
    resetCapabilitiesCache();
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
});

beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any)[ALT_SCREEN_KEY];
});

afterEach(() => {
    while (harnesses.length > 0) {
        const harness = harnesses.pop()!;
        try {
            harness.compositor.dispose();
        } finally {
            harness.tui.stop();
        }
    }
});

describe("TerminalSplitCompositor with a real TUI", () => {
    it("owns alternate-screen initialization", async () => {
        const { terminal, tui, compositor } = createHarness();

        // Prod order: the TUI starts before the extension installs.
        tui.start();
        compositor.install();
        // Let the throttled requestRender from start() land on the
        // compositor's patched doRender.
        await terminal.waitForRender();

        const installWrite = terminal.writes.find((write) =>
            write.includes("\x1b[?1049h"),
        );
        expect(installWrite).toBeDefined();
        expect(installWrite).toContain("\x1b[2J");

        compositor.dispose();
        expect(terminal.writes.at(-1)).toContain("\x1b[?1049l");
        expect(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any)[ALT_SCREEN_KEY],
        ).toBe(false);
    });

    it("pins the fixed cluster at the bottom of the emulated screen", async () => {
        const { terminal, tui, compositor } = createHarness({
            cols: 40,
            rows: 10,
            clusterLines: ["[editor]", "[footer]"],
        });

        tui.start();
        compositor.install();
        await terminal.waitForRender();

        const viewport = terminal.getViewport();
        // Root chat content renders at the top of the scrollable region.
        expect(viewport[0]).toBe("hello world");
        // The cluster (editor + footer) occupies the last two rows.
        expect(viewport[8]).toBe("[editor]");
        expect(viewport[9]).toBe("[footer]");

        // The cursor is parked in the cluster region, not at the end of
        // the root content.
        const cursor = terminal.getCursorPosition();
        expect(cursor.y).toBeGreaterThanOrEqual(8);
    });

    it("disposes back to the terminal's own write path", async () => {
        const { terminal, tui, compositor } = createHarness();
        tui.start();
        compositor.install();
        await terminal.waitForRender();

        compositor.dispose();

        // After dispose, TUI.stop() writes must go through the original
        // terminal (xterm buffer) and be recorded by the wrapper again.
        const writeCount = terminal.writes.length;
        tui.stop();
        expect(terminal.writes.length).toBeGreaterThan(writeCount);
    });
});
