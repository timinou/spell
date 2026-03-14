/** Commands sent from spell → bridge process (stdin) */
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
	| { type: "close"; id: string }
	| { type: "screenshot"; id: string; path: string }
	| {
			type: "query";
			id: string;
			selector?: {
				type?: string;
				objectName?: string;
				visible?: boolean;
				textContains?: string;
			};
			properties?: string[];
			includeGeometry?: boolean;
			recursive?: boolean;
			maxDepth?: number;
	  }
	| { type: "eval"; id: string; expression: string }
	| { type: "quit" };

/** Events emitted by bridge process → spell (stdout) */
export type BridgeEvent =
	| { type: "ready"; id: string; armedTools?: string[] }
	| { type: "event"; id: string; name?: string; payload: Record<string, unknown> }
	| { type: "error"; id: string; message: string }
	| { type: "closed"; id: string }
	| { type: "screenshot"; id: string; path: string }
	| {
			type: "query_result";
			id: string;
			items: Array<{
				className: string;
				objectName: string;
				geometry?: { x: number; y: number; width: number; height: number };
				scenePosition?: { x: number; y: number };
				visible: boolean;
				opacity: number;
				enabled: boolean;
				clip: boolean;
				properties: Record<string, unknown>;
				childCount: number;
				path: string;
			}>;
	  }
	| {
			type: "eval_result";
			id: string;
			value: unknown;
			error: string | null;
	  }
	| { type: "state"; windows: Array<{ id: string; path: string; state: string; armedTools?: string[] }> };

/** State of a managed window */
export type WindowState = "loading" | "ready" | "closed" | "error";

export interface WindowInfo {
	id: string;
	path: string;
	state: WindowState;
	lastError?: string;
	/** Armed tools declared by the QML root property (spellArmedTools). */
	armedTools?: string[];
	/** Events received from this window, most recent last */
	events: Array<{ name?: string; payload: Record<string, unknown> }>;
}
