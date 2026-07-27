import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeLine } from "../compositor/text.js";

/**
 * Compose a single line of an overlay frame: main content padded to
 * mainWidth, followed by sidebar content.
 */
export function composeOverlayFrameLine(
    mainLine: string,
    sidebarLine: string,
    mainWidth: number,
    sidebarWidth: number,
): string {
    const main = sanitizeLine(mainLine, mainWidth);
    const mainPadding = " ".repeat(
        Math.max(0, mainWidth - visibleWidth(main)),
    );
    const sidebar =
        sidebarWidth > 0 ? sanitizeLine(sidebarLine, sidebarWidth) : "";
    return `${main}${mainPadding}${sidebar}`;
}
