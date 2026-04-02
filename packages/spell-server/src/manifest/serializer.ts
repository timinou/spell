import { Document, format, Node } from "@bgotink/kdl";
import type {
	AutonomyManifest,
	FilterConfig,
	HookTarget,
	ManifestGoal,
	ManifestHookConfig,
	ManifestSetup,
	RetryConfig,
	SandboxConfig,
	StateConfig,
} from "./types";

function createNode(name: string): Node {
	return Node.create(name);
}

function appendFilterChildren(parent: Node, config: FilterConfig | undefined): void {
	if (!config) return;
	parent.children = new Document();
	if (config.allow && config.allow.length > 0) {
		const allowNode = createNode("allow");
		for (const value of config.allow) allowNode.addArgument(value);
		parent.children.appendNode(allowNode);
	}
	if (config.deny && config.deny.length > 0) {
		const denyNode = createNode("deny");
		for (const value of config.deny) denyNode.addArgument(value);
		parent.children.appendNode(denyNode);
	}
}

function createSandboxNode(sandbox: SandboxConfig): Node {
	const node = createNode("sandbox");
	node.children = new Document();
	if (sandbox.pathsWrite && sandbox.pathsWrite.length > 0) {
		const pathsNode = createNode("paths-write");
		for (const value of sandbox.pathsWrite) pathsNode.addArgument(value);
		node.children.appendNode(pathsNode);
	}
	if (sandbox.bashAllow && sandbox.bashAllow.length > 0) {
		const allowNode = createNode("bash-allow");
		for (const value of sandbox.bashAllow) allowNode.addArgument(value);
		node.children.appendNode(allowNode);
	}
	if (sandbox.bashDeny && sandbox.bashDeny.length > 0) {
		const denyNode = createNode("bash-deny");
		for (const value of sandbox.bashDeny) denyNode.addArgument(value);
		node.children.appendNode(denyNode);
	}
	return node;
}

function createHookTargetNode(target: HookTarget): Node {
	if (target.type === "webhook") {
		const node = createNode("webhook");
		node.addArgument(target.url);
		if (target.method) node.setProperty("method", target.method);
		return node;
	}
	if (target.type === "telegram") {
		const node = createNode("telegram");
		node.setProperty("chat-id", target.chatId);
		return node;
	}
	const node = createNode("org");
	if (target.category) node.setProperty("category", target.category);
	return node;
}

function appendHookGroup(parent: Node, name: string, targets: HookTarget[] | undefined): void {
	if (!targets || targets.length === 0) return;
	const group = createNode(name);
	group.children = new Document();
	for (const target of targets) group.children!.appendNode(createHookTargetNode(target));
	parent.children!.appendNode(group);
}

function createHooksNode(hooks: ManifestHookConfig): Node | undefined {
	const node = createNode("hooks");
	node.children = new Document();
	appendHookGroup(node, "on-success", hooks.onSuccess);
	appendHookGroup(node, "on-failure", hooks.onFailure);
	appendHookGroup(node, "on-complete", hooks.onComplete);
	return node.children.isEmpty() ? undefined : node;
}

function createStateNode(state: StateConfig): Node {
	const node = createNode("state");
	node.setProperty("persist", state.persist);
	if (state.schema && state.schema.length > 0) {
		node.children = new Document();
		for (const column of state.schema) {
			const schemaNode = createNode("schema");
			schemaNode.addArgument(column.name);
			schemaNode.setProperty("type", column.type);
			node.children.appendNode(schemaNode);
		}
	}
	return node;
}

function createRetryNode(retry: RetryConfig): Node | undefined {
	const node = createNode("retry");
	if (retry.maxRetries !== undefined) node.setProperty("max-retries", retry.maxRetries);
	if (retry.initialDelayMs !== undefined) node.setProperty("initial-delay-ms", retry.initialDelayMs);
	if (retry.multiplier !== undefined) node.setProperty("multiplier", retry.multiplier);
	return node.entries.length === 0 ? undefined : node;
}

function createSetupNode(name: string, setup: ManifestSetup): Node {
	const node = createNode("setup");
	node.addArgument(name);
	node.children = new Document();

	const domainNode = createNode("domain");
	domainNode.addArgument(setup.domain);
	node.children.appendNode(domainNode);
	if (setup.mode) {
		const modeNode = createNode("mode");
		modeNode.addArgument(setup.mode);
		node.children.appendNode(modeNode);
	}
	if (setup.skills) {
		const skillsNode = createNode("skills");
		appendFilterChildren(skillsNode, setup.skills);
		node.children.appendNode(skillsNode);
	}
	if (setup.tools) {
		const toolsNode = createNode("tools");
		appendFilterChildren(toolsNode, setup.tools);
		node.children.appendNode(toolsNode);
	}
	if (setup.sandbox) {
		node.children.appendNode(createSandboxNode(setup.sandbox));
	}
	if (setup.timeout) {
		const timeoutNode = createNode("timeout");
		timeoutNode.addArgument(setup.timeout);
		node.children.appendNode(timeoutNode);
	}
	if (setup.maxCostUsd !== undefined) {
		const maxCostNode = createNode("max-cost-usd");
		maxCostNode.addArgument(setup.maxCostUsd);
		node.children.appendNode(maxCostNode);
	}
	return node;
}

function createScheduleNode(schedule: ManifestGoal["schedule"]): Node {
	const node = createNode("schedule");
	node.setProperty("type", schedule.type);
	if (schedule.type === "cron") {
		node.setProperty("expression", schedule.expression);
		if (schedule.timezone) node.setProperty("timezone", schedule.timezone);
		if (schedule.jitter) node.setProperty("jitter", schedule.jitter);
		return node;
	}
	if (schedule.path) node.setProperty("path", schedule.path);
	if (schedule.auth) node.setProperty("auth", schedule.auth);
	return node;
}

function createGoalNode(name: string, goal: ManifestGoal): Node {
	const node = createNode("goal");
	node.addArgument(name);
	node.children = new Document();

	const setupNode = createNode("setup");
	setupNode.addArgument(goal.setup);
	node.children.appendNode(setupNode);
	node.children.appendNode(createScheduleNode(goal.schedule));
	const promptNode = createNode("prompt");
	promptNode.addArgument(goal.prompt);
	node.children.appendNode(promptNode);
	if (goal.hooks) {
		const hooksNode = createHooksNode(goal.hooks);
		if (hooksNode) node.children.appendNode(hooksNode);
	}
	if (goal.state) node.children.appendNode(createStateNode(goal.state));
	if (goal.retry) {
		const retryNode = createRetryNode(goal.retry);
		if (retryNode) node.children.appendNode(retryNode);
	}
	return node;
}

export function serializeManifestKdl(manifest: AutonomyManifest): string {
	const document = new Document();
	const nameNode = createNode("name");
	nameNode.addArgument(manifest.name);
	document.appendNode(nameNode);
	const versionNode = createNode("version");
	versionNode.addArgument(manifest.version);
	document.appendNode(versionNode);
	for (const [name, setup] of manifest.setups) {
		document.appendNode(createSetupNode(name, setup));
	}
	for (const [name, goal] of manifest.goals) {
		document.appendNode(createGoalNode(name, goal));
	}
	return format(document);
}
