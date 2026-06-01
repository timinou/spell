import { logger } from "@spell/pi-utils";
import Handlebars from "handlebars";
import type { WebIdentity } from "../../http/types";
import type { AutonomyManifest } from "../../manifest/types";
import { setupToBaseSpawnOptions } from "../../session/setup-options";
import type { WebSessionHub } from "../session/web-session-hub";
import { type CoercedParamValue, coerceParams } from "./params";

export class PromptRenderError extends Error {
	constructor(
		readonly templateName: string,
		readonly cause: unknown,
	) {
		super(
			`Template ${templateName}: prompt render failed: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		this.name = "PromptRenderError";
	}
}

export interface TemplateRunDeps {
	manifest: AutonomyManifest;
	hub: WebSessionHub;
	cwd: string;
}

export interface TemplateRunResult {
	sessionId: string;
}

/**
 * Translate a `template` manifest entry into a live spawned RPC session:
 *   1. Coerce + validate parameters
 *   2. Render the prompt with Handlebars
 *   3. Resolve the setup ref into RpcSpawnOptions
 *   4. Spawn via `WebSessionHub` and fire the rendered prompt as the first
 *      `prompt` RPC command.
 *
 * Returns the sessionId of the spawned session. The initial prompt is
 * fire-and-forget at the runner level: a failure to deliver does NOT roll
 * back the spawn, so the user can retry from the UI.
 */
export class TemplateRunner {
	#deps: TemplateRunDeps;

	constructor(deps: TemplateRunDeps) {
		this.#deps = deps;
	}

	async runTemplate(name: string, params: Record<string, unknown>, identity: WebIdentity): Promise<TemplateRunResult> {
		const template = this.#deps.manifest.templates.get(name);
		if (!template) {
			throw new Error(`Unknown template '${name}'`);
		}
		const setup = this.#deps.manifest.setups.get(template.setupRef);
		if (!setup) {
			throw new Error(`Template '${name}' references unknown setup '${template.setupRef}'`);
		}
		const coerced = coerceParams(name, template.params, params);
		const renderedPrompt = this.#renderPrompt(name, template.prompt, coerced);
		const baseOptions = setupToBaseSpawnOptions(setup, { cwd: this.#deps.cwd });
		const { sessionId } = await this.#deps.hub.spawn({
			ownedBy: identity.name,
			templateName: name,
			watchExtensions: template.artifactWatch?.ext,
			mode: template.mode ?? "rpc",
			base: baseOptions,
		});
		try {
			await this.#deps.hub.send(sessionId, { type: "prompt", message: renderedPrompt });
		} catch (error) {
			logger.warn("template runner: initial prompt send failed", {
				template: name,
				sessionId,
				error: String(error),
			});
		}
		return { sessionId };
	}

	#renderPrompt(name: string, prompt: string, context: Record<string, CoercedParamValue>): string {
		try {
			const hb = Handlebars.create();
			const compiled = hb.compile(prompt, { strict: false, noEscape: true });
			return compiled(context);
		} catch (error) {
			throw new PromptRenderError(name, error);
		}
	}
}
