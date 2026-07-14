import { afterEach, describe, expect, it, vi } from "vitest";
import {
    getSidebarRegistry,
    renderSidebarPanels,
    resetSidebarRegistry,
    setSidebarRequestRender,
} from "../src/app/sidebar-registry";

afterEach(() => {
    resetSidebarRegistry();
});

describe("sidebar registry", () => {
    it("orders contributor panels and requests a repaint on changes", () => {
        const requestRender = vi.fn();
        setSidebarRequestRender(requestRender);
        const registry = getSidebarRegistry();
        const disposeLater = registry.register({
            id: "later",
            order: 10,
            render: () => ["later"],
        });
        registry.register({
            id: "first",
            order: 0,
            render: () => ["first"],
        });

        expect(renderSidebarPanels(20, 10)).toEqual(["first", "later"]);
        expect(requestRender).toHaveBeenCalledTimes(2);

        disposeLater();
        expect(renderSidebarPanels(20, 10)).toEqual(["first"]);
        expect(requestRender).toHaveBeenCalledTimes(3);
    });

    it("isolates a broken or hidden contributor", () => {
        const registry = getSidebarRegistry();
        registry.register({
            id: "hidden",
            visible: () => false,
            render: () => ["not shown"],
        });
        registry.register({
            id: "broken",
            render: () => {
                throw new Error("broken panel");
            },
        });
        registry.register({ id: "good", render: () => ["shown"] });

        expect(renderSidebarPanels(20, 10)).toEqual(["shown"]);
    });

    it("rejects duplicate panel ids", () => {
        const registry = getSidebarRegistry();
        registry.register({ id: "same", render: () => [] });
        expect(() => registry.register({ id: "same", render: () => [] })).toThrow(
            "Sidebar panel already registered: same",
        );
    });
});
