/**
 * Browser profile management CLI.
 *
 * Handles `spell browser cleanup` for removing orphaned WebEngine profiles.
 */
import { Args, Command, Flags } from "@spell/pi-utils/cli";
import { cleanupProfiles } from "../browser/browser-cleanup";

export default class Browser extends Command {
	static description = "Browser profile management";

	static args = {
		subcommand: Args.string({ description: "Subcommand (cleanup)" }),
	};

	static flags = {
		"dry-run": Flags.boolean({ description: "List orphaned profiles without deleting", default: false }),
		force: Flags.boolean({ char: "f", description: "Delete all orphans including non-timestamped", default: false }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Browser);

		if (args.subcommand !== "cleanup") {
			process.stdout.write(`Unknown subcommand: ${args.subcommand ?? "(none)"}. Available: cleanup\n`);
			return;
		}

		const result = await cleanupProfiles({
			dryRun: flags["dry-run"],
			force: flags.force,
		});

		if (result.orphans.length === 0) {
			process.stdout.write("No orphaned browser profiles found.\n");
			return;
		}

		if (flags["dry-run"]) {
			process.stdout.write(`Found ${result.orphans.length} orphaned profile(s):\n`);
			for (const o of result.orphans) {
				process.stdout.write(`  ${o.name}${o.isTimestamped ? " (test artifact)" : ""}\n`);
			}
			return;
		}

		if (result.deleted.length > 0) {
			process.stdout.write(`Deleted ${result.deleted.length} profile(s): ${result.deleted.join(", ")}\n`);
		}
		if (result.skipped.length > 0) {
			process.stdout.write(`Skipped ${result.skipped.length} profile(s): ${result.skipped.join(", ")}\n`);
			process.stdout.write("Use --force to delete all orphaned profiles.\n");
		}
	}
}
