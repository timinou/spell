import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WorkflowEngine, emitWorkflowSyncSnapshot, groupWorkflowItems } from "../../../../packages/spell-server/src/workflow";
import { buildTelegramApprovalInbox, applyTelegramQuickAction } from "../../../../packages/spell-server/src/telegram/workflow-inbox";
import { buildApprovalSurfaceModel } from "../../../../packages/qml/src/approval-surface";
import { buildGoalsPanelModel } from "../../../../packages/qml/src/goals-panel";
import { loadSharedSyncState } from "../../../../packages/qml/src/shared-sync-state";
import { QmlTestHarness } from "../../../../packages/qml/src/test-harness";
import { sendGrowthFeed } from "../../../../packages/spell-growth/src/actions/feed-send";
import { exportPublicationArtifacts } from "../../../../packages/spell-growth/src/actions/export-publish";
import { createGrowthReviewApprovalActions } from "../../../../packages/spell-growth/src/workflow/presets";

const artifactDir = path.join(import.meta.dir);
const syncDir = path.join(artifactDir, "sync-state");
const exportDir = path.join(artifactDir, "export-proof");

function approvalActions() {
	return createGrowthReviewApprovalActions();
}

function checkpointActions() {
	return [
		{
			id: "resume",
			label: "Resume",
			fromStates: ["pending"],
			toState: "completed",
			checkpointEffect: { type: "resume-run" as const },
		},
	];
}

function renderSurfaceQml(title: string, lines: string[]): string {
	const textNodes = lines
		.map(
			line => `\t\tText { text: ${JSON.stringify(line)}; color: \"white\"; font.pixelSize: 18; wrapMode: Text.Wrap }`,
		)
		.join("\n");
	return `import QtQuick 2.15\nimport QtQuick.Controls 2.15\nimport QtQuick.Window 2.15\nWindow {\n\tvisible: true\n\twidth: 820\n\theight: 480\n\tcolor: \"#111827\"\n\tRectangle {\n\t\tanchors.fill: parent\n\t\tcolor: \"#111827\"\n\t\tColumn {\n\t\t\tanchors.fill: parent\n\t\t\tanchors.margins: 24\n\t\t\tspacing: 12\n\t\t\tText { text: ${JSON.stringify(title)}; color: \"#f9fafb\"; font.pixelSize: 28; font.bold: true }\n${textNodes}\n\t\t}\n\t}\n}\n`;
}

async function renderQmlScreenshot(qmlPath: string, screenshotPath: string): Promise<void> {
	const harness = new QmlTestHarness({ width: 820, height: 480 });
	await harness.setup(qmlPath);
	await Bun.sleep(300);
	await harness.screenshot(screenshotPath);
	await harness.teardown();
}

async function listFiles(rootDir: string, prefix = ""): Promise<string[]> {
	const entries = await fs.readdir(rootDir, { withFileTypes: true });
	const lines: string[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		lines.push(relative);
		if (entry.isDirectory()) {
			lines.push(...(await listFiles(path.join(rootDir, entry.name), relative)));
		}
	}
	return lines;
}

await fs.mkdir(artifactDir, { recursive: true });
await fs.mkdir(exportDir, { recursive: true });

const engine = new WorkflowEngine();
const approval = engine.createApproval({
	workflowId: "growth-review",
	targetId: "https://ora.example/post",
	title: "Approve digest",
	summary: "Automation for finance teams.",
	actions: approvalActions(),
	artifacts: [{ id: "artifact-1", label: "Draft", path: path.join(artifactDir, "draft.md") }],
});
const checkpoint = engine.createCheckpoint({
	workflowId: "growth-export",
	targetId: "article-1",
	title: "Export checkpoint",
	linkedRunId: "run-42",
	actions: checkpointActions(),
});

const inboxBefore = buildTelegramApprovalInbox(engine);
const approvalAction = await applyTelegramQuickAction(engine, {
	itemId: approval.id,
	actionId: "approve-feed",
	actor: { actorId: "telegram-user", source: "telegram" },
	requestId: "telegram-approve-1",
});
engine.claimItem({ itemId: checkpoint.id, actor: { actorId: "operator-1", source: "telegram" }, requestId: "claim-resume" });
await engine.applyAction({
	itemId: checkpoint.id,
	actionId: "resume",
	actor: { actorId: "operator-1", source: "telegram" },
	requestId: "resume-1",
});
const feedArtifact = await sendGrowthFeed({
	outboxDir: artifactDir,
	items: [
		{
			id: approval.id,
			title: "Automation for Finance Teams",
			summary: "Automation removes manual reporting for finance teams.",
			canonicalUrl: "https://ora.example/post",
			personaSlug: "finance",
		},
	],
});
const exportArtifacts = await exportPublicationArtifacts({
	cmsOutboxDir: exportDir,
	repoDraftDir: exportDir,
	items: [
		{
			id: "article-1",
			title: "Automation for Finance Teams",
			summary: "Summary",
			canonicalUrl: "https://ora.example/post",
			body: "Body",
		},
	],
});

const grouped = groupWorkflowItems(engine.listItems());
await emitWorkflowSyncSnapshot(syncDir, {
	approvals: grouped.approvals,
	checkpoints: grouped.checkpoints,
	downstreamJobs: engine.listJobs(),
	audit: engine.listAudit(),
	goals: [
		{ id: "discovery-goal", data: { state: "pending", title: "Discovery" } },
		{ id: "feed-delivery-goal", data: { state: "completed", title: "Feed delivery" } },
	],
});
const sharedState = await loadSharedSyncState(syncDir);
const approvalModel = buildApprovalSurfaceModel(sharedState);
const goalsModel = buildGoalsPanelModel(sharedState);

const approvalQmlPath = path.join(artifactDir, "approval-surface.qml");
const goalsQmlPath = path.join(artifactDir, "goals-panel.qml");
await Bun.write(
	approvalQmlPath,
	renderSurfaceQml("Approval / Checkpoint Surface", [
		`Pending: ${approvalModel.pendingCount}`,
		`Completed: ${approvalModel.completedCount}`,
		...approvalModel.entries.map(entry => `${entry.kind} ${entry.id} :: ${entry.title} :: ${entry.state} :: ${entry.allowedActions.join(", ")}`),
	]),
);
await Bun.write(
	goalsQmlPath,
	renderSurfaceQml("Goals Panel", [
		`Goal count: ${goalsModel.goalCount}`,
		...goalsModel.entries.map(entry => `${entry.id} :: ${entry.state}${entry.title ? ` :: ${entry.title}` : ""}`),
	]),
);
await renderQmlScreenshot(approvalQmlPath, path.join(artifactDir, "qml-approval-surface.png"));
await renderQmlScreenshot(goalsQmlPath, path.join(artifactDir, "qml-goals-panel.png"));

await Bun.write(
	path.join(artifactDir, "telegram-quick-action-transcript.txt"),
	[
		"Telegram inbox before action:",
		...inboxBefore.map(entry => `- ${entry.itemId} | ${entry.title} | ${entry.actions.map(action => action.id).join(", ")}`),
		"",
		`Applied action approve-feed on ${approval.id}`,
		`Result state: ${approvalAction.item.state}`,
		`Feed artifact: ${feedArtifact.artifactPath}`,
	].join("\n"),
);
await Bun.write(path.join(artifactDir, "sync-state-tree.txt"), (await listFiles(syncDir)).join("\n") + "\n");
await Bun.write(
	path.join(artifactDir, "artifact-summary.json"),
	JSON.stringify(
		{
			approvalScreenshot: path.join(artifactDir, "qml-approval-surface.png"),
			goalsScreenshot: path.join(artifactDir, "qml-goals-panel.png"),
			telegramTranscript: path.join(artifactDir, "telegram-quick-action-transcript.txt"),
			syncTree: path.join(artifactDir, "sync-state-tree.txt"),
			feedArtifact: feedArtifact.artifactPath,
			exportArtifacts,
		},
		null,
		2,
	),
);
