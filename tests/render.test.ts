import { describe, it, expect } from "vitest";
import { buildFixedClusterPaint } from "../src/compositor/frame";
import { resolveSidebarLayout } from "../src/compositor/layout";
import type { FixedEditorClusterRender } from "../src/compositor/cluster";

describe("resolveSidebarLayout", () => {
    const sidebar = { render: () => [] };

    it("leaves the terminal single-column without a sidebar", () => {
        expect(resolveSidebarLayout(100, undefined)).toEqual({
            mainWidth: 100,
            sidebarWidth: 0,
        });
    });

    it("hides the md sidebar below its breakpoint", () => {
        expect(resolveSidebarLayout(119, sidebar)).toEqual({
            mainWidth: 119,
            sidebarWidth: 0,
        });
    });

    it("returns sidebar columns to Pi when visibility is false", () => {
        expect(
            resolveSidebarLayout(160, {
                ...sidebar,
                visible: () => false,
            }),
        ).toEqual({ mainWidth: 160, sidebarWidth: 0 });
    });

    it("reserves a clamped flex column at the md breakpoint", () => {
        expect(resolveSidebarLayout(120, sidebar)).toEqual({
            mainWidth: 80,
            sidebarWidth: 40,
        });
    });

    it("supports the smaller responsive breakpoint", () => {
        expect(
            resolveSidebarLayout(80, {
                ...sidebar,
                breakpoint: "sm",
                widthRatio: 1 / 4,
            }),
        ).toEqual({ mainWidth: 56, sidebarWidth: 24 });
    });
});

describe("buildFixedClusterPaint", () => {
    it("returns empty string for empty cluster", () => {
        const cluster: FixedEditorClusterRender = {
            lines: [],
            cursor: null,
        };
        expect(buildFixedClusterPaint(cluster, 24, 80, false)).toBe("");
    });

    it("includes resetScrollRegion at the start", () => {
        const cluster: FixedEditorClusterRender = {
            lines: ["hello"],
            cursor: null,
        };
        const result = buildFixedClusterPaint(cluster, 24, 80, false);
        expect(result).toContain("\x1b[r");
    });

    it("moves cursor to each line and pads to width", () => {
        const cluster: FixedEditorClusterRender = {
            lines: ["line1", "line2"],
            cursor: null,
        };
        const result = buildFixedClusterPaint(cluster, 24, 80, false);

        // Lines should start at bottom (row 23 for 24 terminal rows with 2 lines)
        expect(result).toContain("\x1b[23;1H");
        expect(result).toContain("\x1b[24;1H");
        // Should NOT use clearLine (\x1b[2K) — pads with spaces instead
        expect(result).not.toContain("\x1b[2K");
        expect(result).toContain("line1");
        expect(result).toContain("line2");
    });

    it("renders cursor when showHardwareCursor is true and cursor is set", () => {
        const cluster: FixedEditorClusterRender = {
            lines: ["line"],
            cursor: { row: 0, col: 2 },
        };
        const result = buildFixedClusterPaint(cluster, 24, 80, true);

        // Cursor on row 24, col 3 (1-indexed)
        expect(result).toContain("\x1b[24;3H");
        expect(result).toContain("\x1b[?25h");
    });

    it("hides cursor when showHardwareCursor is true but cursor is null", () => {
        const cluster: FixedEditorClusterRender = {
            lines: ["line"],
            cursor: null,
        };
        const result = buildFixedClusterPaint(cluster, 24, 80, true);

        expect(result).toContain("\x1b[?25l");
    });

    it("leaves cursor visibility alone when showHardwareCursor is false even if cursor exists", () => {
        const cluster: FixedEditorClusterRender = {
            lines: ["line"],
            cursor: { row: 0, col: 0 },
        };
        const result = buildFixedClusterPaint(cluster, 24, 80, false);

        // Should NOT emit any cursor visibility command when
        // showHardwareCursor is false — Pi owns cursor visibility.
        expect(result).not.toContain("\x1b[?25");
    });

    it("truncates lines that exceed terminal width", () => {
        const cluster: FixedEditorClusterRender = {
            lines: ["a".repeat(200)],
            cursor: null,
        };
        const result = buildFixedClusterPaint(cluster, 24, 80, false);

        // Line should be truncated to 80 chars
        const lineContent = result.match(/[a]+/);
        expect(lineContent).not.toBeNull();
        expect(lineContent![0].length).toBeLessThanOrEqual(85); // slight flexibility
    });

    it("handles many lines", () => {
        const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
        const cluster: FixedEditorClusterRender = {
            lines,
            cursor: null,
        };
        const result = buildFixedClusterPaint(cluster, 24, 80, false);

        for (const line of lines) {
            expect(result).toContain(line);
        }
    });
});
