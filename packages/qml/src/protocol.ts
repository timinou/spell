/** Commands sent from omp → bridge process (stdin) */
export type BridgeCommand =
	| {
			type: "load";
			id: string;
			path: string;
			props?: Record<string, unknown>;
			title?: string;
			width?: number;
			height?: number;
	  }
	| { type: "reload"; id: string }
	| { type: "message"; id: string; payload: Record<string, unknown> }
	| { type: "close"; id: string };

/** Events emitted by bridge process → omp (stdout) */
export type BridgeEvent =
	| { type: "ready"; id: string }
	| { type: "event"; id: string; name?: string; payload: Record<string, unknown> }
	| { type: "error"; id: string; message: string }
	| { type: "closed"; id: string };

/** State of a managed window */
export type WindowState = "loading" | "ready" | "closed" | "error";

export interface WindowInfo {
	id: string;
	path: string;
	state: WindowState;
	lastError?: string;
	/** Events received from this window, most recent last */
	events: Array<{ name?: string; payload: Record<string, unknown> }>;
}
