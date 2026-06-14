/**
 * Domain activation — apply a declarative domain's runtime contract.
 *
 * Declarative domains (KDL `domain { … }` blocks) carry an env contract,
 * model-role pins, and a knowledge-lane config. These are *runtime* effects
 * that must fire at startup, before the session is built:
 *
 *  - `env.require` — fail loud if a required env var is absent (e.g. a harness's
 *    injected model). A declarative domain that names a contract it can't honor
 *    is a startup error, never a silent fallback.
 *  - `env.set` — force session env vars (e.g. `PI_KNOWLEDGE_WORKER=inprocess`).
 *  - `knowledge.embeddings:false` — signal the knowledge worker to skip the
 *    fastembed model load via `PI_KNOWLEDGE_WORKER_EMBEDDINGS=0`; recall
 *    degrades to BM25 + graph (no vector lane, no model RAM/download).
 *  - `modelRoles` — pin role→model, resolving `$VAR` refs against the
 *    environment, then merge into settings via `overrideModelRoles`.
 *
 * Kept separate from `loader.ts` (which only *reads* a manifest) because these
 * mutate process env + settings. Pure function over an injected env + a
 * settings sink so it is unit-testable without a live process.
 */

import type { SpellDomain } from "./loader";

/** Minimal settings surface this module needs — matches `Settings`. */
export interface ModelRoleSink {
	overrideModelRoles(roles: Record<string, string>): void;
}

export interface ActivateDomainOptions {
	/** Env map to read/require against (defaults to `process.env`). */
	env?: Record<string, string | undefined>;
	/** Mutator for forced env vars (defaults to writing `process.env`). */
	setEnv?: (name: string, value: string) => void;
	/** Settings sink for model-role pins. */
	settings?: ModelRoleSink;
}

/** Resolve `$VAR` / `$${VAR}` refs in a role value against `env`. */
function resolveEnvRefs(value: string, env: Record<string, string | undefined>): string {
	return value.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (_match, name: string) => env[name] ?? "");
}

/**
 * Apply a domain's declarative runtime contract. Throws (fail-loud) when an
 * `env.require` var is missing, naming every absent var. Returns the list of
 * applied effects for logging/telemetry.
 */
export function activateDomain(
	domain: SpellDomain | undefined,
	options: ActivateDomainOptions = {},
): { requiredOk: boolean; forcedEnv: string[]; pinnedRoles: string[] } {
	const env = options.env ?? (process.env as Record<string, string | undefined>);
	const setEnv =
		options.setEnv ??
		((name: string, value: string) => {
			process.env[name] = value;
		});

	const forcedEnv: string[] = [];
	const pinnedRoles: string[] = [];

	if (!domain) {
		return { requiredOk: true, forcedEnv, pinnedRoles };
	}

	// 1. Required env — fail loud listing ALL missing vars at once.
	const missing = (domain.env?.require ?? []).filter(name => {
		const v = env[name];
		return v === undefined || v === "";
	});
	if (missing.length > 0) {
		throw new Error(
			`Domain '${domain.name}' requires environment variable(s) not set: ${missing.join(", ")}. ` +
				`This domain's contract cannot be honored without them.`,
		);
	}

	// 2. Knowledge-lane: embeddings off → worker env signal. Set BEFORE the
	//    worker is spawned (worker reads env at boot).
	if (domain.knowledge?.embeddings === false) {
		setEnv("PI_KNOWLEDGE_WORKER_EMBEDDINGS", "0");
		forcedEnv.push("PI_KNOWLEDGE_WORKER_EMBEDDINGS");
	}

	// 3. Forced env (explicit set wins over the knowledge-derived default above
	//    only if it names the same var; declarative intent is explicit).
	for (const [name, rawValue] of Object.entries(domain.env?.set ?? {})) {
		const value = resolveEnvRefs(rawValue, env);
		setEnv(name, value);
		forcedEnv.push(name);
	}

	// 4. Model-role pins (resolve $VAR refs).
	if (domain.modelRoles && options.settings) {
		const resolved: Record<string, string> = {};
		for (const [role, rawValue] of Object.entries(domain.modelRoles)) {
			const value = resolveEnvRefs(rawValue, env).trim();
			if (value.length > 0) {
				resolved[role] = value;
				pinnedRoles.push(role);
			}
		}
		if (pinnedRoles.length > 0) {
			options.settings.overrideModelRoles(resolved);
		}
	}

	return { requiredOk: true, forcedEnv, pinnedRoles };
}
