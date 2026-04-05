import { Document, format, Node } from "@bgotink/kdl";
import type { ActionScalar, ManifestAction } from "../actions/types";
import type {
	AutonomyManifest,
	Checkpoint,
	ExportTarget,
	FilterConfig,
	HookTarget,
	Layout,
	ManifestGoal,
	ManifestHookConfig,
	ManifestSetup,
	NamedStateStore,
	NotificationRoute,
	OperatorAction,
	Panel,
	RetryConfig,
	ReviewPolicy,
	SandboxConfig,
	StateConfig,
	StateSchema,
	SyncCollection,
	ToolModule,
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

function appendStateStoreChildren(parent: Node, stateStores: Map<string, NamedStateStore> | undefined): void {
	if (!stateStores || stateStores.size === 0) return;
	parent.children ??= new Document();
	for (const [name, stateStore] of stateStores) {
		const node = createNode("state-store");
		node.addArgument(name);
		node.setProperty("backend", stateStore.backend);
		node.setProperty("path", stateStore.path);
		if (stateStore.schema) node.setProperty("schema", stateStore.schema);
		parent.children.appendNode(node);
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
	for (const target of targets) group.children.appendNode(createHookTargetNode(target));
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

function isActionScalar(value: ManifestAction["params"][string]): value is ActionScalar {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isScalarList(value: ManifestAction["params"][string]): value is ActionScalar[] {
	return Array.isArray(value) && value.every(entry => isActionScalar(entry));
}

function appendActionChildren(parent: Node, action: ManifestAction): void {
	const actionNode = createNode("action");
	actionNode.addArgument(action.id);
	actionNode.children = new Document();
	for (const [name, value] of Object.entries(action.params)) {
		if (isScalarList(value)) {
			const paramListNode = createNode("param-list");
			paramListNode.addArgument(name);
			for (const entry of value) {
				paramListNode.addArgument(entry);
			}
			actionNode.children.appendNode(paramListNode);
			continue;
		}
		if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
			const paramJsonNode = createNode("param-json");
			paramJsonNode.addArgument(name);
			paramJsonNode.addArgument(JSON.stringify(value));
			actionNode.children.appendNode(paramJsonNode);
			continue;
		}
		const paramNode = createNode("param");
		paramNode.addArgument(name);
		paramNode.addArgument(value);
		actionNode.children.appendNode(paramNode);
	}
	for (const [slotName, slot] of Object.entries(action.promptSlots)) {
		const slotNode = createNode(slot.kind === "file" ? "prompt-file" : "prompt");
		slotNode.addArgument(slotName);
		slotNode.addArgument(slot.kind === "file" ? (slot.path ?? "") : (slot.content ?? ""));
		actionNode.children.appendNode(slotNode);
	}
	parent.children!.appendNode(actionNode);
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
	appendStateStoreChildren(node, setup.stateStores);
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
	if (goal.prompt) {
		const promptNode = createNode("prompt");
		promptNode.addArgument(goal.prompt);
		node.children.appendNode(promptNode);
	}
	if (goal.action) {
		appendActionChildren(node, goal.action);
	}
	if (goal.hooks) {
		const hooksNode = createHooksNode(goal.hooks);
		if (hooksNode) node.children.appendNode(hooksNode);
	}
	if (goal.state) node.children.appendNode(createStateNode(goal.state));
	appendStateStoreChildren(node, goal.stateStores);
	if (goal.retry) {
		const retryNode = createRetryNode(goal.retry);
		if (retryNode) node.children.appendNode(retryNode);
	}
	return node;
}

function createExportTargetNode(target: ExportTarget): Node {
	const node = createNode("export-target");
	node.addArgument(target.id);
	node.setProperty("kind", target.kind);
	if (target.url !== undefined) node.setProperty("url", target.url);
	if (target.path !== undefined) node.setProperty("path", target.path);
	if (target.format !== undefined) node.setProperty("format", target.format);
	return node;
}

function createNotificationRouteNode(route: NotificationRoute): Node {
	const node = createNode("notification-route");
	node.addArgument(route.id);
	node.setProperty("channel", route.channel);
	node.setProperty("on", route.on);
	if (route.chatId !== undefined) node.setProperty("chat-id", route.chatId);
	if (route.url !== undefined) node.setProperty("url", route.url);
	if (route.category !== undefined) node.setProperty("category", route.category);
	return node;
}

function createReviewPolicyNode(policy: ReviewPolicy): Node {
	const node = createNode("review-policy");
	node.addArgument(policy.id);
	node.children = new Document();
	for (const state of policy.states) {
		const stateNode = createNode("state");
		stateNode.addArgument(state.name);
		if (state.initial !== undefined) stateNode.setProperty("initial", state.initial);
		if (state.terminal !== undefined) stateNode.setProperty("terminal", state.terminal);
		node.children.appendNode(stateNode);
	}
	for (const transition of policy.transitions) {
		const transitionNode = createNode("transition");
		transitionNode.setProperty("from", transition.from);
		transitionNode.setProperty("to", transition.to);
		transitionNode.setProperty("action", transition.action);
		node.children.appendNode(transitionNode);
	}
	return node;
}

function createCheckpointNode(checkpoint: Checkpoint): Node {
	const node = createNode("checkpoint");
	node.addArgument(checkpoint.id);
	node.children = new Document();
	for (const req of checkpoint.requires) {
		const reqNode = createNode("require");
		reqNode.addArgument(req.name);
		reqNode.setProperty("kind", req.kind);
		if (req.policy !== undefined) reqNode.setProperty("policy", req.policy);
		if (req.state !== undefined) reqNode.setProperty("state", req.state);
		if (req.scope !== undefined) reqNode.setProperty("scope", req.scope);
		node.children.appendNode(reqNode);
	}
	return node;
}

function createPanelNode(panel: Panel): Node {
	const node = createNode("panel");
	node.addArgument(panel.id);
	node.setProperty("source", panel.source);
	node.children = new Document();
	for (const column of panel.columns) {
		const columnNode = createNode("column");
		columnNode.addArgument(column.name);
		columnNode.setProperty("type", column.type);
		node.children.appendNode(columnNode);
	}
	for (const action of panel.actions) {
		const actionNode = createNode("action");
		actionNode.addArgument(action.name);
		actionNode.setProperty("label", action.label);
		node.children.appendNode(actionNode);
	}
	return node;
}

function createLayoutNode(layout: Layout): Node {
	const node = createNode("layout");
	node.addArgument(layout.id);
	node.children = new Document();
	for (const region of layout.regions) {
		const regionNode = createNode("region");
		regionNode.addArgument(region.name);
		regionNode.setProperty("panel", region.panel);
		node.children.appendNode(regionNode);
	}
	return node;
}

function createSyncCollectionNode(sync: SyncCollection): Node {
	const node = createNode("sync-collection");
	node.addArgument(sync.id);
	node.setProperty("source", sync.source);
	if (sync.filter !== undefined) node.setProperty("filter", sync.filter);
	return node;
}

function createStateSchemaNode(schema: StateSchema): Node {
	const node = createNode("state-schema");
	node.addArgument(schema.id);
	node.setProperty("backend", schema.backend);
	node.children = new Document();
	for (const table of schema.tables) {
		const tableNode = createNode("table");
		tableNode.addArgument(table.name);
		tableNode.children = new Document();
		for (const column of table.columns) {
			const columnNode = createNode("column");
			columnNode.addArgument(column.name);
			columnNode.setProperty("type", column.type);
			if (column.primary !== undefined) columnNode.setProperty("primary", column.primary);
			tableNode.children.appendNode(columnNode);
		}
		node.children.appendNode(tableNode);
	}
	return node;
}

function createToolModuleNode(toolModule: ToolModule): Node {
	const node = createNode("tool-module");
	node.addArgument(toolModule.id);
	node.setProperty("path", toolModule.path);
	return node;
}

function createOperatorActionNode(action: OperatorAction): Node {
	const node = createNode("operator-action");
	node.addArgument(action.id);
	node.children = new Document();
	for (const transition of action.transitions) {
		const transitionNode = createNode("transition");
		transitionNode.setProperty("from", transition.from);
		transitionNode.setProperty("to", transition.to);
		node.children.appendNode(transitionNode);
	}
	if (action.triggerGoal) {
		const triggerNode = createNode("trigger-goal");
		triggerNode.addArgument(action.triggerGoal);
		node.children.appendNode(triggerNode);
	}
	if (action.downstreamJob) {
		const jobNode = createNode("downstream-job");
		jobNode.setProperty("kind", action.downstreamJob.kind);
		node.children.appendNode(jobNode);
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
	for (const target of manifest.exportTargets) document.appendNode(createExportTargetNode(target));
	for (const route of manifest.notificationRoutes) document.appendNode(createNotificationRouteNode(route));
	for (const policy of manifest.reviewPolicies) document.appendNode(createReviewPolicyNode(policy));
	for (const checkpoint of manifest.checkpoints) document.appendNode(createCheckpointNode(checkpoint));
	for (const panel of manifest.panels) document.appendNode(createPanelNode(panel));
	for (const layout of manifest.layouts) document.appendNode(createLayoutNode(layout));
	for (const sync of manifest.syncCollections) document.appendNode(createSyncCollectionNode(sync));
	for (const schema of manifest.stateSchemas) document.appendNode(createStateSchemaNode(schema));
	for (const tm of manifest.toolModules) document.appendNode(createToolModuleNode(tm));
	for (const oa of manifest.operatorActions) document.appendNode(createOperatorActionNode(oa));
	return format(document);
}
