import { parseArgs } from "../cli/args";
import { runRootCommand } from "../main";

function stripConflictingDomainFlag(argv: string[]): string[] {
	const normalized: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg !== "--domain") {
			normalized.push(arg);
			continue;
		}
		if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
			i++;
		}
	}
	return normalized;
}

export function buildDomainLaunchArgv(domainName: string, argv: string[]): string[] {
	const trimmedName = domainName.trim();
	if (!trimmedName) {
		throw new Error("Domain name is required");
	}
	return ["--domain", trimmedName, ...stripConflictingDomainFlag(argv)];
}

export async function runDomainEntryCommand(domainName: string, argv: string[]): Promise<void> {
	const launchArgv = buildDomainLaunchArgv(domainName, argv);
	const parsed = parseArgs(launchArgv);
	await runRootCommand(parsed, launchArgv);
}
