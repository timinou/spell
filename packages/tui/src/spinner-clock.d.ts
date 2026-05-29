/**
 * SpinnerClock — singleton 80ms ticker that drives all uniform spinners.
 * One setInterval regardless of how many spinners are active; auto-starts on
 * first subscriber, auto-stops when subscriber set is empty.
 *
 * Visually distinct animations (voice, caveman) keep their own clocks.
 */
declare class SpinnerClock {
    #private;
    subscribe(cb: () => void): () => void;
    /** Current frame tick (monotonically increasing). Consumers should modulo by their frame array length. */
    get frame(): number;
    /** Snapshot frame count — useful for tests; monotonically increasing. */
    get tickCount(): number;
    /** Test-only: reset state. */
    resetForTest(): void;
}
export declare const spinnerClock: SpinnerClock;
export {};
//# sourceMappingURL=spinner-clock.d.ts.map