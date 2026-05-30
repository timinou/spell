/**
 * Root command for the coding agent CLI.
 */

import { Command } from "@spell/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { runRootCommand } from "../main";
import { launchExamples, launchFlags, launchMessageArgs } from "./launch-common";

export default class Index extends Command {
	static description = "AI coding assistant";
	static hidden = true;
	static args = launchMessageArgs;
	static flags = launchFlags;
	static examples = launchExamples;
	static strict = false;

	async run(): Promise<void> {
		const parsed = parseArgs(this.argv);
		await runRootCommand(parsed, this.argv);
	}
}
