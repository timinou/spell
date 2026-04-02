import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import canvasCastDescription from "../prompts/tools/canvas-cast.md" with { type: "text" };
import { getSpellcastingServerUrl } from "../spellcast/config";
import { discoverSpellcastManifests } from "../spellcast/discovery";
import { parseSpellcastManifest } from "../spellcast/manifest";
import { loadSpellcastPublishState, writeSpellcastPublishState } from "../spellcast/state";
import { createTarball } from "../spellcast/tarball";
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";

const canvasCastSchema = Type.Object({
	action: Type.Union([
		Type.Literal("publish"),
		Type.Literal("update"),
		Type.Literal("unpublish"),
		Type.Literal("status"),
	]),
	manifest: Type.Optional(Type.String({ description: "Path to the spellcast manifest file" })),
});

type CanvasCastInput = Static<typeof canvasCastSchema>;

type PublishResponse = { id: string; url: string };

export class CanvasCastTool implements AgentTool<typeof canvasCastSchema> {
	name = "canvas_cast" as const;
	label = "Canvas Cast";
	parameters = canvasCastSchema;
	description = canvasCastDescription;

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	static async createIf(session: ToolSession): Promise<CanvasCastTool | null> {
		if (!session.authStorage) return null;
		const token = await session.authStorage.getApiKey("spellcasting", session.getSessionId?.() ?? undefined);
		return token ? new CanvasCastTool(session) : null;
	}

	async execute(_toolCallId: string, input: CanvasCastInput): Promise<AgentToolResult> {
		try {
			switch (input.action) {
				case "publish":
					return await this.#publish(input.manifest);
				case "update":
					return await this.#update(input.manifest);
				case "unpublish":
					return await this.#unpublish(input.manifest);
				case "status":
					return await this.#status();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return toolResult().text(`Canvas Cast error: ${message}`).done();
		}
		return toolResult().text(`Unknown canvas_cast action: ${input.action}`).done();
	}

	async #publish(manifestPathInput: string | undefined): Promise<AgentToolResult> {
		const token = await this.#requireToken();
		const manifestPath = this.#requireManifestPath(manifestPathInput);
		const { manifest, tarball } = await this.#prepareManifestUpload(manifestPath);
		const response = await this.#sendMultipart("POST", "/api/apps", token, tarball, JSON.stringify(manifest));
		const state = await loadSpellcastPublishState(this.#session.cwd);
		state[manifestPath] = {
			manifestPath,
			appId: response.id,
			appUrl: response.url,
			visibility: manifest.visibility,
			updatedAt: new Date().toISOString(),
		};
		await writeSpellcastPublishState(this.#session.cwd, state);
		return toolResult().text(`Published ${manifest.name}: ${response.url}`).done();
	}

	async #update(manifestPathInput: string | undefined): Promise<AgentToolResult> {
		const token = await this.#requireToken();
		const manifestPath = this.#requireManifestPath(manifestPathInput);
		const state = await loadSpellcastPublishState(this.#session.cwd);
		const existing = state[manifestPath];
		if (!existing) {
			return toolResult().text("Error: Spellcast is not published yet. Use publish first.").done();
		}

		const { manifest, tarball } = await this.#prepareManifestUpload(manifestPath);
		const response = await this.#sendMultipart("PUT", `/api/apps/${existing.appId}`, token, tarball);
		state[manifestPath] = {
			...existing,
			appUrl: response.url,
			visibility: manifest.visibility,
			updatedAt: new Date().toISOString(),
		};
		await writeSpellcastPublishState(this.#session.cwd, state);
		return toolResult().text(`Updated ${manifest.name}: ${response.url}`).done();
	}

	async #unpublish(manifestPathInput: string | undefined): Promise<AgentToolResult> {
		const token = await this.#requireToken();
		const manifestPath = this.#requireManifestPath(manifestPathInput);
		const state = await loadSpellcastPublishState(this.#session.cwd);
		const existing = state[manifestPath];
		if (!existing) {
			return toolResult().text("Error: Spellcast is not published.").done();
		}

		const response = await fetch(`${getSpellcastingServerUrl()}/api/apps/${existing.appId}`, {
			method: "DELETE",
			headers: { authorization: `Bearer ${token}` },
		});
		if (!response.ok && response.status !== 404) {
			throw new Error(`Spellcasting server returned ${response.status} while unpublishing`);
		}
		delete state[manifestPath];
		await writeSpellcastPublishState(this.#session.cwd, state);
		return toolResult().text(`Unpublished ${existing.appId}`).done();
	}

	async #status(): Promise<AgentToolResult> {
		const discovery = await discoverSpellcastManifests(this.#session.cwd);
		const state = await loadSpellcastPublishState(this.#session.cwd);
		if (discovery.manifests.length === 0 && discovery.warnings.length === 0) {
			return toolResult().text("No spellcasts found.").done();
		}

		const lines = discovery.manifests.map(item => {
			const publishState = state[item.manifestPath];
			return publishState
				? `${item.manifest.name}: published ${publishState.appUrl}`
				: `${item.manifest.name}: draft`;
		});
		if (discovery.warnings.length > 0) {
			lines.push(`Warnings: ${discovery.warnings.join(" | ")}`);
		}
		return toolResult().text(lines.join("\n")).done();
	}

	async #prepareManifestUpload(
		manifestPath: string,
	): Promise<{ manifest: ReturnType<typeof parseSpellcastManifest>; tarball: Buffer }> {
		const raw = await Bun.file(manifestPath).text();
		const manifest = parseSpellcastManifest(raw, { sourcePath: manifestPath });
		const tarball = await createTarball(path.dirname(manifestPath), manifest.files);
		return { manifest, tarball };
	}

	async #requireToken(): Promise<string> {
		const token = await this.#session.authStorage?.getApiKey(
			"spellcasting",
			this.#session.getSessionId?.() ?? undefined,
		);
		if (!token) {
			throw new Error("Not authenticated. Run /login spellcasting first.");
		}
		return token;
	}

	#requireManifestPath(manifestPathInput: string | undefined): string {
		if (!manifestPathInput) {
			throw new Error("manifest is required for this action");
		}
		return path.resolve(this.#session.cwd, manifestPathInput);
	}

	async #sendMultipart(
		method: "POST" | "PUT",
		pathname: string,
		token: string,
		tarball: Buffer,
		manifestJson?: string,
	): Promise<PublishResponse> {
		const form = new FormData();
		form.set("tarball", new File([tarball], "spellcast.tar.gz", { type: "application/gzip" }));
		if (manifestJson) {
			form.set("manifest_json", manifestJson);
		}
		const response = await fetch(`${getSpellcastingServerUrl()}${pathname}`, {
			method,
			headers: { authorization: `Bearer ${token}` },
			body: form,
		});
		if (response.status === 404) {
			throw new Error("The published spellcast no longer exists on the server. Publish it again.");
		}
		if (!response.ok) {
			throw new Error(`Spellcasting server returned ${response.status}`);
		}
		return (await response.json()) as PublishResponse;
	}
}
