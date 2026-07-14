import { describe, it, expect } from "vitest";
import {
    beginSynchronizedOutput,
    endSynchronizedOutput,
    setScrollRegion,
    resetScrollRegion,
    moveCursor,
    clearLine,
    hideCursor,
    showCursor,
    enterAlternateScreen,
    exitAlternateScreen,
    enableAlternateScrollMode,
    disableAlternateScrollMode,
    disableAutoWrap,
    enableAutoWrap,
    enableMouseReporting,
    disableMouseReporting,
    enableExtendedKeyboardMode,
    disableExtendedKeyboardMode,
    resetExtendedKeyboardModes,
    emergencyTerminalModeReset,
} from "../src/terminal/escape";

describe("escape sequences", () => {
    describe("synchronized output", () => {
        it("beginSynchronizedOutput", () => {
            expect(beginSynchronizedOutput()).toBe("\x1b[?2026h");
        });

        it("endSynchronizedOutput", () => {
            expect(endSynchronizedOutput()).toBe("\x1b[?2026l");
        });
    });

    describe("scroll regions", () => {
        it("setScrollRegion", () => {
            expect(setScrollRegion(1, 24)).toBe("\x1b[1;24r");
            expect(setScrollRegion(5, 10)).toBe("\x1b[5;10r");
        });

        it("resetScrollRegion", () => {
            expect(resetScrollRegion()).toBe("\x1b[r");
        });
    });

    describe("cursor", () => {
        it("moveCursor", () => {
            expect(moveCursor(1, 1)).toBe("\x1b[1;1H");
            expect(moveCursor(10, 5)).toBe("\x1b[10;5H");
        });

        it("clearLine", () => {
            expect(clearLine()).toBe("\x1b[2K");
        });

        it("hideCursor", () => {
            expect(hideCursor()).toBe("\x1b[?25l");
        });

        it("showCursor", () => {
            expect(showCursor()).toBe("\x1b[?25h");
        });
    });

    describe("alternate screen", () => {
        it("enterAlternateScreen", () => {
            expect(enterAlternateScreen()).toBe("\x1b[?1049h");
        });

        it("exitAlternateScreen", () => {
            expect(exitAlternateScreen()).toBe("\x1b[?1049l");
        });
    });

    describe("scroll mode", () => {
        it("enableAlternateScrollMode", () => {
            expect(enableAlternateScrollMode()).toBe("\x1b[?1007h");
        });

        it("disableAlternateScrollMode", () => {
            expect(disableAlternateScrollMode()).toBe("\x1b[?1007l");
        });
    });

    describe("auto-wrap", () => {
        it("disableAutoWrap", () => {
            expect(disableAutoWrap()).toBe("\x1b[?7l");
        });

        it("enableAutoWrap", () => {
            expect(enableAutoWrap()).toBe("\x1b[?7h");
        });
    });

    describe("mouse reporting", () => {
        it("enableMouseReporting", () => {
            expect(enableMouseReporting()).toBe(
                "\x1b[?1003h\x1b[?1002h\x1b[?1006h",
            );
        });

        it("disableMouseReporting", () => {
            expect(disableMouseReporting()).toBe(
                "\x1b[?1006l\x1b[?1002l\x1b[?1003l\x1b[?1000l",
            );
        });
    });

    describe("extended keyboard modes", () => {
        it("enableExtendedKeyboardMode kitty", () => {
            expect(enableExtendedKeyboardMode("kitty")).toBe("\x1b[>7u");
        });

        it("enableExtendedKeyboardMode modifyOtherKeys", () => {
            expect(enableExtendedKeyboardMode("modifyOtherKeys")).toBe(
                "\x1b[>4;2m",
            );
        });

        it("disableExtendedKeyboardMode kitty", () => {
            expect(disableExtendedKeyboardMode("kitty")).toBe("\x1b[<u");
        });

        it("disableExtendedKeyboardMode modifyOtherKeys", () => {
            expect(disableExtendedKeyboardMode("modifyOtherKeys")).toBe(
                "\x1b[>4;0m",
            );
        });

        it("resetExtendedKeyboardModes", () => {
            expect(resetExtendedKeyboardModes()).toBe("\x1b[<999u\x1b[>4;0m");
        });
    });

    describe("emergencyTerminalModeReset", () => {
        it("returns a compound reset sequence", () => {
            const result = emergencyTerminalModeReset();
            expect(result).toContain("\x1b[?2026h"); // beginSynchronizedOutput
            expect(result).toContain("\x1b[r"); // resetScrollRegion
            expect(result).toContain("\x1b[?1006l\x1b[?1002l\x1b[?1003l\x1b[?1000l"); // disableMouseReporting
            expect(result).toContain("\x1b[?1007h"); // enableAlternateScrollMode
            expect(result).toContain("\x1b[?1049l"); // exitAlternateScreen
            expect(result).toContain("\x1b[<999u\x1b[>4;0m"); // resetExtendedKeyboardModes
            expect(result).toContain("\x1b[?2026l"); // endSynchronizedOutput
        });
    });
});
