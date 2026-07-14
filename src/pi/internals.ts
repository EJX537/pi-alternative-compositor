/**
 * Controlled access to private TUI / Terminal internals.
 *
 * TerminalSplitCompositor deliberately overloads pi's default compositor by
 * patching TUI's render pipeline and accessing internal bookkeeping that is
 * declared private upstream.
 *
 * TypeScript class-private members are branded — they cannot participate in
 * intersection types with non-private declarations of the same name (the
 * intersection reduces to never).  Module augmentation cannot override them
 * either (TS2687/TS2717).
 *
 * The solution is a standalone interface that describes every property the
 * compositor needs (both public and private) with a single `as unknown as`
 * cast at the boundary.  This keeps the escape hatch concentrated in one
 * place — every subsequent access is fully type-checked.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { Terminal } from "@earendil-works/pi-tui";

// ── TUI internals (public + private members consumed by compositor) ─

type InputListenerResult = { consume?: boolean; data?: string } | undefined;

export interface TuiInternals {
    children: Component[];
    terminal: Terminal;
    requestRender: (force?: boolean) => void;
    addInputListener(
        listener: (data: string) => InputListenerResult,
    ): () => void;
    hasOverlay: () => boolean;
    render: (width: number) => string[];
    getShowHardwareCursor: () => boolean;

    /* ════════════════════════════════════════════════════════════
     * Private internals — exposed for compositor overrides.
     * ════════════════════════════════════════════════════════════ */

    /** Currently focused child component. */
    focusedComponent: Component | null;
    /** Row where the hardware cursor should be placed. */
    hardwareCursorRow: number;
    /** Logical cursor row (end of rendered content). */
    cursorRow: number;
    /** First visible viewport row of the previous render pass. */
    previousViewportTop: number;
    /** Lines from the previous render pass. */
    previousLines: string[];
    /** Kitty graphics image ids from the previous render pass. */
    previousKittyImageIds: Set<number>;
    /** Terminal width from the previous render pass. */
    previousWidth: number;
    /** Terminal height from the previous render pass. */
    previousHeight: number;
    /** Maximum number of lines ever rendered in this session. */
    maxLinesRendered: number;
    /** Internal render pass — patched by compositor. */
    doRender: () => void;
    /** Splice overlay content into a base line — patched by compositor. */
    compositeLineAt: (
        baseLine: string,
        overlayLine: string,
        startCol: number,
        overlayWidth: number,
        totalWidth: number,
    ) => string;
    /** Stack of active overlay entries. */
    overlayStack: { hidden?: boolean }[];
    /** Collect Kitty graphics image ids from rendered lines. */
    collectKittyImageIds: (lines: string[]) => Set<number>;
}

// ── Terminal internals ────────────────────────────────────────

export interface TerminalInternals {
    /** Private on ProcessTerminal; absent from the Terminal interface. */
    modifyOtherKeysActive: boolean;
}
