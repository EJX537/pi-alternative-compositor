import type { Terminal } from "@earendil-works/pi-tui";

function descriptorFor(
    terminal: Terminal,
    property: "rows" | "columns",
): PropertyDescriptor | undefined {
    let target: object | null = terminal;
    while (target) {
        const descriptor = Object.getOwnPropertyDescriptor(target, property);
        if (descriptor) return descriptor;
        target = Object.getPrototypeOf(target);
    }

    return undefined;
}

export function descriptorForRows(
    terminal: Terminal,
): PropertyDescriptor | undefined {
    return descriptorFor(terminal, "rows");
}

export function descriptorForColumns(
    terminal: Terminal,
): PropertyDescriptor | undefined {
    return descriptorFor(terminal, "columns");
}

function readDimension(
    terminal: Terminal,
    descriptor: PropertyDescriptor | undefined,
    property: "rows" | "columns",
): number {
    if (descriptor?.get) {
        const value = descriptor.get.call(terminal);
        return typeof value === "number" && Number.isFinite(value) ? value : 24;
    }
    if (descriptor && "value" in descriptor) {
        const value = descriptor.value;
        return typeof value === "number" && Number.isFinite(value) ? value : 24;
    }

    const value = Reflect.get(terminal, property);
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : property === "columns"
          ? 80
          : 24;
}

export function readRows(
    terminal: Terminal,
    descriptor: PropertyDescriptor | undefined,
): number {
    return readDimension(terminal, descriptor, "rows");
}

export function readColumns(
    terminal: Terminal,
    descriptor: PropertyDescriptor | undefined,
): number {
    return readDimension(terminal, descriptor, "columns");
}
