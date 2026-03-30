/**
 * Gateway control plane protocol — NDJSON messages over Unix socket.
 *
 * Each request carries a unique `id`; the daemon responds with the same `id`
 * so clients can correlate concurrent requests.
 */

// ---------------------------------------------------------------------------
// Service schema
// ---------------------------------------------------------------------------

export interface ServiceConfig {
	/** Unique alias — lowercase alphanumeric + hyphens, max 63 chars (DNS label). */
	alias: string;
	/** Backend target URL, e.g. "http://127.0.0.1:3000". */
	target: string;
	/** Session ID that owns this service (omit for persistent services). */
	sessionId?: string;
	/** Whether the service persists across daemon restarts (default: false). */
	persistent?: boolean;
	/** Managed process config — when present, daemon can spawn/restart the backend. */
	managed?: ManagedProcessConfig;
}

export interface ManagedProcessConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export type ServiceStatus = "active" | "starting" | "stopped" | "error";

export interface ServiceEntry extends ServiceConfig {
	status: ServiceStatus;
	pid?: number;
	createdAt: string;
	lastHealthCheck?: string;
	error?: string;
}

// ---------------------------------------------------------------------------
// Alias validation
// ---------------------------------------------------------------------------

const ALIAS_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidAlias(alias: string): boolean {
	return ALIAS_REGEX.test(alias);
}

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

export interface GatewayRequestBase {
	id: string;
}

export type GatewayRequest =
	| (GatewayRequestBase & { type: "register"; config: ServiceConfig })
	| (GatewayRequestBase & { type: "deregister"; alias: string })
	| (GatewayRequestBase & { type: "list" })
	| (GatewayRequestBase & { type: "status"; alias?: string })
	| (GatewayRequestBase & { type: "cleanup"; sessionId: string })
	| (GatewayRequestBase & { type: "cert_info" })
	| (GatewayRequestBase & { type: "health" });

export type GatewayResponse =
	| { id: string; ok: true; data?: unknown }
	| { id: string; ok: false; error: string; code?: string };

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

export function serializeMessage(msg: GatewayRequest | GatewayResponse): string {
	return `${JSON.stringify(msg)}\n`;
}

export function parseMessage(line: string): GatewayRequest | GatewayResponse | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed) as GatewayRequest | GatewayResponse;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Socket path resolution
// ---------------------------------------------------------------------------

/** Resolve the gateway daemon socket path. */
export function resolveSocketPath(): string {
	const xdg = process.env.XDG_RUNTIME_DIR;
	if (xdg) return `${xdg}/spell-gateway.sock`;
	return `/tmp/spell-gateway-${process.getuid?.() ?? process.pid}.sock`;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

import * as os from "node:os";
import * as path from "node:path";

const GATEWAY_DIR = path.join(os.homedir(), ".spell", "gateway");

export const PATHS = {
	root: GATEWAY_DIR,
	registry: path.join(GATEWAY_DIR, "services.json"),
	tlsDir: path.join(GATEWAY_DIR, "tls"),
	cert: path.join(GATEWAY_DIR, "tls", "wildcard.pem"),
	key: path.join(GATEWAY_DIR, "tls", "wildcard-key.pem"),
} as const;
