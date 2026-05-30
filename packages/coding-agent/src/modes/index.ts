import { emergencyTerminalRestore } from "@spell/pi-tui";
import { postmortem } from "@spell/pi-utils";

export * from "./browse-mode";
export * from "./fluid-mode";
/**
 * Run modes for the coding agent.
 */
export { InteractiveMode, type InteractiveModeOptions } from "./interactive-mode";
export { type PrintModeOptions, runPrintMode } from "./print-mode";
export * from "./qml-mode";
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client";
export { runRpcMode } from "./rpc/rpc-mode";
export type { RpcCommand, RpcResponse, RpcSessionState } from "./rpc/rpc-types";

postmortem.register("terminal-restore", () => {
	emergencyTerminalRestore();
});
