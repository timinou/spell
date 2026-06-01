import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@spell/pi-ai";
import { validateLoopPrerequisites } from "../../src/config/loop-prerequisites";
import { MODEL_ROLE_IDS } from "../../src/config/model-registry";
import { expandRoleAlias, resolveModelRoleValue } from "../../src/config/model-resolver";
import { Settings } from "../../src/config/settings";

function getAnthropicModelOrThrow(id: string) {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected anthropic model ${id}`);
	return model;
}

describe("review model role", () => {
	it("adds review to the model role ids", () => {
		expect(MODEL_ROLE_IDS).toContain("review");
	});

	it("expands pi/review to the configured review role", () => {
		const settings = Settings.isolated();
		settings.setModelRole("review", "anthropic/claude-sonnet-4-6");
		expect(expandRoleAlias("pi/review", settings)).toBe("anthropic/claude-sonnet-4-6");
	});

	it("resolves the configured review role value when set", () => {
		const settings = Settings.isolated();
		const reviewModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		settings.setModelRole("review", `${reviewModel.provider}/${reviewModel.id}`);
		const result = resolveModelRoleValue("pi/review", [reviewModel], { settings });
		expect(result.model?.id).toBe(reviewModel.id);
	});

	it("reports missing review configuration for loop workflows", () => {
		const settings = Settings.isolated();
		expect(validateLoopPrerequisites(settings)).toEqual({
			ok: false,
			missing: ["modelRoles.review"],
			message: "Loop workflows require the following settings before start: modelRoles.review",
		});
	});

	it("allows loops when review role is configured", () => {
		const settings = Settings.isolated();
		settings.setModelRole("review", "anthropic/claude-sonnet-4-6");
		expect(validateLoopPrerequisites(settings)).toEqual({ ok: true, missing: [] });
	});
});
