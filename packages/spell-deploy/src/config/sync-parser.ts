import type { Node } from "@bgotink/kdl";
import { parse } from "@bgotink/kdl";
import type { BundleConfig, ServiceConfig, SyncConfig, SyncSettings, SyncTarget } from "./types";

const DEFAULT_PUSH_DEBOUNCE = "2s";
const DEFAULT_PULL_INTERVAL = "30s";
const DEFAULT_BUNDLE_PLATFORM = "linux-x64";
const DEFAULT_BUNDLE_CACHE_DIR = ".spell/bundle-cache/";
const DEFAULT_TARGET_USER = "root";
const DEFAULT_TARGET_PORT = 22;

function expectStringArgument(node: Node, pathLabel: string, argumentIndex = 0): string {
	const value = node.getArgument(argumentIndex);
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${pathLabel} must have a non-empty string argument`);
	}
	return value;
}

function expectNumberArgument(node: Node, pathLabel: string, argumentIndex = 0): number {
	const value = node.getArgument(argumentIndex);
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${pathLabel} must have a finite number argument`);
	}
	return value;
}

function getStringProperty(node: Node, property: string, pathLabel: string): string | undefined {
	const value = node.getProperty(property);
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${pathLabel}.${property} must be a non-empty string`);
	}
	return value;
}

function parseStringArguments(node: Node, pathLabel: string): string[] {
	return node.getArguments().map((_, index) => expectStringArgument(node, `${pathLabel}[${index}]`, index));
}

function parseServiceNode(node: Node, pathLabel: string): ServiceConfig {
	const type = getStringProperty(node, "type", pathLabel);
	const unit = getStringProperty(node, "unit", pathLabel);
	if (type !== "systemd") {
		throw new Error(`${pathLabel}.type must be "systemd"`);
	}
	if (!unit) {
		throw new Error(`${pathLabel}.unit is required`);
	}
	return { type, unit };
}

function parseTargetNode(node: Node, pathLabel: string): SyncTarget {
	const name = expectStringArgument(node, `${pathLabel}.name`);
	let host: string | undefined;
	let user = DEFAULT_TARGET_USER;
	let port = DEFAULT_TARGET_PORT;
	let sshKey: string | undefined;
	let projectRoot: string | undefined;
	let service: ServiceConfig | undefined;
	let secrets: string | undefined;
	let include: string[] = [];
	let exclude: string[] = [];

	for (const child of node.children?.nodes ?? []) {
		const childName = child.getName();
		if (childName === "host") {
			host = expectStringArgument(child, `${pathLabel}.host`);
			continue;
		}
		if (childName === "user") {
			user = expectStringArgument(child, `${pathLabel}.user`);
			continue;
		}
		if (childName === "port") {
			port = expectNumberArgument(child, `${pathLabel}.port`);
			continue;
		}
		if (childName === "ssh-key") {
			sshKey = expectStringArgument(child, `${pathLabel}.sshKey`);
			continue;
		}
		if (childName === "project-root") {
			projectRoot = expectStringArgument(child, `${pathLabel}.projectRoot`);
			continue;
		}
		if (childName === "service") {
			service = parseServiceNode(child, `${pathLabel}.service`);
			continue;
		}
		if (childName === "secrets") {
			secrets = expectStringArgument(child, `${pathLabel}.secrets`);
			continue;
		}
		if (childName === "include") {
			include = parseStringArguments(child, `${pathLabel}.include`);
			continue;
		}
		if (childName === "exclude") {
			exclude = parseStringArguments(child, `${pathLabel}.exclude`);
		}
	}

	if (!host) {
		throw new Error(`${pathLabel}.host is required`);
	}
	if (!projectRoot) {
		throw new Error(`${pathLabel}.projectRoot is required`);
	}

	return {
		name,
		host,
		user,
		port,
		sshKey,
		projectRoot,
		service,
		secrets,
		include,
		exclude,
	};
}

function parseSyncNode(node: Node, pathLabel: string): SyncSettings {
	let pushDebounce = DEFAULT_PUSH_DEBOUNCE;
	let pull: string[] = [];
	let pullInterval = DEFAULT_PULL_INTERVAL;

	for (const child of node.children?.nodes ?? []) {
		const childName = child.getName();
		if (childName === "push-debounce") {
			pushDebounce = expectStringArgument(child, `${pathLabel}.pushDebounce`);
			continue;
		}
		if (childName === "pull") {
			pull = parseStringArguments(child, `${pathLabel}.pull`);
			continue;
		}
		if (childName === "pull-interval") {
			pullInterval = expectStringArgument(child, `${pathLabel}.pullInterval`);
		}
	}

	return { pushDebounce, pull, pullInterval };
}

function parseBundleNode(node: Node, pathLabel: string): BundleConfig {
	let platform = DEFAULT_BUNDLE_PLATFORM;
	let cacheDir = DEFAULT_BUNDLE_CACHE_DIR;

	for (const child of node.children?.nodes ?? []) {
		const childName = child.getName();
		if (childName === "platform") {
			platform = expectStringArgument(child, `${pathLabel}.platform`);
			continue;
		}
		if (childName === "cache-dir") {
			cacheDir = expectStringArgument(child, `${pathLabel}.cacheDir`);
		}
	}

	return { platform, cacheDir };
}

export function parseSyncConfig(kdlText: string): SyncConfig {
	const document = parse(kdlText);
	let defaultTarget: string | undefined;
	const targets = new Map<string, SyncTarget>();
	let sync: SyncSettings = {
		pushDebounce: DEFAULT_PUSH_DEBOUNCE,
		pull: [],
		pullInterval: DEFAULT_PULL_INTERVAL,
	};
	let bundle: BundleConfig = {
		platform: DEFAULT_BUNDLE_PLATFORM,
		cacheDir: DEFAULT_BUNDLE_CACHE_DIR,
	};

	for (const node of document.nodes) {
		const name = node.getName();
		if (name === "default-target") {
			defaultTarget = expectStringArgument(node, "sync.defaultTarget");
			continue;
		}
		if (name === "target") {
			const target = parseTargetNode(node, `sync.targets.${expectStringArgument(node, "sync.targets.name")}`);
			if (targets.has(target.name)) {
				throw new Error(`Duplicate target name: ${target.name}`);
			}
			targets.set(target.name, target);
			continue;
		}
		if (name === "sync") {
			sync = parseSyncNode(node, "sync.settings");
			continue;
		}
		if (name === "bundle") {
			bundle = parseBundleNode(node, "sync.bundle");
		}
	}

	if (targets.size === 0) {
		throw new Error("At least one target is required");
	}

	const resolvedDefaultTarget = defaultTarget ?? targets.keys().next().value;
	if (resolvedDefaultTarget === undefined || !targets.has(resolvedDefaultTarget)) {
		throw new Error(`default-target references unknown target: ${defaultTarget}`);
	}

	return {
		defaultTarget: resolvedDefaultTarget,
		targets,
		sync,
		bundle,
	};
}
