import { afterEach, describe, expect, it } from "bun:test";
import { WorkflowEngine } from "../../../spell-server/src/workflow";
import { startWorkflowHttpServer } from "../../../spell-server/test/http/workflow-test-helpers";
import { createApprovalInput } from "../../../spell-server/test/workflow/test-helpers";
import { Settings } from "../../src/config/settings";
import { createTools, type ToolSession } from "../../src/tools";
import { fetchApprovalsToolView } from "../../src/tools/approvals-tool";

let stop: (() => void) | undefined;
const originalSpellServerUrl = Bun.env.SPELL_SERVER_URL;
const originalSpellServerUsername = Bun.env.SPELL_SERVER_USERNAME;
const originalSpellServerPassword = Bun.env.SPELL_SERVER_PASSWORD;

function restoreEnv(
	name: "SPELL_SERVER_URL" | "SPELL_SERVER_USERNAME" | "SPELL_SERVER_PASSWORD",
	value: string | undefined,
): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

function createSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

afterEach(() => {
	stop?.();
	stop = undefined;
	restoreEnv("SPELL_SERVER_URL", originalSpellServerUrl);
	restoreEnv("SPELL_SERVER_USERNAME", originalSpellServerUsername);
	restoreEnv("SPELL_SERVER_PASSWORD", originalSpellServerPassword);
});

describe("approvals tool client", () => {
	it("reads canonical approval summaries from spell-server", async () => {
		const workflowEngine = new WorkflowEngine();
		workflowEngine.createApproval(createApprovalInput({ title: "Approve digest" }));
		const server = startWorkflowHttpServer({ workflowEngine });
		stop = server.stop;

		expect(
			await fetchApprovalsToolView({
				baseUrl: server.baseUrl,
				username: "spell",
				password: "secret", // pragma: allowlist secret
			}),
		).toEqual([expect.objectContaining({ title: "Approve digest", kind: "approval", state: "pending" })]);
	});

	it("registers the builtin tool when spell-server url is available", async () => {
		const workflowEngine = new WorkflowEngine();
		workflowEngine.createApproval(createApprovalInput({ title: "Approve digest" }));
		const server = startWorkflowHttpServer({ workflowEngine });
		stop = server.stop;
		Bun.env.SPELL_SERVER_URL = server.baseUrl;
		Bun.env.SPELL_SERVER_USERNAME = "spell";
		Bun.env.SPELL_SERVER_PASSWORD = "secret"; // pragma: allowlist secret

		const tools = await createTools(createSession(), ["approvals"]);
		expect(tools.map(tool => tool.name)).toEqual(["approvals", "exit_plan_mode"]);

		const approvalsTool = tools.find(tool => tool.name === "approvals");
		if (!approvalsTool) throw new Error("Missing approvals tool");
		const result = await approvalsTool.execute("tool-call", {});
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining('"Approve digest"') }),
		]);
	});
});
