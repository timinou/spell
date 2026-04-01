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
	| {
			type: "click";
			id: string;
			/** Coordinate-based click */
			x?: number;
			y?: number;
			/** Selector-based click (finds element, clicks center) */
			selector?: {
				type?: string;
				objectName?: string;
				visible?: boolean;
				textContains?: string;
			};
	  }
	| { type: "type"; id: string; text: string }
	| { type: "press"; id: string; key: string; modifiers?: string }
	| {
			type: "scroll";
			id: string;
			x: number;
			y: number;
			/** Positive = scroll up (Qt convention). */
			deltaX?: number;
			/** Positive = scroll up (Qt convention). */
			deltaY: number;
	  }
	| { type: "quit" }
	| { type: "create_systray"; icon?: string; tooltip?: string }
	| {
			type: "update_systray_menu";
			items: Array<{
				id: string;
				label: string;
				enabled?: boolean;
				checked?: boolean;
				separator?: boolean;
			}>;
	  }
	| { type: "destroy_systray" }
	| { type: "register_hotkey"; hotkeyId: string; key: string; modifiers: string[] }
	| { type: "unregister_hotkey"; hotkeyId: string };

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
	| {
			type: "input_result";
			id: string;
			command: "click" | "type" | "press" | "scroll";
			success: boolean;
			error?: string;
			/** Click coordinates (for click commands) */
			x?: number;
			y?: number;
			/** Characters typed (for type commands) */
			length?: number;
	  }
	| { type: "state"; windows: Array<{ id: string; path: string; state: string; armedTools?: string[] }> }
	| { type: "systray_click"; id: "__systray__"; itemId: string }
	| { type: "systray_activated"; id: "__systray__" }
	| { type: "hotkey_triggered"; id: "__hotkey__"; hotkeyId: string };

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
