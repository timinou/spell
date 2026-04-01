import { describe, expect, it } from "bun:test";
import { applyClassification, classifyTask } from "@oh-my-pi/pi-coding-agent/task-classifier";

describe("classifyTask", () => {
	it("returns empty result for empty message", () => {
		const result = classifyTask("");
		expect(result.activate).toEqual([]);
		expect(result.skip).toEqual([]);
		expect(result.taskType).toBe("unknown");
	});

	it("detects canvas/QML tasks", () => {
		const result = classifyTask("Create a QML gallery window for brand assets");
		expect(result.activate).toContain("canvas");
		expect(result.taskType).toContain("ui-canvas");
	});

	it("detects browser tasks", () => {
		const result = classifyTask("Take a screenshot of the login page in the browser");
		expect(result.activate).toContain("browser");
		expect(result.taskType).toContain("browser");
	});

	it("detects notebook tasks", () => {
		const result = classifyTask("Edit the analysis.ipynb notebook");
		expect(result.activate).toContain("notebook");
	});

	it("detects python tasks", () => {
		const result = classifyTask("Write a pandas script to analyze the CSV data");
		expect(result.activate).toContain("python");
	});

	it("detects simple questions and skips AST tools", () => {
		const result = classifyTask("What does this function do?");
		expect(result.skip).toContain("ast_grep");
		expect(result.skip).toContain("ast_edit");
		expect(result.taskType).toContain("question");
	});

	it("does not skip core tools even for questions", () => {
		const result = classifyTask("What is the purpose of the read function?");
		// Core tools should never appear in skip
		expect(result.skip).not.toContain("read");
		expect(result.skip).not.toContain("edit");
		expect(result.skip).not.toContain("bash");
	});

	it("returns general for coding tasks without special keywords", () => {
		const result = classifyTask("Fix the bug in the auth module where tokens expire early");
		expect(result.activate).toEqual([]);
		expect(result.skip).toEqual([]);
		expect(result.taskType).toBe("general");
	});

	it("handles multiple matched rules", () => {
		const result = classifyTask("Create a QML canvas window and take a browser screenshot");
		expect(result.activate).toContain("canvas");
		expect(result.activate).toContain("browser");
		expect(result.taskType).toContain("ui-canvas");
		expect(result.taskType).toContain("browser");
	});

	it("does not skip tools that are also being activated", () => {
		// If a message mentions both "explain" and "python", python should be activated not skipped
		const result = classifyTask("Explain how the python data pipeline works and run it");
		expect(result.activate).toContain("python");
		// python is specialized, not standard, so it wouldn't appear in skip anyway
		expect(result.skip).not.toContain("python");
	});
});

describe("applyClassification", () => {
	it("promotes deferred tools to active", () => {
		const initial = ["read", "edit", "ast_grep"];
		const deferred = ["canvas", "python", "notebook"];
		const classification = { activate: ["canvas"], skip: [], taskType: "ui-canvas" };
		const result = applyClassification(initial, deferred, classification);

		expect(result.activeToolNames).toContain("canvas");
		expect(result.activeToolNames).toContain("read");
		expect(result.deferredToolNames).not.toContain("canvas");
		expect(result.deferredToolNames).toContain("python");
	});

	it("demotes standard tools to deferred", () => {
		const initial = ["read", "edit", "ast_grep", "ast_edit", "emacs_code"];
		const deferred = ["canvas"];
		const classification = { activate: [], skip: ["ast_grep", "ast_edit"], taskType: "question" };
		const result = applyClassification(initial, deferred, classification);

		expect(result.activeToolNames).not.toContain("ast_grep");
		expect(result.activeToolNames).not.toContain("ast_edit");
		expect(result.deferredToolNames).toContain("ast_grep");
		expect(result.deferredToolNames).toContain("ast_edit");
	});

	it("never demotes core tools", () => {
		const initial = ["read", "edit", "bash"];
		const deferred = ["canvas"];
		const classification = { activate: [], skip: ["read", "edit"], taskType: "test" };
		const result = applyClassification(initial, deferred, classification);

		// Core tools stay in active
		expect(result.activeToolNames).toContain("read");
		expect(result.activeToolNames).toContain("edit");
	});

	it("handles empty classification gracefully", () => {
		const initial = ["read", "edit", "ast_grep"];
		const deferred = ["canvas", "python"];
		const classification = { activate: [], skip: [], taskType: "general" };
		const result = applyClassification(initial, deferred, classification);

		expect(result.activeToolNames).toEqual(initial);
		expect(result.deferredToolNames).toEqual(deferred);
	});
});
