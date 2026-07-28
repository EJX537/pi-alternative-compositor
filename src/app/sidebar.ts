import { Container, Text } from "@earendil-works/pi-tui";
import { getSidebarContainer } from "./sidebar-registry.js";

const BUILT_IN_TEXT = [
    "│ COMPOSITOR",
    "│",
    "│ Just to showcase its possible",
    "│",
    "│ Originally intended to copy what",
    "│ OpenCode displays here but I don't",
    "│ actually read is so (idk)",
].join("\n");

/**
 * Root sidebar component tree. Renders the built-in header followed by
 * extension-registered panels — all native pi TUI Container / Text.
 *
 *   sidebarRoot (Container)
 *     ├── Text (built-in header)
 *     └── extensionContainer (from registry — holds extension Components)
 */
function buildSidebarRoot(): Container {
    const root = new Container();
    root.addChild(new Text(BUILT_IN_TEXT, 0, 0));
    root.addChild(getSidebarContainer());
    return root;
}

export class SidebarState {
    enabled = true;
    visible = false;
    readonly container = buildSidebarRoot();

    createOptions() {
        return {
            breakpoint: "md" as const,
            visible: () => this.enabled && this.visible,
            component: this.container,
        };
    }
}
