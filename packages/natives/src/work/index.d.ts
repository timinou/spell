/**
 * Work scheduling profiling via native instrumentation.
 *
 * Always-on profiling - samples are collected into a circular buffer.
 * Call `getWorkProfile()` to retrieve recent activity.
 */
export type { WorkProfile } from "./types";
export declare const getWorkProfile: (lastSeconds: number) => import("./types").WorkProfile;
//# sourceMappingURL=index.d.ts.map