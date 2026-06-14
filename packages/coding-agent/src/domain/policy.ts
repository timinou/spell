import { isEnoent } from "@spell/pi-utils";
import { getDomainBaseDir, resolveDomainPath, type SpellDomain } from "./loader";

export interface LoadedDomainPromptContext {
	systemPrompt?: string;
	contextFiles: Array<{ path: string; content: string }>;
}

export async function loadDomainPromptContext(
	domainManifest: SpellDomain | undefined,
	cwd: string,
): Promise<LoadedDomainPromptContext> {
	if (!domainManifest) {
		return { contextFiles: [] };
	}

	// Inline `systemPrompt` (declarative KDL domains) wins over a sidecar
	// `systemPromptPath` (TS manifest domains): a KDL domain carries its prompt
	// in-band with no file to resolve.
	const systemPrompt = domainManifest.systemPrompt
		? domainManifest.systemPrompt
		: domainManifest.systemPromptPath
			? await readDomainFile(domainManifest, cwd, domainManifest.systemPromptPath, "system prompt")
			: undefined;
	const contextFiles = await Promise.all(
		(domainManifest.contextFiles ?? []).map(async filePath => ({
			path: filePath,
			content: await readDomainFile(domainManifest, cwd, filePath, "context file"),
		})),
	);

	return { systemPrompt, contextFiles };
}

export function applyDomainToolPolicy(
	requestedToolNames: string[] | undefined,
	availableToolNames: string[],
	domainManifest: SpellDomain | undefined,
): string[] {
	const normalizedAvailable = normalizeToolNames(availableToolNames);
	if (requestedToolNames !== undefined) {
		return normalizeToolNames(requestedToolNames);
	}
	if (!domainManifest) {
		return normalizedAvailable;
	}

	const include = normalizeToolNames(domainManifest.tools.include ?? []);
	const exclude = new Set(normalizeToolNames(domainManifest.tools.exclude ?? []));
	const includedTools =
		include.length > 0 ? normalizedAvailable.filter(name => include.includes(name)) : normalizedAvailable;
	return includedTools.filter(name => !exclude.has(name));
}

function getDomainFilePath(domainManifest: SpellDomain, cwd: string, filePath: string): string {
	const baseDir = getDomainBaseDir(domainManifest, cwd);
	return resolveDomainPath(domainManifest, baseDir, filePath);
}

async function readDomainFile(
	domainManifest: SpellDomain,
	cwd: string,
	filePath: string,
	label: string,
): Promise<string> {
	const resolvedPath = getDomainFilePath(domainManifest, cwd, filePath);
	try {
		return await Bun.file(resolvedPath).text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`Domain '${domainManifest.name}' ${label} not found at '${resolvedPath}'`);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read domain '${domainManifest.name}' ${label} at '${resolvedPath}': ${message}`);
	}
}

function normalizeToolNames(toolNames: string[]): string[] {
	return [...new Set(toolNames.map(name => name.trim().toLowerCase()).filter(Boolean))];
}
