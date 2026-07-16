import type { ExtendedKeyboardMode } from "./types.js";

// ── Synchronized output ──────────────────────────────────────

export function beginSynchronizedOutput(): string {
    return "\x1b[?2026h";
}

export function endSynchronizedOutput(): string {
    return "\x1b[?2026l";
}

// ── Scroll regions ───────────────────────────────────────────

export function setScrollRegion(top: number, bottom: number): string {
    return `\x1b[${top};${bottom}r`;
}

export function resetScrollRegion(): string {
    return "\x1b[r";
}

// ── Cursor ───────────────────────────────────────────────────

export function moveCursor(row: number, col: number): string {
    return `\x1b[${row};${col}H`;
}

export function clearLine(): string {
    return "\x1b[2K";
}

/** Clear from the cursor through the physical end of the line. */
export function clearToEndOfLine(): string {
    return "\x1b[K";
}

export function hideCursor(): string {
    return "\x1b[?25l";
}

export function showCursor(): string {
    return "\x1b[?25h";
}

// ── Alternate screen ─────────────────────────────────────────

export function enterAlternateScreen(): string {
    return "\x1b[?1049h";
}

export function exitAlternateScreen(): string {
    return "\x1b[?1049l";
}

/** Erase entire display (scrollable + alternate-screen content). */
export function eraseDisplay(): string {
    return "\x1b[2J";
}

/** Home the cursor to (1,1). */
export function homeCursor(): string {
    return "\x1b[H";
}

// ── Scroll mode ──────────────────────────────────────────────

export function enableAlternateScrollMode(): string {
    return "\x1b[?1007h";
}

export function disableAlternateScrollMode(): string {
    return "\x1b[?1007l";
}

// ── Auto-wrap ────────────────────────────────────────────────

export function disableAutoWrap(): string {
    return "\x1b[?7l";
}

export function enableAutoWrap(): string {
    return "\x1b[?7h";
}

// ── Mouse reporting ──────────────────────────────────────────

export function enableMouseReporting(): string {
    // Modes 1000/1002/1003 are mutually exclusive; 1003 (any-event) is a
    // superset of 1002 (button-event). Enable 1002 first, then 1003, so
    // any-event mode takes effect and the terminal reports motion events
    // even when no button is held (required for hover highlight).
    return "\x1b[?1002h\x1b[?1003h\x1b[?1006h";
}

export function disableMouseReporting(): string {
    return "\x1b[?1006l\x1b[?1002l\x1b[?1003l\x1b[?1000l";
}

// ── Focus events ─────────────────────────────────────────────

export function disableFocusEvents(): string {
    return "\x1b[?1004l";
}

// ── Bracketed paste ──────────────────────────────────────────

export function enableBracketedPaste(): string {
    return "\x1b[?2004h";
}

export function disableBracketedPaste(): string {
    return "\x1b[?2004l";
}

// ── Extended keyboard modes ──────────────────────────────────

export function enableExtendedKeyboardMode(mode: ExtendedKeyboardMode): string {
    return mode === "kitty" ? "\x1b[>7u" : "\x1b[>4;2m";
}

export function disableExtendedKeyboardMode(
    mode: ExtendedKeyboardMode,
): string {
    return mode === "kitty" ? "\x1b[<u" : "\x1b[>4;0m";
}

export function resetExtendedKeyboardModes(): string {
    return "\x1b[<999u\x1b[>4;0m";
}

// ── Compound resets ──────────────────────────────────────────

export function emergencyTerminalModeReset(): string {
    return (
        beginSynchronizedOutput() +
        eraseDisplay() +
        homeCursor() +
        resetScrollRegion() +
        disableMouseReporting() +
        enableAlternateScrollMode() +
        exitAlternateScreen() +
        resetExtendedKeyboardModes() +
        endSynchronizedOutput()
    );
}
