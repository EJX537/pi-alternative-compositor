import { afterEach, describe, expect, it, vi } from "vitest";
import { Container, type Component } from "@earendil-works/pi-tui";
import {
    getSidebarRegistry,
    getSidebarContainer,
    resetSidebarRegistry,
    setSidebarRequestRender,
} from "../src/app/sidebar-registry";

afterEach(() => {
    resetSidebarRegistry();
});

function component(lines: string[]): Component {
    return {
        render: () => lines,
        invalidate: vi.fn(),
    };
}

describe("sidebar registry", () => {
    it("adds components to the extension container in order", () => {
        const registry = getSidebarRegistry();
        registry.add(component(["later"]), { order: 10 });
        registry.add(component(["first"]), { order: 0 });

        const rendered = getSidebarContainer().render(20);
        expect(rendered).toEqual(["first", "later"]);
    });

    it("requests a repaint on add and dispose", () => {
        const requestRender = vi.fn();
        setSidebarRequestRender(requestRender);
        const registry = getSidebarRegistry();

        const dispose = registry.add(component(["a"]));
        expect(requestRender).toHaveBeenCalledTimes(1);

        dispose();
        expect(requestRender).toHaveBeenCalledTimes(2);
    });

    it("filters hidden contributors and includes visible ones", () => {
        const registry = getSidebarRegistry();
        registry.add(component(["not shown"]), {
            visible: () => false,
        });
        registry.add(component(["shown"]), { id: "good" });

        const rendered = getSidebarContainer().render(20);
        expect(rendered).toEqual(["shown"]);
    });

    it("rejects duplicate ids", () => {
        const registry = getSidebarRegistry();
        registry.add(component([]), { id: "same" });
        expect(() => registry.add(component([]), { id: "same" })).toThrow(
            "Sidebar component already registered: same",
        );
    });

    it("invalidate calls through to all registered components", () => {
        const registry = getSidebarRegistry();
        const c1 = component(["a"]);
        const c2 = component(["b"]);
        registry.add(c1, { id: "p1" });
        registry.add(c2, { id: "p2" });

        registry.invalidate();

        expect(c1.invalidate).toHaveBeenCalledOnce();
        expect(c2.invalidate).toHaveBeenCalledOnce();
    });

    it("invalidate isolates a broken component", () => {
        const registry = getSidebarRegistry();
        const c1 = component(["a"]);
        const c2: Component = {
            render: () => [],
            invalidate: () => {
                throw new Error("bad");
            },
        };
        registry.add(c1, { id: "p1" });
        registry.add(c2, { id: "p2" });

        expect(() => registry.invalidate()).not.toThrow();
        expect(c1.invalidate).toHaveBeenCalledOnce();
    });
});
