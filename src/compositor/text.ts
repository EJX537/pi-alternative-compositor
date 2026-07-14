import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SelectionPoint } from "./contracts.js";
export const OSC_PATTERN = new RegExp("\\u001b\\][^\\u0007]*(?:\\u0007|\\u001b\\\\)", "g");
export const ANSI_PATTERN = new RegExp("\\u001b\\[[0-9;?]*[ -/]*[@-~]", "g");
export function stripOscSequences(line: string): string { return line.replace(OSC_PATTERN, ""); }
export function stripAnsi(line: string): string { return stripOscSequences(line).replace(ANSI_PATTERN, ""); }
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function sliceColumns(text: string, startCol: number, endCol: number): string {
    let col = 0; let result = "";
    for (const { segment } of graphemeSegmenter.segment(text)) {
        const width = Math.max(0, visibleWidth(segment));
        if (col >= startCol && col < endCol) result += segment;
        col += width;
    }
    return result;
}
export function sanitizeLine(line: string, width: number): string {
    return visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line;
}
export function normalizeOverlayCompositionLine(line: string): string { return line.replace(/\t/g, "   "); }
export function compareSelectionPoints(a: SelectionPoint, b: SelectionPoint): number { return a.line === b.line ? a.col - b.col : a.line - b.line; }
