/**
 * SSH JSON Provider
 *
 * Discovers SSH hosts from managed spell config paths and legacy root ssh.json files.
 * Priority: 5 (low, project/user config discovery)
 */
import * as path from "node:path";
import { getSSHConfigPath, tryParseJson } from "@spell/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type SSHHost, sshCapability } from "../capability/ssh";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { expandTilde } from "../tools/path-utils";
import { createSourceMeta, expandEnvVarsDeep } from "./helpers";

const PROVIDER_ID = "ssh-json";
const DISPLAY_NAME = "SSH Config";

interface SSHConfigFile {
	hosts?: Record<
		string,
		{
			host?: string;
			username?: string;
			port?: number | string;
			compat?: boolean | string;
			key?: string;
			keyPath?: string;
			description?: string;
		}
	>;
}

function parsePort(value: number | string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function parseCompat(value: boolean | string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
	if (normalized === "false" || normalized === "0" || normalized === "no") return false;
	return undefined;
}

function normalizeHost(
	name: string,
	raw: NonNullable<SSHConfigFile["hosts"]>[string],
	source: SourceMeta,
	home: string,
	warnings: string[],
): SSHHost | null {
	if (!raw.host) {
		warnings.push(`Missing host for SSH entry: ${name}`);
		return null;
	}

	const port = parsePort(raw.port);
	if (raw.port !== undefined && port === undefined) {
		warnings.push(`Invalid port for SSH entry ${name}: ${String(raw.port)}`);
	}

	const compat = parseCompat(raw.compat);
	if (raw.compat !== undefined && compat === undefined) {
		warnings.push(`Invalid compat flag for SSH entry ${name}: ${String(raw.compat)}`);
	}

	const keyValue = raw.keyPath ?? raw.key;
	const keyPath = keyValue ? expandTilde(keyValue, home) : undefined;

	return {
		name,
		host: raw.host,
		username: raw.username,
		port,
		keyPath,
		description: raw.description,
		compat,
		_source: source,
	};
}

async function loadSshJsonFile(
	ctx: LoadContext,
	filePath: string,
	level: "user" | "project",
): Promise<LoadResult<SSHHost>> {
	const items: SSHHost[] = [];
	const warnings: string[] = [];
	const content = await readFile(filePath);
	if (content === null) {
		return { items, warnings };
	}
	const parsed = tryParseJson<SSHConfigFile>(content);
	if (!parsed) {
		warnings.push(`Failed to parse JSON in ${filePath}`);
		return { items, warnings };
	}
	const config = expandEnvVarsDeep(parsed);
	if (!config.hosts || typeof config.hosts !== "object") {
		warnings.push(`Missing hosts in ${filePath}`);
		return { items, warnings };
	}

	const source = createSourceMeta(PROVIDER_ID, filePath, level);
	for (const [name, rawHost] of Object.entries(config.hosts)) {
		if (!name.trim()) {
			warnings.push(`Invalid SSH host name in ${filePath}`);
			continue;
		}
		if (!rawHost || typeof rawHost !== "object") {
			warnings.push(`Invalid host entry in ${filePath}: ${name}`);
			continue;
		}
		const host = normalizeHost(name, rawHost, source, ctx.home, warnings);
		if (host) items.push(host);
	}

	return {
		items,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}
async function load(ctx: LoadContext): Promise<LoadResult<SSHHost>> {
	const items: SSHHost[] = [];
	const warnings: string[] = [];

	// PRIMARY: Settings (spell.kdl `ssh { target ... }` block). Per-tier read
	// mirrors MCP precedence: higher tiers (project/local/session) override
	// lower (user) on same-name collision; warn on conflict.
	const { settings } = await import("../config/settings");
	const spellTiers = settings.getPerTier("ssh.hosts" as never);
	const tierEntries: Array<{ tier: "user" | "project"; value: unknown }> = [
		{ tier: "user", value: spellTiers.user },
		{ tier: "project", value: spellTiers.project },
		{ tier: "project", value: spellTiers.local },
		{ tier: "project", value: spellTiers.session },
	];
	const spellSources = new Map<string, "user" | "project">();
	const itemsByName = new Map<string, SSHHost>();
	for (const { tier, value } of tierEntries) {
		if (!value || typeof value !== "object") continue;
		const expanded = expandEnvVarsDeep(value as Record<string, unknown>);
		for (const [name, raw] of Object.entries(expanded as Record<string, unknown>)) {
			const prior = spellSources.get(name);
			if (prior && prior !== tier) {
				warnings.push(`SSH target "${name}": defined at both ${prior}-tier and ${tier}-tier; ${tier}-tier wins`);
			}
			spellSources.set(name, tier);
			const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
			const host = typeof cfg.host === "string" ? cfg.host : undefined;
			if (!host) {
				warnings.push(`SSH target "${name}": missing host; skipping`);
				continue;
			}
			const keyPathRaw = typeof cfg.keyPath === "string" ? cfg.keyPath : undefined;
			itemsByName.set(name, {
				name,
				host,
				username: typeof cfg.username === "string" ? cfg.username : undefined,
				port: typeof cfg.port === "number" && Number.isFinite(cfg.port) ? cfg.port : undefined,
				keyPath: keyPathRaw ? expandTilde(keyPathRaw, ctx.home) : undefined,
				compat: typeof cfg.compat === "boolean" ? cfg.compat : undefined,
				description: typeof cfg.description === "string" ? cfg.description : undefined,
				_source: createSourceMeta(PROVIDER_ID, `<spell.kdl:${tier}>`, tier),
			} as SSHHost);
		}
	}
	items.push(...itemsByName.values());
	const seenNames = new Set(itemsByName.keys());

	// LEGACY: continue reading ssh.json files during the migration window.
	const candidateSources: Array<{ path: string; level: "user" | "project" }> = [
		{ path: getSSHConfigPath("project", ctx.cwd), level: "project" },
		{ path: getSSHConfigPath("user", ctx.cwd), level: "user" },
		{ path: path.join(ctx.cwd, "ssh.json"), level: "project" },
		{ path: path.join(ctx.cwd, ".ssh.json"), level: "project" },
	];
	const uniqueSources = candidateSources.filter(
		(source, index, arr) => arr.findIndex(candidate => candidate.path === source.path) === index,
	);
	const results = await Promise.all(uniqueSources.map(source => loadSshJsonFile(ctx, source.path, source.level)));
	for (const r of results) {
		for (const host of r.items) {
			if (seenNames.has(host.name)) {
				warnings.push(
					`SSH target "${host.name}": defined in both spell.kdl and a legacy ssh.json; spell.kdl wins (legacy file shadowed)`,
				);
				continue;
			}
			seenNames.add(host.name);
			items.push(host);
		}
		if (r.warnings) warnings.push(...r.warnings);
	}
	return {
		items,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}

registerProvider(sshCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load SSH hosts from managed spell paths and legacy ssh.json/.ssh.json files",
	priority: 5,
	load,
});
