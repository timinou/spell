/**
 * Work scheduling profiling via native instrumentation.
 *
 * Always-on profiling - samples are collected into a circular buffer.
 * Call `getWorkProfile()` to retrieve recent activity.
 */
import { native } from "../native";
export const { getWorkProfile } = native;
//# sourceMappingURL=index.js.map