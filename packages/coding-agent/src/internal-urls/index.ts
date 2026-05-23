/**
 * Internal URL routing system for internal protocols like agent://, memory://, skill://, mcp://, and local://.
 *
 * This module provides a unified way to resolve internal URLs without
 * exposing filesystem paths to the agent.
 *
 * @example
 * ```ts
 * import { InternalUrlRouter, AgentProtocolHandler, MemoryProtocolHandler, SkillProtocolHandler } from './internal-urls';
 *
 * const router = new InternalUrlRouter();
 * router.register(new AgentProtocolHandler({ getArtifactsDir: () => sessionDir }));
 * router.register(new MemoryProtocolHandler({ getMemoryRoot: () => memoryRoot }));
 * router.register(new SkillProtocolHandler({ getSkills: () => skills }));
 *
 * if (router.canHandle('agent://reviewer_0')) {
 *   const resource = await router.resolve('agent://reviewer_0');
 *   console.log(resource.content);
 * }
 * ```
 */

export * from "../swarm/uri-protocol";
export * from "./agent-protocol";
export * from "./artifact-protocol";
export * from "./canvas-protocol";
// jobs scheme is kernel-owned via callback bridge (PLAN-310 BUG-395)
export * from "./json-query";
export * from "./local-protocol";
export * from "./mcp-protocol";
export * from "./memory-protocol";
export * from "./org-protocol";
export * from "./pi-protocol";
export * from "./router";
// rule + skill schemes are kernel-owned via callback bridges
// (PLAN-310 BUG-393, BUG-394)
export type * from "./types";
