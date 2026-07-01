/**
 * WAVE 2 (FEAT-828): resolve + convert MCP servers declared in spell.kdl
 * (settings `mcp.servers` tiers) for the `/mcp` command layer.
 *
 * Why this module exists as pure functions: the `/mcp reauth|unauth|enable|
 * disable|login` commands need to find and rewrite a server's config. Before
 * this, `#findConfiguredServer` read only legacy `mcp.json`, so KDL-declared
 * servers were invisible ("Server not found"). The resolution + conversion
 * logic lives here so it is unit-testable without a live controller, session,
 * or filesystem.
 *
 * Precedence mirrors builtin.ts::loadMCPServers: KDL wins over legacy mcp.json;
 * within KDL, project tier wins over user tier (higher-specificity last-wins).
 */

import type { McpServerKdlEntry } from "../config/kdl-compatibility";
import type { MCPAuthConfig, MCPServerConfig } from "./types";

/** A per-tier map of server-name -> KDL entry, as produced by readMcpServers. */
export type TierServerMap = Record<string, McpServerKdlEntry>;

/** The two persisted config sources, each split by scope. */
export interface McpServerSources {
	/** spell.kdl `mcp.servers` tiers (primary, writable). */
	kdl: { user: TierServerMap; project: TierServerMap };
	/** legacy mcp.json maps (read-only fallback during migration). */
	legacy: { user: TierServerMap; project: TierServerMap };
}

/** A resolved server: which scope/source it came from + its KDL entry. */
export interface ResolvedMcpServer {
	scope: "user" | "project";
	source: "kdl" | "legacy";
	entry: McpServerKdlEntry;
}

/**
 * Resolve a server by name across KDL tiers (primary) then legacy mcp.json
 * (fallback). Project scope beats user scope within a source; KDL beats legacy
 * across sources. Returns null when the name is absent everywhere.
 */
export function resolveMcpServer(name: string, sources: McpServerSources): ResolvedMcpServer | null {
	// KDL primary: project tier wins over user tier.
	if (sources.kdl.project[name]) {
		return { scope: "project", source: "kdl", entry: sources.kdl.project[name] };
	}
	if (sources.kdl.user[name]) {
		return { scope: "user", source: "kdl", entry: sources.kdl.user[name] };
	}
	// Legacy fallback (migration window): project then user.
	if (sources.legacy.project[name]) {
		return { scope: "project", source: "legacy", entry: sources.legacy.project[name] };
	}
	if (sources.legacy.user[name]) {
		return { scope: "user", source: "legacy", entry: sources.legacy.user[name] };
	}
	return null;
}

/**
 * Convert a KDL entry into a runtime MCPServerConfig. Mirrors
 * config.ts::convertToLegacyConfig but sourced from the in-memory KDL entry
 * shape (used when the command layer has already parsed settings tiers).
 */
export function entryToConfig(entry: McpServerKdlEntry): MCPServerConfig {
	const transport = entry.type ?? (entry.command ? "stdio" : entry.url ? "http" : "stdio");
	const shared = {
		...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
		...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
		...(entry.auth ? { auth: { ...entry.auth } as MCPAuthConfig } : {}),
		...(entry.oauth ? { oauth: { ...entry.oauth } } : {}),
	};

	if (transport === "http") {
		return {
			...shared,
			type: "http",
			url: entry.url ?? "",
			...(entry.headers ? { headers: { ...entry.headers } } : {}),
		};
	}
	if (transport === "sse") {
		return {
			...shared,
			type: "sse",
			url: entry.url ?? "",
			...(entry.headers ? { headers: { ...entry.headers } } : {}),
		};
	}
	return {
		...shared,
		type: "stdio",
		command: entry.command ?? "",
		...(entry.args ? { args: [...entry.args] } : {}),
		...(entry.env ? { env: { ...entry.env } } : {}),
	};
}

/**
 * Convert a runtime MCPServerConfig back into a KDL entry for serialization
 * via writeMcpServers. Inverse of entryToConfig. `auth` carries the full
 * OAuth coordinate set (BUG-491): type, credentialId, tokenUrl, clientId,
 * clientSecret.
 */
export function configToEntry(config: MCPServerConfig): McpServerKdlEntry {
	const entry: McpServerKdlEntry = { type: config.type };
	if (config.enabled !== undefined) entry.enabled = config.enabled;
	if (config.timeout !== undefined) entry.timeout = config.timeout;

	if (config.type === "stdio") {
		if (config.command) entry.command = config.command;
		if (config.args && config.args.length > 0) entry.args = [...config.args];
		if (config.env) entry.env = { ...config.env };
	} else {
		if (config.url) entry.url = config.url;
		if (config.headers) entry.headers = { ...config.headers };
	}

	if (config.auth) {
		entry.auth = {
			type: config.auth.type,
			...(config.auth.credentialId !== undefined ? { credentialId: config.auth.credentialId } : {}),
			...(config.auth.tokenUrl !== undefined ? { tokenUrl: config.auth.tokenUrl } : {}),
			...(config.auth.clientId !== undefined ? { clientId: config.auth.clientId } : {}),
			...(config.auth.clientSecret !== undefined ? { clientSecret: config.auth.clientSecret } : {}),
		};
	}
	if (config.oauth) entry.oauth = { ...config.oauth };

	return entry;
}
