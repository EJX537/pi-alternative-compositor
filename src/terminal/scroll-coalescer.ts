/**
 * Scroll delta coalescer.
 *
 * Some terminals (notably Ghostty) deliver wheel events in rapid separate
 * stdin reads; each read currently triggers a full repaint.  This class
 * accumulates deltas and flushes once per short window via a callback.
 */
export class ScrollCoalescer {
    private pendingDelta = 0;
    private pendingOptions: { preserveSelection?: boolean } | undefined;
    private pendingTimer: ReturnType<typeof setTimeout> | null = null;
    private lastDirection = 0;
    private readonly onScroll: (
        delta: number,
        options?: { preserveSelection?: boolean },
    ) => void;

    constructor(onScroll: (delta: number, options?: { preserveSelection?: boolean }) => void) {
        this.onScroll = onScroll;
    }

    /**
     * Accumulate a scroll delta and schedule a flush.
     * If the environment variable PI_COMPOSITOR_NO_SCROLL_THROTTLE is "1",
     * the scroll is executed immediately without coalescing.
     */
    schedule(
        delta: number,
        options?: { preserveSelection?: boolean },
    ): void {
        if (process.env.PI_COMPOSITOR_NO_SCROLL_THROTTLE === "1") {
            this.onScroll(delta, options);
            return;
        }

        const direction = Math.sign(delta);
        if (
            this.pendingDelta !== 0 &&
            direction !== this.lastDirection
        ) {
            // Direction changed: flush the previous batch immediately so the
            // viewport doesn't jump in the wrong direction later.
            this.flush();
        }

        this.pendingDelta += delta;
        this.pendingOptions ??= options;

        if (this.pendingTimer) return;

        this.pendingTimer = setTimeout(() => {
            this.flush();
        }, 8);

        if (
            typeof this.pendingTimer === "object" &&
            "unref" in this.pendingTimer
        ) {
            this.pendingTimer.unref();
        }
    }

    /** Flush any accumulated scroll delta immediately. */
    flush(): void {
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
        if (this.pendingDelta === 0) return;

        const delta = this.pendingDelta;
        const options = this.pendingOptions;
        this.pendingDelta = 0;
        this.pendingOptions = undefined;
        this.lastDirection = Math.sign(delta);
        this.onScroll(delta, options);
    }

    get hasPending(): boolean {
        return this.pendingDelta !== 0;
    }
}
