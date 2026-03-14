/**
 * Wire protocol for the qml-remote WebSocket bridge.
 * Every message is a JSON object with a `channel` discriminant.
 */

// ============================================================================
// Panel messages: server → client
// ============================================================================

export type ServerPanelMessage =
	/** Push QML source to Android for rendering */
	| {
			type: "push_qml";
			id: string;
			content: string;
			props?: Record<string, unknown>;
			title?: string;
			width?: number;
			height?: number;
	  }
	/** Forward a JSON message to a rendered panel */
	| { type: "message"; id: string; payload: Record<string, unknown> }
	/** Instruct client to close a panel */
	| { type: "close_panel"; id: string }
	/** Instruct client to reload a panel */
	| { type: "reload_panel"; id: string };

// ============================================================================
// Panel messages: client → server
// ============================================================================

export type ClientPanelMessage =
	/** Android reports panel is ready */
	| { type: "panel_ready"; id: string; armedTools?: string[] }
	/** Android forwards a panel-emitted event */
	| { type: "panel_event"; id: string; name?: string; payload: Record<string, unknown> }
	/** Android reports a panel render error */
	| { type: "panel_error"; id: string; message: string }
	/** Android reports panel was closed */
	| { type: "panel_closed"; id: string };

// ============================================================================
// Multiplexed wire envelope
// ============================================================================

/** Every WebSocket frame is one of these — discriminated by `channel`. */
export type WireMessage =
	// Server → client
	| { channel: "panel"; data: ServerPanelMessage }
	| { channel: "rpc_event"; data: unknown /* RpcResponse — kept opaque here */ }
	// Client → server
	| { channel: "rpc"; data: unknown /* RpcCommand — kept opaque here */ };
