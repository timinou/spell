import { describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { getThemeByName } from "@spell/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@spell/pi-coding-agent/tools";
import { applyPendingAction, PendingActionStore } from "@spell/pi-coding-agent/tools/pending-action";
import { ResolveTool, resolveToolRenderer } from "@spell/pi-coding-agent/tools/resolve";
import * as nativesModule from "@spell/pi-natives";
import { sanitizeText } from "@spell/pi-natives";

function createSession(pendingActionStore?: PendingActionStore, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		pendingActionStore,
		...overrides,
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("ResolveTool", () => {
	it("requires action and reason in schema", () => {
		const tool = new ResolveTool(createSession(new PendingActionStore()));
		const schema = tool.parameters as { required?: string[] };
		expect(schema.required).toEqual(["action", "reason"]);
	});

	it("errors when there is no pending action", async () => {
		const tool = new ResolveTool(createSession(new PendingActionStore()));
		await expect(tool.execute("call-none", { action: "apply", reason: "looks correct" })).rejects.toThrow(
			"No pending action to resolve. Nothing to apply or discard.",
		);
	});

	it("discards pending action and clears store", async () => {
		const pendingActionStore = new PendingActionStore();
		let rejectedReason: string | undefined;
		pendingActionStore.push({
			label: "AST Edit: 2 replacements in 1 file",
			sourceToolName: "edit",
			files: [],
			apply: async (_reason: string) => ({ content: [{ type: "text", text: "should not run" }] }),
			reject: async (reason: string) => {
				rejectedReason = reason;
				return { content: [{ type: "text", text: "Rejected pending preview." }] };
			},
		});
		const tool = new ResolveTool(createSession(pendingActionStore));
		const result = await tool.execute("call-discard", {
			action: "discard",
			reason: "Preview changed wrong callsites",
		});

		expect(getText(result)).toContain("Rejected pending preview.");
		expect(pendingActionStore.hasPending).toBe(false);
		expect(rejectedReason).toBe("Preview changed wrong callsites");
		expect(result.details).toEqual({
			action: "discard",
			reason: "Preview changed wrong callsites",
			sourceToolName: "edit",
			label: "AST Edit: 2 replacements in 1 file",
			mutationState: "discarded",
			persisted: false,
		});
	});

	it("applies pending action and clears store", async () => {
		const pendingActionStore = new PendingActionStore();
		let applied = false;
		let appliedReason: string | undefined;
		pendingActionStore.push({
			label: "AST Edit: 1 replacement in 1 file",
			sourceToolName: "edit",
			files: [],
			apply: async reason => {
				applied = true;
				appliedReason = reason;
				return { content: [{ type: "text", text: "Applied 1 replacement in 1 file." }] };
			},
		});

		const tool = new ResolveTool(createSession(pendingActionStore));
		const result = await tool.execute("call-apply", {
			action: "apply",
			reason: "Preview is correct",
		});

		expect(applied).toBe(true);
		expect(appliedReason).toBe("Preview is correct");
		expect(pendingActionStore.hasPending).toBe(false);
		expect(getText(result)).toContain("Applied 1 replacement in 1 file.");
		expect(result.details).toEqual({
			action: "apply",
			reason: "Preview is correct",
			sourceToolName: "edit",
			label: "AST Edit: 1 replacement in 1 file",
			mutationState: "applied",
			persisted: true,
			bufferInvalidationError: undefined,
		});
	});

	it("degrades applied results when buffer invalidation fails after persistence", async () => {
		const pendingActionStore = new PendingActionStore();
		const closeSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: "close failed",
			error: true,
		});
		try {
			pendingActionStore.push({
				label: "AST Edit: 1 replacement in 1 file",
				sourceToolName: "edit",
				files: ["/tmp/main.ts"],
				invalidateManagedCodeBuffers: true,
				apply: async () => ({ content: [{ type: "text", text: "Applied 1 replacement in 1 file." }] }),
			});
			const tool = new ResolveTool(createSession(pendingActionStore));
			const result = await tool.execute("call-apply-degraded", {
				action: "apply",
				reason: "Preview is correct",
			});

			expect(getText(result)).toContain("Persisted to disk with buffer invalidation warnings.");
			expect(getText(result)).toContain(
				"Applied preview persisted to disk, but failed to invalidate the managed code buffer for /tmp/main.ts: close failed",
			);
			expect(result.details).toEqual(
				expect.objectContaining({
					mutationState: "applied",
					persisted: true,
					bufferInvalidationError: expect.stringContaining("failed to invalidate the managed code buffer"),
				}),
			);
			expect(closeSpy).toHaveBeenCalledWith(expect.objectContaining({ command: "close", file: "/tmp/main.ts" }));
			expect(pendingActionStore.hasPending).toBe(false);
		} finally {
			closeSpy.mockRestore();
		}
	});

	it("does not invalidate managed buffers unless the pending action opts in", async () => {
		const pendingActionStore = new PendingActionStore();
		const closeSpy = spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({ output: [], error: false });
		try {
			pendingActionStore.push({
				label: "Custom preview",
				sourceToolName: "custom_tool",
				files: ["/tmp/main.ts"],
				apply: async () => ({ content: [{ type: "text", text: "Applied custom preview." }] }),
			});
			const tool = new ResolveTool(createSession(pendingActionStore));
			const result = await tool.execute("call-apply-custom", {
				action: "apply",
				reason: "Ship it",
			});

			expect(getText(result)).toContain("Applied custom preview.");
			expect(result.details).toEqual(
				expect.objectContaining({ mutationState: "applied", persisted: true, bufferInvalidationError: undefined }),
			);
			expect(closeSpy).not.toHaveBeenCalled();
		} finally {
			closeSpy.mockRestore();
		}
	});

	it("surfaces missing invalidation file lists as degraded apply results", async () => {
		const pendingActionStore = new PendingActionStore();
		pendingActionStore.push({
			label: "AST Edit: 1 replacement in 0 files",
			sourceToolName: "edit",
			files: [],
			invalidateManagedCodeBuffers: true,
			apply: async () => ({ content: [{ type: "text", text: "Applied 1 replacement in 0 files." }] }),
		});
		const tool = new ResolveTool(createSession(pendingActionStore));
		const result = await tool.execute("call-apply-empty-files", {
			action: "apply",
			reason: "Check degraded result",
		});

		expect(getText(result)).toContain("Persisted to disk with buffer invalidation warnings.");
		expect(getText(result)).toContain("no files were provided for managed code buffer invalidation");
		expect(result.details).toEqual(
			expect.objectContaining({
				mutationState: "applied",
				persisted: true,
				bufferInvalidationError: expect.stringContaining("no files were provided"),
			}),
		);
	});

	it("does not misclassify result-like objects as pending action resolutions", async () => {
		const fakeResultLike = { result: { content: [{ type: "text", text: "inner result" }] } } as never;
		const resolution = await applyPendingAction(
			{
				label: "Result-like payload",
				sourceToolName: "edit",
				files: ["/tmp/main.ts"],
				apply: async () => fakeResultLike,
			},
			"normalize weird shape",
		);

		expect(resolution.result).toBe(fakeResultLike);
		expect(resolution.mutationState).toBe("applied");
		expect(resolution.persisted).toBe(true);
		expect(resolution.files).toEqual(["/tmp/main.ts"]);
	});

	it("resolves pending actions in LIFO order", async () => {
		const pendingActionStore = new PendingActionStore();
		let firstApplied = false;
		let secondApplied = false;

		pendingActionStore.push({
			label: "First action",
			sourceToolName: "edit",
			files: [],
			apply: async (_reason: string) => {
				firstApplied = true;
				return { content: [{ type: "text", text: "first" }] };
			},
		});
		pendingActionStore.push({
			label: "Second action",
			sourceToolName: "edit",
			files: [],
			apply: async () => {
				secondApplied = true;
				return { content: [{ type: "text", text: "second" }] };
			},
		});

		const tool = new ResolveTool(createSession(pendingActionStore));
		const firstResult = await tool.execute("call-apply-1", { action: "apply", reason: "apply top" });
		expect(getText(firstResult)).toContain("second");
		expect(firstApplied).toBe(false);
		expect(secondApplied).toBe(true);
		expect(pendingActionStore.hasPending).toBe(true);

		const secondResult = await tool.execute("call-apply-2", { action: "apply", reason: "apply next" });
		expect(getText(secondResult)).toContain("first");
		expect(firstApplied).toBe(true);
		expect(pendingActionStore.hasPending).toBe(false);
	});

	it("surfaces apply failures from pending actions", async () => {
		const pendingActionStore = new PendingActionStore();
		pendingActionStore.push({
			label: "Broken action",
			sourceToolName: "edit",
			files: [],
			apply: async () => {
				throw new Error("apply failed");
			},
		});

		const tool = new ResolveTool(createSession(pendingActionStore));
		await expect(tool.execute("call-apply-error", { action: "apply", reason: "try apply" })).rejects.toThrow(
			"apply failed",
		);
		expect(pendingActionStore.hasPending).toBe(true);
	});
});


it("renders a highlighted apply summary", async () => {
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	const uiTheme = theme!;

	const component = resolveToolRenderer.renderResult(
		{
			content: [{ type: "text", text: "Applied 2 replacements in 1 file." }],
			details: {
				action: "apply",
				reason: "All replacements are correct",
				sourceToolName: "edit",
				label: "AST Edit: 2 replacements in 1 file",
				mutationState: "applied",
				persisted: true,
			},
		},
		{ expanded: false, isPartial: false },
		uiTheme,
	);

	const rendered = sanitizeText(component.render(90).join("\n"));
	expect(rendered).toContain("Accept: 2 replacements in 1 file");
	expect(rendered).toContain("AST Edit");
	expect(rendered).toContain("state: applied · persisted to disk");
	expect(rendered).toContain("All replacements are correct");
	expect(rendered).not.toContain("Applied 2 replacements in 1 file.");
	expect(rendered).not.toContain("Decision");
	expect(rendered).not.toContain("┌");
});

it("renders buffer invalidation provenance warnings", async () => {
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	const uiTheme = theme!;

	const component = resolveToolRenderer.renderResult(
		{
			content: [{ type: "text", text: "Applied 1 replacement in 1 file." }],
			details: {
				action: "apply",
				reason: "Disk write succeeded but close failed",
				sourceToolName: "edit",
				label: "AST Edit: 1 replacement in 1 file",
				mutationState: "applied",
				persisted: true,
				bufferInvalidationError:
					"Applied preview persisted to disk, but failed to invalidate the managed code buffer for /tmp/main.ts: close failed",
			},
		},
		{ expanded: false, isPartial: false },
		uiTheme,
	);

	const rendered = sanitizeText(component.render(120).join("\n"));
	expect(rendered).toContain("state: applied · persisted to disk · buffer invalidation warning");
	expect(rendered).toContain("failed to invalidate the managed code buffer for /tmp/main.ts");
	expect(rendered).toContain("Disk write succeeded but close failed");
});

it("does not show persistence provenance for discarded previews", async () => {
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	const uiTheme = theme!;

	const component = resolveToolRenderer.renderResult(
		{
			content: [{ type: "text", text: "Discarded preview." }],
			details: {
				action: "discard",
				reason: "Preview changed wrong callsites",
				sourceToolName: "edit",
				label: "AST Edit: 2 replacements in 1 file",
				mutationState: "discarded",
				persisted: false,
			},
		},
		{ expanded: false, isPartial: false },
		uiTheme,
	);

	const rendered = sanitizeText(component.render(100).join("\n"));
	expect(rendered).toContain("Discard: 2 replacements in 1 file");
	expect(rendered).toContain("Preview changed wrong callsites");
	expect(rendered).not.toContain("state: discarded");
	expect(rendered).not.toContain("persisted to disk");
	expect(rendered).not.toContain("persistence not reported");
});
