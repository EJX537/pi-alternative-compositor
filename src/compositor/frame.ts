import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeLine } from "./text.js";
import type { FixedEditorClusterRender } from "./cluster.js";

const esc = "\x1b[";
const moveCursor = (row: number, col: number) => `${esc}${row};${col}H`;

/** Write content and reset SGR attributes, padding to `width` columns. */
function padToWidth(content: string, width: number): string {
    const vis = visibleWidth(content);
    if (vis >= width) return content + "\x1b[0m";
    return content + "\x1b[0m" + " ".repeat(width - vis);
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
    if (cluster.cursor && showHardwareCursor) {
        return (
            buffer +
            moveCursor(
                startRow + cluster.cursor.row,
                Math.max(1, cluster.cursor.col + 1),
            ) +
            `${esc}?25h`
        );
    }
    if (!showHardwareCursor) {
        // When showHardwareCursor is disabled (Pi default), leave the cursor
        // visibility state alone. Unconditionally emitting \x1b[?25l here
        // suppresses the cursor on EVERY repaint, causing a hide/show cycle
        // with Pi's own cursor management (especially during overlay
        // transitions like the compositor settings dialog).
        return buffer;
    }
    return buffer + `${esc}?25l`;
}
