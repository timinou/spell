// PLAN-318 W5 fixture root. `runner.ts` re-exports from `tool.ts`.
// consumer.ts imports from runner.ts (the re-exporter).
export * from './tool_target';
