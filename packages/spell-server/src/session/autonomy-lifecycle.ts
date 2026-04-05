import type { AutonomyManifest, NamedStateStore } from "../manifest/types";
import type { RpcSpawnOptions } from "../rpc";
import type { BaseSpawnOptions, SessionLifecycle } from "./types";

export class AutonomyLifecycle implements SessionLifecycle<string> {
	#manifest: AutonomyManifest;

	constructor(manifest: AutonomyManifest) {
		this.#manifest = manifest;
	}

	buildSpawnOptions(goalName: string, base: BaseSpawnOptions): RpcSpawnOptions {
		const tools = base.tools.includes("autonomy_state") ? [...base.tools] : [...base.tools, "autonomy_state"];
		const env = this.#buildStateEnv(goalName, base.env);
		return {
			cwd: base.cwd,
			tools,
			appendSystemPrompt: base.appendSystemPrompt,
			sessionDir: base.sessionDir,
			sandboxPolicyPath: base.sandboxPolicyPath,
			...(Object.keys(env).length > 0 ? { env } : {}),
		};
	}

	getIdleTimeout(_goalName: string): null {
		return null;
	}

	#buildStateEnv(goalName: string, baseEnv?: Record<string, string>): Record<string, string> {
		const env: Record<string, string> = { ...(baseEnv ?? {}) };
		const goal = this.#manifest.goals.get(goalName);
		if (!goal) return env;

		const setup = this.#manifest.setups.get(goal.setup);
		// Collect state stores from both setup and goal (goal overrides setup)
		const stores = new Map<string, NamedStateStore>();
		if (setup?.stateStores) {
			for (const [name, store] of setup.stateStores) stores.set(name, store);
		}
		if (goal.stateStores) {
			for (const [name, store] of goal.stateStores) stores.set(name, store);
		}
		if (stores.size === 0) return env;

		// Build SPELL_AUTONOMY_STATE_STORES: {name: path} for sqlite stores
		const storePaths: Record<string, string> = {};
		for (const [name, store] of stores) {
			if (store.backend === "sqlite") {
				storePaths[name] = store.path;
			}
		}
		if (Object.keys(storePaths).length > 0) {
			env.SPELL_AUTONOMY_STATE_STORES = JSON.stringify(storePaths);
		}

		// Build SPELL_AUTONOMY_STATE_SCHEMAS from manifest state schemas
		const schemas: Record<
			string,
			{ tables: Array<{ name: string; columns: Array<{ name: string; type: string; primary?: boolean }> }> }
		> = {};
		for (const [name, store] of stores) {
			if (!store.schema) continue;
			const stateSchema = this.#manifest.stateSchemas.find(s => s.id === store.schema);
			if (!stateSchema) continue;
			schemas[name] = { tables: stateSchema.tables };
		}
		if (Object.keys(schemas).length > 0) {
			env.SPELL_AUTONOMY_STATE_SCHEMAS = JSON.stringify(schemas);
		}

		return env;
	}
}
