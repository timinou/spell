import { Document, type Node, Node as NodeClass } from "@bgotink/kdl";

import { getChildNodes, getStringArgument } from "./kdl-helpers";

export interface KdlCompatWarning {
	path: string;
	message: string;
}

export interface KdlCompatResult<T> {
	value: T;
	warnings: KdlCompatWarning[];
}

const STATUS_LINE_SEGMENT_PROPS = {
	model: { "show-thinking-level": "showThinkingLevel" },
	path: {
		abbreviate: "abbreviate",
		"max-length": "maxLength",
		"strip-work-prefix": "stripWorkPrefix",
	},
	git: {
		"show-branch": "showBranch",
		"show-staged": "showStaged",
		"show-unstaged": "showUnstaged",
		"show-untracked": "showUntracked",
	},
	time: {
		format: "format",
		"show-seconds": "showSeconds",
	},
} as const;

type KnownStatusLineSegment = keyof typeof STATUS_LINE_SEGMENT_PROPS;

function clearNodeEntries(node: Node): void {
	const mutableNode = node as Node & { entries?: unknown[] };
	mutableNode.entries = [];
}

function createNodeWithStringArgument(name: string, value: string): Node {
	const node = NodeClass.create(name);
	node.addArgument(value);
	return node;
}

function setStringRecordChildren(node: Node, entries: Array<[string, string]>): void {
	clearNodeEntries(node);
	node.children = new Document(entries.map(([name, value]) => createNodeWithStringArgument(name, value)));
}

function readLegacyPropertyBag(node: Node, warningPath: string): KdlCompatResult<Record<string, string>> {
	const value: Record<string, string> = {};
	const warnings: KdlCompatWarning[] = [];
	for (const [key, propertyValue] of node.getProperties()) {
		if (typeof propertyValue !== "string") continue;
		value[key] = propertyValue;
	}
	if (Object.keys(value).length > 0) {
		warnings.push({
			path: warningPath,
			message: "legacy property-bag shape read for compatibility; writer will canonicalize child nodes",
		});
	}
	return { value, warnings };
}

function toCamelCase(name: string): string {
	return name.replaceAll(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function toKebabCase(name: string): string {
	return name.replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function isKnownStatusLineSegment(name: string): name is KnownStatusLineSegment {
	return Object.hasOwn(STATUS_LINE_SEGMENT_PROPS, name);
}

function readKnownSegmentProperties(segment: KnownStatusLineSegment, node: Node): Record<string, unknown> {
	const mapping = STATUS_LINE_SEGMENT_PROPS[segment];
	const value: Record<string, unknown> = {};
	for (const [key, propertyValue] of node.getProperties()) {
		const normalizedKey = mapping[key as keyof typeof mapping] ?? toCamelCase(key);
		value[normalizedKey] = propertyValue;
	}
	return value;
}

function writeKnownSegmentProperties(
	segment: KnownStatusLineSegment,
	node: Node,
	value: Record<string, unknown>,
): void {
	const reverseMapping = Object.fromEntries(
		Object.entries(STATUS_LINE_SEGMENT_PROPS[segment]).map(([kdlName, internalName]) => [internalName, kdlName]),
	);
	for (const [key, propertyValue] of Object.entries(value)) {
		const normalizedKey = reverseMapping[key] ?? toKebabCase(key);
		node.setProperty(normalizedKey, propertyValue as never);
	}
}

function readChildStringEntries(node: Node): Array<[string, string]> {
	const entries: Array<[string, string]> = [];
	for (const child of getChildNodes(node)) {
		const value = getStringArgument(child);
		if (value !== undefined) entries.push([child.getName(), value]);
	}
	return entries;
}

export function readTreeStringRecord(node: Node, warningPath: string): KdlCompatResult<Record<string, string>> {
	const legacy = readLegacyPropertyBag(node, warningPath);
	const value = { ...legacy.value };
	for (const [name, entryValue] of readChildStringEntries(node)) value[name] = entryValue;
	return { value, warnings: legacy.warnings };
}

export function writeTreeStringRecord(node: Node, value: Record<string, string>): void {
	setStringRecordChildren(node, Object.entries(value));
}

export function readAllowedFolders(node: Node): KdlCompatResult<Record<string, string>> {
	const legacy = readLegacyPropertyBag(node, "planMode.allowedFolders");
	const value = { ...legacy.value };
	const warnings = [...legacy.warnings];
	for (const child of getChildNodes(node)) {
		if (child.getName() !== "folder") {
			warnings.push({
				path: `planMode.allowedFolders.${child.getName()}`,
				message: "unknown node preserved outside canonical allowed-folders entries",
			});
			continue;
		}
		const folderPath = getStringArgument(child);
		if (!folderPath) continue;
		const description = child.getProperty("description");
		value[folderPath] = typeof description === "string" ? description : "";
	}
	return { value, warnings };
}

export function writeAllowedFolders(node: Node, value: Record<string, string>): void {
	clearNodeEntries(node);
	const children = new Document([]);
	for (const [folderPath, description] of Object.entries(value)) {
		const child = NodeClass.create("folder");
		child.addArgument(folderPath);
		child.setProperty("description", description);
		children.appendNode(child);
	}
	node.children = children;
}

export function readStatusLineSegmentOptions(node: Node): KdlCompatResult<Record<string, unknown>> {
	const value: Record<string, unknown> = {};
	const warnings: KdlCompatWarning[] = [];
	for (const child of getChildNodes(node)) {
		const childName = child.getName();
		if (childName === "segment") {
			const legacyName = getStringArgument(child);
			if (!legacyName) continue;
			value[legacyName] = Object.fromEntries(child.getProperties());
			warnings.push({
				path: `statusLine.segmentOptions.${legacyName}`,
				message: "legacy generic segment shape read for compatibility; writer will canonicalize typed child blocks",
			});
			continue;
		}

		if (isKnownStatusLineSegment(childName)) {
			value[childName] = readKnownSegmentProperties(childName, child);
			continue;
		}

		value[childName] = Object.fromEntries(child.getProperties());
		warnings.push({
			path: `statusLine.segmentOptions.${childName}`,
			message: "unknown segment block preserved during round-trip",
		});
	}
	return { value, warnings };
}

export function writeStatusLineSegmentOptions(node: Node, value: Record<string, unknown>): void {
	clearNodeEntries(node);
	const children = new Document([]);
	for (const [segmentName, segmentValue] of Object.entries(value)) {
		if (!segmentValue || typeof segmentValue !== "object" || Array.isArray(segmentValue)) continue;
		const child = NodeClass.create(segmentName);
		if (isKnownStatusLineSegment(segmentName)) {
			writeKnownSegmentProperties(segmentName, child, segmentValue as Record<string, unknown>);
		} else {
			for (const [key, propertyValue] of Object.entries(segmentValue)) {
				child.setProperty(key, propertyValue as never);
			}
		}
		children.appendNode(child);
	}
	node.children = children;
}

// =============================================================================
// secrets — secret obfuscation entries
// =============================================================================
//
// On disk:
//
//   secrets {
//     secret type=plain content="sk-..."
//     secret type=regex content="AKIA[0-9A-Z]{16}"
//     secret type=regex content="postgres://[^\\s]+" mode=replace replacement="<x>" flags="i"
//   }
//
// In memory: Array<{ type, content, mode?, replacement?, flags? }>.

export interface SecretsKdlEntry {
	type: "plain" | "regex";
	content: string;
	mode?: "obfuscate" | "replace";
	replacement?: string;
	flags?: string;
}

export function readSecrets(node: Node): KdlCompatResult<SecretsKdlEntry[]> {
	const value: SecretsKdlEntry[] = [];
	const warnings: KdlCompatWarning[] = [];
	for (const child of getChildNodes(node)) {
		if (child.getName() !== "secret") {
			warnings.push({
				path: `secrets.${child.getName()}`,
				message: "unknown node inside `secrets` block ignored",
			});
			continue;
		}
		const rawType = child.getProperty("type");
		if (rawType !== "plain" && rawType !== "regex") {
			warnings.push({
				path: "secrets.secret",
				message: `unknown type ${JSON.stringify(rawType)}; expected "plain" or "regex"`,
			});
			continue;
		}
		const content = child.getProperty("content");
		if (typeof content !== "string" || content.length === 0) {
			warnings.push({ path: "secrets.secret", message: "missing content; skipping" });
			continue;
		}
		const entry: SecretsKdlEntry = { type: rawType, content };
		const rawMode = child.getProperty("mode");
		if (rawMode === "obfuscate" || rawMode === "replace") entry.mode = rawMode;
		const replacement = child.getProperty("replacement");
		if (typeof replacement === "string") entry.replacement = replacement;
		const flags = child.getProperty("flags");
		if (typeof flags === "string") entry.flags = flags;
		value.push(entry);
	}
	return { value, warnings };
}

export function writeSecrets(node: Node, value: SecretsKdlEntry[]): void {
	clearNodeEntries(node);
	const children = new Document([]);
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const child = NodeClass.create("secret");
		child.setProperty("type", entry.type);
		child.setProperty("content", entry.content);
		if (entry.mode) child.setProperty("mode", entry.mode);
		if (entry.replacement !== undefined) child.setProperty("replacement", entry.replacement);
		if (entry.flags !== undefined) child.setProperty("flags", entry.flags);
		children.appendNode(child);
	}
	node.children = children;
}


// =============================================================================
// mcp.servers — MCP server config map
// =============================================================================
//
// On disk:
//
//   mcp {
//     server "memory" type="stdio" enabled=true timeout=30 {
//       command "mcp-memory"
//       args "--db" "./memory.db"
//       env "FOO" "bar"
//     }
//     server "exa" type="http" {
//       url "https://mcp.exa.ai/sse?exaApiKey=..."
//       headers "X-Foo" "bar"
//     }
//   }
//
// In memory: Record<serverName, McpServerKdlEntry>.

export interface McpServerKdlEntry {
	type?: "stdio" | "http" | "sse";
	enabled?: boolean;
	timeout?: number;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	// `tokenUrl`/`clientId`/`clientSecret` are the OAuth refresh coordinates that
	// `MCPManager.#resolveAuthConfig` needs to refresh an expiring token. They are
	// non-secret coordinates safe to persist in spell.kdl; `clientSecret` MUST be
	// an env-var NAME (resolved via resolveConfigValue), never a literal secret.
	auth?: {
		type: "oauth" | "apikey";
		credentialId?: string;
		tokenUrl?: string;
		clientId?: string;
		clientSecret?: string;
	};
	oauth?: { clientId?: string; callbackPort?: number };
}

function readStringRecordFromKv(parent: Node, name: string): Record<string, string> | undefined {
	const rec: Record<string, string> = {};
	let found = false;
	for (const child of getChildNodes(parent)) {
		if (child.getName() !== name) continue;
		const args = [...child.getArguments()];
		if (args.length < 2) continue;
		const k = args[0];
		const v = args[1];
		if (typeof k !== "string" || typeof v !== "string") continue;
		rec[k] = v;
		found = true;
	}
	return found ? rec : undefined;
}

function writeStringRecordKv(name: string, value: Record<string, string>, children: Document): void {
	for (const [k, v] of Object.entries(value)) {
		const node = NodeClass.create(name);
		node.addArgument(k);
		node.addArgument(v);
		children.appendNode(node);
	}
}

export function readMcpServers(node: Node): KdlCompatResult<Record<string, McpServerKdlEntry>> {
	const value: Record<string, McpServerKdlEntry> = {};
	const warnings: KdlCompatWarning[] = [];
	for (const child of getChildNodes(node)) {
		if (child.getName() !== "server") {
			warnings.push({
				path: `mcp.${child.getName()}`,
				message: "unknown node inside `mcp` block ignored (expected `server`)",
			});
			continue;
		}
		const name = getStringArgument(child);
		if (!name) {
			warnings.push({ path: "mcp.server", message: "missing server name; skipping" });
			continue;
		}

		const entry: McpServerKdlEntry = {};
		const rawType = child.getProperty("type");
		if (rawType === "stdio" || rawType === "http" || rawType === "sse") entry.type = rawType;
		else if (rawType !== undefined)
			warnings.push({ path: `mcp.servers.${name}.type`, message: `unknown type ${JSON.stringify(rawType)}` });

		const rawEnabled = child.getProperty("enabled");
		if (typeof rawEnabled === "boolean") entry.enabled = rawEnabled;

		const rawTimeout = child.getProperty("timeout");
		if (typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0) entry.timeout = rawTimeout;

		const commandNode = getChildNodes(child).find(n => n.getName() === "command");
		if (commandNode) {
			const cmd = getStringArgument(commandNode);
			if (cmd) entry.command = cmd;
		}

		const argsNode = getChildNodes(child).find(n => n.getName() === "args");
		if (argsNode) {
			const args = [...argsNode.getArguments()].filter((a): a is string => typeof a === "string");
			if (args.length > 0) entry.args = args;
		}

		const env = readStringRecordFromKv(child, "env");
		if (env) entry.env = env;

		const urlNode = getChildNodes(child).find(n => n.getName() === "url");
		if (urlNode) {
			const url = getStringArgument(urlNode);
			if (url) entry.url = url;
		}

		const headers = readStringRecordFromKv(child, "headers");
		if (headers) entry.headers = headers;

		const authNode = getChildNodes(child).find(n => n.getName() === "auth");
		if (authNode) {
			const authType = authNode.getProperty("type");
			if (authType === "oauth" || authType === "apikey") {
				const credentialId = authNode.getProperty("credentialId");
				const tokenUrl = authNode.getProperty("tokenUrl");
				const clientId = authNode.getProperty("clientId");
				const clientSecret = authNode.getProperty("clientSecret");
				entry.auth = {
					type: authType,
					...(typeof credentialId === "string" ? { credentialId } : {}),
					...(typeof tokenUrl === "string" ? { tokenUrl } : {}),
					...(typeof clientId === "string" ? { clientId } : {}),
					...(typeof clientSecret === "string" ? { clientSecret } : {}), // pragma: allowlist secret
				};
			}
		}

		const oauthNode = getChildNodes(child).find(n => n.getName() === "oauth");
		if (oauthNode) {
			const clientId = oauthNode.getProperty("clientId");
			const callbackPort = oauthNode.getProperty("callbackPort");
			entry.oauth = {
				...(typeof clientId === "string" ? { clientId } : {}),
				...(typeof callbackPort === "number" ? { callbackPort } : {}),
			};
		}

		value[name] = entry;
	}
	return { value, warnings };
}

export function writeMcpServers(node: Node, value: Record<string, McpServerKdlEntry>): void {
	clearNodeEntries(node);
	const children = new Document([]);
	for (const [name, entry] of Object.entries(value)) {
		if (!entry || typeof entry !== "object") continue;
		const server = NodeClass.create("server");
		server.addArgument(name);
		if (entry.type) server.setProperty("type", entry.type);
		if (entry.enabled !== undefined) server.setProperty("enabled", entry.enabled);
		if (entry.timeout !== undefined) server.setProperty("timeout", entry.timeout);

		const serverChildren = new Document([]);
		if (entry.command) {
			const n = NodeClass.create("command");
			n.addArgument(entry.command);
			serverChildren.appendNode(n);
		}
		if (entry.args && entry.args.length > 0) {
			const n = NodeClass.create("args");
			for (const a of entry.args) n.addArgument(a);
			serverChildren.appendNode(n);
		}
		if (entry.env) writeStringRecordKv("env", entry.env, serverChildren);
		if (entry.url) {
			const n = NodeClass.create("url");
			n.addArgument(entry.url);
			serverChildren.appendNode(n);
		}
		if (entry.headers) writeStringRecordKv("headers", entry.headers, serverChildren);
		if (entry.auth) {
			const n = NodeClass.create("auth");
			n.setProperty("type", entry.auth.type);
			if (entry.auth.credentialId !== undefined) n.setProperty("credentialId", entry.auth.credentialId);
			if (entry.auth.tokenUrl !== undefined) n.setProperty("tokenUrl", entry.auth.tokenUrl);
			if (entry.auth.clientId !== undefined) n.setProperty("clientId", entry.auth.clientId);
			if (entry.auth.clientSecret !== undefined) n.setProperty("clientSecret", entry.auth.clientSecret);
			serverChildren.appendNode(n);
		}
		if (entry.oauth) {
			const n = NodeClass.create("oauth");
			if (entry.oauth.clientId !== undefined) n.setProperty("clientId", entry.oauth.clientId);
			if (entry.oauth.callbackPort !== undefined) n.setProperty("callbackPort", entry.oauth.callbackPort);
			serverChildren.appendNode(n);
		}
		server.children = serverChildren;
		children.appendNode(server);
	}
	node.children = children;
}


// =============================================================================
// ssh.hosts — SSH host config map
// =============================================================================
//
// On disk:
//
//   ssh {
//     target "prod" hostname="prod.example.com" username="deploy" port=22 \
//                   key-path="~/.ssh/prod" description="Production" compat=true
//     target "staging" hostname="staging.example.com" username="deploy"
//   }
//
// In memory: Record<targetName, SshHostKdlEntry>.

export interface SshHostKdlEntry {
	host?: string;
	username?: string;
	port?: number;
	keyPath?: string;
	compat?: boolean;
	description?: string;
}

export function readSshHosts(node: Node): KdlCompatResult<Record<string, SshHostKdlEntry>> {
	const value: Record<string, SshHostKdlEntry> = {};
	const warnings: KdlCompatWarning[] = [];
	for (const child of getChildNodes(node)) {
		if (child.getName() !== "target") {
			warnings.push({
				path: `ssh.${child.getName()}`,
				message: "unknown node inside `ssh` block ignored (expected `target`)",
			});
			continue;
		}
		const name = getStringArgument(child);
		if (!name) {
			warnings.push({ path: "ssh.target", message: "missing target name; skipping" });
			continue;
		}
		const entry: SshHostKdlEntry = {};
		const hostname = child.getProperty("hostname") ?? child.getProperty("host");
		if (typeof hostname === "string") entry.host = hostname;
		const username = child.getProperty("username") ?? child.getProperty("user");
		if (typeof username === "string") entry.username = username;
		const port = child.getProperty("port");
		if (typeof port === "number" && Number.isFinite(port)) entry.port = port;
		const keyPath = child.getProperty("key-path") ?? child.getProperty("keyPath");
		if (typeof keyPath === "string") entry.keyPath = keyPath;
		const compat = child.getProperty("compat");
		if (typeof compat === "boolean") entry.compat = compat;
		const description = child.getProperty("description");
		if (typeof description === "string") entry.description = description;
		value[name] = entry;
	}
	return { value, warnings };
}

export function writeSshHosts(node: Node, value: Record<string, SshHostKdlEntry>): void {
	clearNodeEntries(node);
	const children = new Document([]);
	for (const [name, entry] of Object.entries(value)) {
		if (!entry || typeof entry !== "object") continue;
		const target = NodeClass.create("target");
		target.addArgument(name);
		if (entry.host !== undefined) target.setProperty("hostname", entry.host);
		if (entry.username !== undefined) target.setProperty("username", entry.username);
		if (entry.port !== undefined) target.setProperty("port", entry.port);
		if (entry.keyPath !== undefined) target.setProperty("key-path", entry.keyPath);
		if (entry.compat !== undefined) target.setProperty("compat", entry.compat);
		if (entry.description !== undefined) target.setProperty("description", entry.description);
		children.appendNode(target);
	}
	node.children = children;
}

