import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeLine } from "./text.js";
import type { FixedEditorClusterRender } from "./cluster.js";

const esc = "\x1b[";
const moveCursor = (row: number, col: number) => `${esc}${row};${col}H`;

/** Write content and reset SGR attributes, padding to `width` columns. */
export function padToWidth(content: string, width: number): string {
    const vis = visibleWidth(content);
    if (vis >= width) return content + "\x1b[0m";
    return content + "\x1b[0m" + " ".repeat(width - vis);
}

/**
 * Emit only the cluster cursor positioning/visibility bytes, without any
 * line content.  Used by the A/B diff paint path, where unchanged rows are
 * skipped but the hardware cursor still needs to track the editor cursor.
 */
export function buildClusterCursorPaint(
    cluster: FixedEditorClusterRender,
    terminalRows: number,
    showHardwareCursor: boolean,
): string {
    if (cluster.lines.length === 0) return "";
    const startRow = Math.max(1, terminalRows - cluster.lines.length + 1);
    if (cluster.cursor && showHardwareCursor) {
        return (
            moveCursor(
                startRow + cluster.cursor.row,
                Math.max(1, cluster.cursor.col + 1),
            ) +
            `${esc}?25h`
        );
    }
    if (!showHardwareCursor) {
        // Pi owns cursor visibility; leave it alone.
        return "";
    }
    return `${esc}?25l`;
}

/** Construct fixed-cluster bytes only; callers own terminal writes and modes. */
export function buildFixedClusterPaint(
    cluster: FixedEditorClusterRender,
    terminalRows: number,
    width: number,
    showHardwareCursor: boolean,
): string {
    if (cluster.lines.length === 0) return "";
    const startRow = Math.max(1, terminalRows - cluster.lines.length + 1);
    // Reset any SGR attributes that may have leaked from preceding output
    // (e.g. italic from Pi's data in the write() interceptor) before painting
    // the cluster lines.
    let buffer = `${esc}r\x1b[0m`;
    for (let i = 0; i < cluster.lines.length; i++)
        buffer +=
            moveCursor(startRow + i, 1) +
            padToWidth(sanitizeLine(cluster.lines[i] ?? "", width), width);
    return buffer + buildClusterCursorPaint(cluster, terminalRows, showHardwareCursor);
}
