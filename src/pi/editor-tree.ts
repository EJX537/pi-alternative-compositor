import { Container, type Component, type EditorComponent } from "@earendil-works/pi-tui";
import type { TerminalSplitCompositor } from "../terminal/controller.js";
import type { TuiInternals } from "./internals.js";

export interface EditorContainerMatch {
    container: Container;
    index: number;
}

function isEditorComponent(value: Component): value is EditorComponent {
    return (
        typeof (value as EditorComponent).getText === "function" &&
        typeof (value as EditorComponent).setText === "function" &&
        typeof (value as EditorComponent).handleInput === "function"
    );
}

function findContainerWith(
    tui: TuiInternals,
    child: Component,
): EditorContainerMatch | null {
    const index = tui.children.findIndex(
        (candidate) =>
            candidate instanceof Container && candidate.children.includes(child),
    );
    if (index === -1) return null;

    const container = tui.children[index];
    return container instanceof Container ? { container, index } : null;
}

export function findEditorContainer(tui: TuiInternals): EditorContainerMatch | null {
    if (tui.focusedComponent) {
        const match = findContainerWith(tui, tui.focusedComponent);
        if (match) return match;
    }

    const index = tui.children.findIndex((candidate) => {
        if (!(candidate instanceof Container)) return false;
        return candidate.children.some(isEditorComponent);
    });
    if (index === -1) return null;

    const container = tui.children[index];
    return container instanceof Container ? { container, index } : null;
}

export function renderHidden(
    compositor: TerminalSplitCompositor,
    component: Component | null,
    width: number,
): string[] {
    if (!component) return [];
    return compositor.renderHidden(component, width);
}
