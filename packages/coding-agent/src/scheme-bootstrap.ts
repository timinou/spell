/**
 * PLAN-310 cutover Wave 2: bootstrap the JS-resident schemes that were moved
 * from declarative kernel profiles to dynamic callback registration.
 *
 * Three schemes (rule, skill, jobs) share the same lifecycle:
 *   - register at session init, after their data source is populated
 *   - resolve via in-memory lookup + optional fs read (skill)
 *   - unregister at session teardown to free the process-global slot
 *
 * The kernel's process-global runtime registry (crates/pi-natives/
 * src/code_path/runtime_schemes.rs) holds the registrations. Re-registration
 * across sessions requires explicit unregister-then-register.
 */
import * as path from "node:path";
import * as fs from "node:fs";
import type { Skill } from "./extensibility/skills";
import type { Rule } from "./capability/rule";
import type { AsyncJobManager, AsyncJob } from "./async/job-manager";
import { formatDuration } from "./tools/render-utils";
import { registerScheme, unregisterScheme, type AdvertiseError } from "./scheme-callbacks";

const RULE_BUDGET_MS = 1_000;
const SKILL_BUDGET_MS = 1_000;
const JOBS_BUDGET_MS = 500;

const SAFE_RELATIVE_RE = /^[A-Za-z0-9._\-/]+$/;

/**
 * Inputs for `setupCallbackSchemes`. Each provider returns the current
 * snapshot at call time so the callback always sees fresh data.
 */
export interface CallbackSchemeProviders {
	getRules: () => readonly Rule[];
	getSkills: () => readonly Skill[];
	getAsyncJobManager: () => AsyncJobManager | undefined;
}

/** Errors from registration calls; collected so the caller can log them in batch. */
export type SchemeBootstrapErrors = AdvertiseError[];

/**
 * Register rule/skill/jobs callback schemes. Returns the set of registration
 * errors (empty on success). Callers should `unregisterCallbackSchemes()`
 * during session teardown.
 */
export function setupCallbackSchemes(providers: CallbackSchemeProviders): SchemeBootstrapErrors {
	const errors: SchemeBootstrapErrors = [];

	// Idempotency: the kernel registry is process-global; a fresh session in
	// the same process (rare but possible in tests) must reset before re-add.
	unregisterCallbackSchemes();

	const ruleErr = registerScheme("rule", body => resolveRule(providers, body), {
		fsBacked: true,
		codepathCompatible: true,
		mimeHint: "text/markdown",
		bashExpandable: false,
		budgetMs: RULE_BUDGET_MS,
		usage: "rule://<name>",
	});
	if (ruleErr) errors.push(ruleErr);

	const skillErr = registerScheme("skill", body => resolveSkill(providers, body), {
		fsBacked: true,
		codepathCompatible: true,
		mimeHint: "text/markdown",
		bashExpandable: true,
		budgetMs: SKILL_BUDGET_MS,
		usage: "skill://<name>[/<subpath>]",
	});
	if (skillErr) errors.push(skillErr);

	const jobsErr = registerScheme("jobs", body => resolveJobs(providers, body), {
		fsBacked: false,
		codepathCompatible: false,
		mimeHint: "text/markdown",
		bashExpandable: false,
		budgetMs: JOBS_BUDGET_MS,
		usage: "jobs://[<id>[#status|#result|#error|#progress]]",
	});
	if (jobsErr) errors.push(jobsErr);

	return errors;
}

/** Unregister all callback schemes registered by `setupCallbackSchemes`. */
export function unregisterCallbackSchemes(): void {
	unregisterScheme("rule");
	unregisterScheme("skill");
	unregisterScheme("jobs");
}

// ───────────────────────── resolvers ─────────────────────────────────

export function resolveRule(
	providers: Pick<CallbackSchemeProviders, "getRules">,
	body: string,
): { url: string; content: string; mime: string; notes?: string[]; sourcePath?: string } {
	if (!body) throw new Error("a rule name is required");
	const rules = providers.getRules();
	const rule = rules.find(r => r.name === body);
	if (!rule) {
		const available = rules.map(r => r.name).join(", ") || "(none)";
		throw new Error(`rule '${body}' not found. Available: ${available}`);
	}
	const notes: string[] = [];
	// Surface source-of-truth when not the default; lets the agent prefer
	// builtin rules but know when a third-party source shadowed.
	const source = (rule as Rule & { _source?: { providerId?: string } })._source;
	if (source?.providerId && source.providerId !== "native") {
		notes.push(`rule source: ${source.providerId}`);
	}
	return {
		url: `rule://${body}`,
		content: rule.content,
		mime: "text/markdown",
		notes,
		sourcePath: rule.path,
	};
}

export function resolveSkill(
	providers: { getSkills: () => Skill[] | readonly Skill[] },
	body: string,
): { url: string; content: string; mime: string; sourcePath?: string } {
	if (!body) throw new Error("a skill name is required");
	const skills = providers.getSkills();
	const [skillName, ...subParts] = body.split("/");
	const sub = subParts.join("/");
	const skill = skills.find(s => s.name === skillName);
	if (!skill) {
		const available = skills.map(s => s.name).join(", ") || "(none)";
		throw new Error(`skill '${skillName}' not found. Available: ${available}`);
	}
	const baseDir = skill.baseDir;
	const resolved = sub ? path.resolve(baseDir, sub) : skill.filePath;

	// Traversal defense (mirrors kernel local profile's path_starts_with).
	const baseResolved = path.resolve(baseDir);
	if (resolved !== baseResolved && !resolved.startsWith(`${baseResolved}${path.sep}`)) {
		throw new Error(`sub-path '${sub}' escapes skill baseDir`);
	}
	if (sub && !SAFE_RELATIVE_RE.test(sub)) {
		throw new Error(`sub-path contains disallowed characters: ${sub}`);
	}

	// Sync read: napi ThreadsafeFunction expects sync return; the kernel blocks
	// on mpsc until JS responds. Async callbacks return a Promise which fails
	// napi field-deserialization with "Missing field url".
	const content = fs.readFileSync(resolved, "utf-8");
	return {
		url: `skill://${body}`,
		content,
		mime: mimeForExtension(resolved),
		sourcePath: resolved,
	};
}

export function resolveJobs(
	providers: Pick<CallbackSchemeProviders, "getAsyncJobManager">,
	body: string,
): { url: string; content: string; mime: string; notes?: string[] } {
	const manager = providers.getAsyncJobManager();
	if (!manager) {
		return {
			url: `jobs://${body}`,
			content: "# Jobs\n\nAsync execution is disabled. Enable `async.enabled` to use jobs scheme.",
			mime: "text/markdown",
		};
	}

	// Strip optional fragment for per-field selection.
	const hashIdx = body.indexOf("#");
	const id = hashIdx >= 0 ? body.slice(0, hashIdx) : body;
	const fragment = hashIdx >= 0 ? body.slice(hashIdx + 1) : undefined;

	if (!id) {
		return { url: "jobs://", content: renderJobsListing(manager), mime: "text/markdown" };
	}

	const job = manager.getJob(id);
	if (!job) {
		return {
			url: `jobs://${body}`,
			content: `# Job Not Found\n\n404: No async job with id \`${id}\`.`,
			mime: "text/markdown",
		};
	}

	if (fragment) {
		return {
			url: `jobs://${body}`,
			content: renderJobFragment(job, fragment),
			mime: fragment === "status" ? "text/plain" : "text/markdown",
		};
	}

	return {
		url: `jobs://${body}`,
		content: renderJobSummary(job),
		mime: "text/markdown",
		notes: [`status: ${job.status}`],
	};
}

// ──────────────────────── jobs formatters ────────────────────────────

function renderJobsListing(manager: AsyncJobManager): string {
	const jobs = manager.getAllJobs();
	if (jobs.length === 0) return "# Jobs\n\nNo background jobs found.";
	const running = jobs.filter(j => j.status === "running").sort((a, b) => a.startTime - b.startTime);
	const done = jobs.filter(j => j.status !== "running").sort((a, b) => b.startTime - a.startTime);
	const lines = [...running, ...done].map(j =>
		`- \`${j.id}\` [${j.type}] **${j.status}** — ${j.label}  \n  started: ${new Date(j.startTime).toISOString()} · duration: ${formatDuration(Math.max(0, Date.now() - j.startTime))}`
	);
	return `# Jobs\n\n${lines.length} job${lines.length === 1 ? "" : "s"}\n\n${lines.join("\n")}`;
}

function renderJobSummary(job: AsyncJob): string {
	const sections = [
		`# Job ${job.id}`,
		"",
		`- type: ${job.type}`,
		`- status: ${job.status}`,
		`- label: ${job.label}`,
		`- start: ${new Date(job.startTime).toISOString()}`,
		`- duration: ${formatDuration(Math.max(0, Date.now() - job.startTime))}`,
	];
	if (isCompletedJob(job.status) && job.resultText) {
		sections.push("", "## Result", "", "```", job.resultText, "```");
	}
	if (isFailedJob(job.status) && job.errorText) {
		sections.push("", "## Error", "", "```", job.errorText, "```");
	}
	return sections.join("\n");
}

function renderJobFragment(job: AsyncJob, fragment: string): string {
	switch (fragment) {
		case "status": return job.status;
		case "result": return job.resultText ?? "";
		case "error": return job.errorText ?? "";
		case "progress": return job.latestProgress ? JSON.stringify(job.latestProgress, null, 2) : "";
		default: return renderJobSummary(job);
	}
}

function isCompletedJob(s: AsyncJob["status"]): boolean {
	return s === "completed" || s === "completed-empty";
}
function isFailedJob(s: AsyncJob["status"]): boolean {
	return !["pending", "running", "completed", "completed-empty", "aborted", "cancelled"].includes(s);
}

// ─────────────────── helpers ─────────────────────────────────────────

function mimeForExtension(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".md": return "text/markdown";
		case ".py": return "text/x-python";
		case ".js": case ".ts": return "text/javascript";
		case ".json": return "application/json";
		case ".yml": case ".yaml": return "application/x-yaml";
		case ".sh": return "text/x-sh";
		default: return "text/plain";
	}
}
