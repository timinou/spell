/**
 * The previous mock-based projection test was replaced by the real-natives
 * integration in `session-start-projection.test.ts` (PLAN-310 W7). Module-level
 * `mock.module("@oh-my-pi/pi-natives", ...)` calls leaked across files in the
 * same bun:test process and broke the sibling compaction / task-completion
 * integration tests. Keep this file as a sentinel so the new layout is
 * discoverable; see the integration file for the live assertions.
 */
