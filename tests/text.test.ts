import { describe, it, expect } from "vitest";
import {
    OSC_PATTERN,
    ANSI_PATTERN,
    stripOscSequences,
    stripAnsi,
    sliceColumns,
    sanitizeLine,
    normalizeOverlayCompositionLine,
    compareSelectionPoints,
} from "../src/compositor/text";

function sanitizeOverlayBaseLine(line: string, width: number): string {
    return sanitizeLine(stripOscSequences(line), width);
}

describe("text utilities", () => {
    describe("stripOscSequences", () => {
        it("strips OSC with BEL terminator", () => {
            expect(
                stripOscSequences("\x1b]0;my title\x07visible"),
            ).toBe("visible");
        });

        it("strips OSC with ST terminator", () => {
            expect(
                stripOscSequences("\x1b]0;my title\x1b\\visible"),
            ).toBe("visible");
        });

        it("preserves text without OSC sequences", () => {
            expect(stripOscSequences("hello world")).toBe("hello world");
        });
    });

    describe("stripAnsi", () => {
        it("strips SGR codes", () => {
            expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
        });

        it("strips cursor movement codes", () => {
            expect(stripAnsi("\x1b[10;5Hhello")).toBe("hello");
        });

        it("strips combined OSC + ANSI", () => {
            expect(
                stripAnsi("\x1b]0;title\x07\x1b[31mhello\x1b[0m"),
            ).toBe("hello");
        });

        it("preserves plain text", () => {
            expect(stripAnsi("plain text")).toBe("plain text");
        });

        it("handles empty string", () => {
            expect(stripAnsi("")).toBe("");
        });
    });

    describe("sliceColumns", () => {
        it("slices a substring by visual columns", () => {
            expect(sliceColumns("hello world", 0, 5)).toBe("hello");
            expect(sliceColumns("hello world", 6, 11)).toBe("world");
        });

        it("handles zero-width segments from combining chars", () => {
            // Combining characters have zero visible width
            const result = sliceColumns("e\u0301abc", 0, 4);
            // The combined e + combining accent is one grapheme cluster
            expect(result.length).toBeGreaterThan(0);
        });

        it("returns empty for zero-width slice", () => {
            expect(sliceColumns("hello", 3, 3)).toBe("");
        });

        it("handles CJK wide characters", () => {
            // CJK characters are typically width 2
            const result = sliceColumns("ab\u4e2d\u56fdcd", 2, 6);
            // \u4e2d is 2 cols, \u56fd is 2 cols → "中国"
            expect(result).toBe("\u4e2d\u56fd");
        });

        it("handles start past end of string", () => {
            expect(sliceColumns("hi", 10, 20)).toBe("");
        });
    });

    describe("sanitizeLine", () => {
        it("truncates lines wider than allowed width", () => {
            const result = sanitizeLine("hello world", 5);
            // pi-tui appends \x1b[0m reset after truncation
            expect(stripAnsi(result)).toBe("hello");
        });

        it("preserves lines within width", () => {
            expect(sanitizeLine("hello", 10)).toBe("hello");
        });

        it("handles empty line", () => {
            expect(sanitizeLine("", 10)).toBe("");
        });
    });

    describe("sanitizeOverlayBaseLine", () => {
        it("strips OSC and truncates", () => {
            const result = sanitizeOverlayBaseLine(
                "\x1b]0;title\x07long content here",
                5,
            );
            // OSC stripped, then truncated to 5; pi-tui appends \x1b[0m
            expect(stripAnsi(result)).toBe("long ");
            expect(result).not.toContain("\x1b]");
        });
    });

    describe("normalizeOverlayCompositionLine", () => {
        it("replaces tabs with spaces", () => {
            expect(normalizeOverlayCompositionLine("a\tb")).toBe("a   b");
        });

        it("preserves lines without tabs", () => {
            expect(normalizeOverlayCompositionLine("hello")).toBe("hello");
        });

        it("replaces multiple tabs", () => {
            expect(normalizeOverlayCompositionLine("a\tb\tc")).toBe(
                "a   b   c",
            );
        });
    });

    describe("compareSelectionPoints", () => {
        it("returns negative when a < b (line diff)", () => {
            expect(
                compareSelectionPoints(
                    { line: 0, col: 100 },
                    { line: 1, col: 0 },
                ),
            ).toBeLessThan(0);
        });

        it("returns positive when a > b (line diff)", () => {
            expect(
                compareSelectionPoints(
                    { line: 2, col: 0 },
                    { line: 1, col: 100 },
                ),
            ).toBeGreaterThan(0);
        });

        it("returns negative when same line, col a < b", () => {
            expect(
                compareSelectionPoints(
                    { line: 1, col: 3 },
                    { line: 1, col: 7 },
                ),
            ).toBeLessThan(0);
        });

        it("returns 0 when points are equal", () => {
            expect(
                compareSelectionPoints(
                    { line: 5, col: 10 },
                    { line: 5, col: 10 },
                ),
            ).toBe(0);
        });
    });
});
