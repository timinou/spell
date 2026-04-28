import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AutonomyManifest } from "../../../src/manifest/types";
import type { RpcClient, RpcEvent, RpcSpawnOptions } from "../../../src/rpc";
import { SessionManager } from "../../../src/session";
import { SocketSessionRegistry } from "../../../src/socket/session-registry";
import { WebSpawnedLifecycle } from "../../../src/web/session/spawned-lifecycle";
import { WebSessionHub } from "../../../src/web/session/web-session-hub";
import {
	coerceParams,
	MissingParamError,
	ParamCoercionError,
	UnknownParamError,
} from "../../../src/web/templates/params";
import { PromptRenderError, TemplateRunner } from "../../../src/web/templates/runner";

class FakeRpcClient {
	alive = true;
	options: RpcSpawnOptions;
	sentCommands: unknown[] = [];
	#listeners: Array<(event: RpcEvent) => void> = [];

	constructor(options: RpcSpawnOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		this.alive = true;
		setTimeout(() => this.emit({ type: "ready" }), 0);
	}
	async kill(): Promise<void> {
		this.alive = false;
	}
	send(command: { id?: string; type: string }): void {
		this.sentCommands.push(command);
		setTimeout(() => this.emit({ type: "response", command: command.type, success: true }), 0);
	}
	async prompt(): Promise<void> {}
	async abort(): Promise<void> {}
	onEvent(cb: (event: RpcEvent) => void): void {
		this.#listeners.push(cb);
	}
	offEvent(cb: (event: RpcEvent) => void): void {
		const i = this.#listeners.indexOf(cb);
		if (i !== -1) this.#listeners.splice(i, 1);
	}
	emit(e: RpcEvent): void {
		for (const l of [...this.#listeners]) l(e);
	}
}

function buildManifest(): AutonomyManifest {
	return {
		name: "x",
		version: "1.0",
		setups: new Map([["writer", { domain: "coding", tools: { allow: ["read"] } }]]),
		goals: new Map(),
		templates: new Map([
			[
				"document",
				{
					name: "document",
					setupRef: "writer",
					prompt: "Write about {{topic}} (depth {{depth}})",
					params: [
						{ name: "topic", type: "string" as const, required: true },
						{ name: "depth", type: "number" as const },
					],
					artifactWatch: { ext: [".pdf"] },
				},
			],
		]),
		exportTargets: [],
		notificationRoutes: [],
		reviewPolicies: [],
		checkpoints: [],
		panels: [],
		layouts: [],
		syncCollections: [],
		stateSchemas: [],
		toolModules: [],
		operatorActions: [],
	};
}

describe("coerceParams", () => {
	const decl = [
		{ name: "topic", type: "string" as const, required: true },
		{ name: "depth", type: "number" as const },
		{ name: "fancy", type: "boolean" as const },
	];

	it("coerces string/number/boolean", () => {
		expect(coerceParams("doc", decl, { topic: "ai", depth: "5", fancy: "true" })).toEqual({
			topic: "ai",
			depth: 5,
			fancy: true,
		});
	});

	it("throws MissingParamError when a required field is omitted", () => {
		expect(() => coerceParams("doc", decl, {})).toThrow(MissingParamError);
	});

	it("throws UnknownParamError for unexpected keys", () => {
		expect(() => coerceParams("doc", decl, { topic: "x", garbage: 1 })).toThrow(UnknownParamError);
	});

	it("throws ParamCoercionError when a number cannot be coerced", () => {
		expect(() => coerceParams("doc", decl, { topic: "x", depth: "oops" })).toThrow(ParamCoercionError);
	});
});

describe("TemplateRunner", () => {
	let hub: WebSessionHub;
	let manager: SessionManager<string>;
	let registry: SocketSessionRegistry;
	let created: FakeRpcClient[];

	beforeEach(() => {
		registry = new SocketSessionRegistry();
		created = [];
		manager = new SessionManager<string>({
			lifecycle: new WebSpawnedLifecycle({ idleTimeoutMs: 60_000 }),
			keyToString: k => k,
			createClient: opts => {
				const c = new FakeRpcClient(opts);
				created.push(c);
				return c as unknown as RpcClient;
			},
		});
		hub = new WebSessionHub({ sessionManager: manager, registry });
	});

	afterEach(async () => {
		await manager.killAll();
		hub.stop();
	});

	it("renders the Handlebars prompt and forwards it as the first prompt RPC", async () => {
		const runner = new TemplateRunner({ manifest: buildManifest(), hub, cwd: "/tmp" });
		const { sessionId } = await runner.runTemplate("document", { topic: "memory", depth: 3 }, { name: "alice" });
		expect(sessionId).toBeDefined();
		// Last spawned client should have received a prompt command containing the rendered text.
		const lastClient = created.at(-1);
		const prompt = lastClient?.sentCommands.find(c => (c as { type?: string }).type === "prompt") as
			| { message: string }
			| undefined;
		expect(prompt?.message).toBe("Write about memory (depth 3)");
		// Registry tagged ownedBy + templateName + watchExtensions
		const entry = registry.getSession(sessionId);
		expect(entry?.ownedBy).toBe("alice");
		expect(entry?.templateName).toBe("document");
		expect(entry?.watchExtensions).toEqual([".pdf"]);
	});

	it("throws when template is unknown", async () => {
		const runner = new TemplateRunner({ manifest: buildManifest(), hub, cwd: "/tmp" });
		await expect(runner.runTemplate("missing", {}, { name: "a" })).rejects.toThrow(/Unknown template/);
	});

	it("propagates MissingParamError before spawning", async () => {
		const runner = new TemplateRunner({ manifest: buildManifest(), hub, cwd: "/tmp" });
		await expect(runner.runTemplate("document", {}, { name: "a" })).rejects.toThrow(MissingParamError);
		expect(registry.getSpawned().length).toBe(0);
	});

	it("renders missing variables as empty string (non-strict)", async () => {
		const manifest = buildManifest();
		const tpl = manifest.templates.get("document");
		if (tpl) tpl.prompt = "Hello {{topic}}{{missing}}!";
		const runner = new TemplateRunner({ manifest, hub, cwd: "/tmp" });
		const { sessionId } = await runner.runTemplate("document", { topic: "world" }, { name: "alice" });
		const lastClient = created.at(-1);
		const prompt = lastClient?.sentCommands.find(c => (c as { type?: string }).type === "prompt") as
			| { message: string }
			| undefined;
		expect(prompt?.message).toBe("Hello world!");
		expect(sessionId).toBeDefined();
	});

	it("throws PromptRenderError on syntactically invalid template", async () => {
		const manifest = buildManifest();
		const tpl = manifest.templates.get("document");
		if (tpl) tpl.prompt = "Broken {{#if topic}} no closing";
		const runner = new TemplateRunner({ manifest, hub, cwd: "/tmp" });
		await expect(runner.runTemplate("document", { topic: "x" }, { name: "a" })).rejects.toThrow(PromptRenderError);
	});
});
