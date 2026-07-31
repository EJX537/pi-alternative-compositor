/**
 * In-memory Terminal for TUI tests, backed by @xterm/headless.
 *
 * Modeled on pi's own `packages/tui/test/virtual-terminal.ts`: the real
 * TUI's `write()` calls land in a real xterm.js buffer, so tests can
 * assert on the *decoded screen* (viewports, per-cell attributes, cursor
 * position) instead of raw escape bytes.  Also records every raw write
 * for byte-level assertions.
 */

import xterm from "@xterm/headless";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import type { Terminal } from "@earendil-works/pi-tui";
import type { TerminalInternals } from "../src/pi/internals.js";

export interface CursorPosition {
    x: number;
    y: number;
}

export class VirtualTerminal implements Terminal, TerminalInternals {
    private readonly xterm: XtermTerminal;
    private onInput: ((data: string) => void) | null = null;
    private onResize: (() => void) | null = null;

    /** Every raw byte string written to the terminal, in order. */
    readonly writes: string[] = [];

    constructor(columns = 80, rows = 24) {
        this.xterm = new xterm.Terminal({
            cols: columns,
            rows,
            disableStdin: true,
            allowProposedApi: true,
            scrollback: 1000,
        });
    }

    // ── Terminal interface ─────────────────────────────────────

    start(onInput: (data: string) => void, onResize: () => void): void {
        this.onInput = onInput;
        this.onResize = onResize;
    }

    stop(): void {
        this.onInput = null;
        this.onResize = null;
    }

    drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
        return Promise.resolve();
    }

    write(data: string): void {
        this.writes.push(data);
        this.xterm.write(data);
    }

    get columns(): number {
        return this.xterm.cols;
    }

    get rows(): number {
        return this.xterm.rows;
    }

    get kittyProtocolActive(): boolean {
        return false;
    }

    /** Private on ProcessTerminal; the compositor reads it for keyboard negotiation. */
    modifyOtherKeysActive = false;

    moveBy(lines: number): void {
        if (lines > 0) this.write(`\x1b[${lines}B`);
        else if (lines < 0) this.write(`\x1b[${-lines}A`);
    }

    hideCursor(): void {
        this.write("\x1b[?25l");
    }

    showCursor(): void {
        this.write("\x1b[?25h");
    }

    clearLine(): void {
        this.write("\x1b[K");
    }

    clearFromCursor(): void {
        this.write("\x1b[J");
    }

    clearScreen(): void {
        this.write("\x1b[2J\x1b[H");
    }

    setTitle(_title: string): void {}

    setProgress(_active: boolean): void {}

    // ── Test drivers ───────────────────────────────────────────

    /** Feed input bytes through the captured onInput handler (real input path). */
    sendInput(data: string): void {
        this.onInput?.(data);
    }

    resize(columns: number, rows: number): void {
        this.xterm.resize(columns, rows);
        this.onResize?.();
    }

    clearWrites(): void {
        this.writes.length = 0;
    }

    // ── Screen assertions ──────────────────────────────────────

    /**
     * Decoded viewport rows (active buffer), right-trimmed by default.
     *
     * Note: xterm-headless 5.5's `translateToString(true)` only trims null
     * cells (char code 0), not explicitly printed spaces — the compositor
     * pads root/cluster lines with real spaces, so we trim trailing
     * whitespace here. Use `getLine`/`getCell` for exact cell access.
     */
    getViewport(trimRight = true): string[] {
        const buffer = this.xterm.buffer.active;
        const lines: string[] = [];
        for (let row = 0; row < this.xterm.rows; row++) {
            const line = buffer.getLine(row);
            const text = line ? line.translateToString(false) : "";
            lines.push(trimRight ? text.replace(/[ \t]+$/, "") : text);
        }
        return lines;
    }

    /** Decoded viewport row with per-cell attribute access retained. */
    getLine(row: number): { translateToString(trimRight?: boolean): string } | null {
        return this.xterm.buffer.active.getLine(row);
    }

    /** Per-cell attribute access, e.g. `cell.isReverse()`, `cell.isItalic()`. */
    getCell(row: number, col: number) {
        return this.xterm.buffer.active.getLine(row)?.getCell(col) ?? null;
    }

    /** Cursor position within the active buffer (0-indexed). */
    getCursorPosition(): CursorPosition {
        const buffer = this.xterm.buffer.active;
        return { x: buffer.cursorX, y: buffer.cursorY };
    }

    /**
     * Settle the async render pipeline: TUI's throttled requestRender
     * (nextTick + setTimeout) and xterm's async parse queue.
     */
    async waitForRender(): Promise<void> {
        await new Promise((resolve) => process.nextTick(resolve));
        await new Promise((resolve) => setTimeout(resolve, 20));
        await new Promise<void>((resolve) => this.xterm.write("", () => resolve()));
    }
}
