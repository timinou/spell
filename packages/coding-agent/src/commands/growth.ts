import { Command } from "@spell/pi-utils/cli";
import { runDomainEntryCommand } from "./domain-entry";
import { baseLaunchFlags, launchMessageArgs } from "./launch-common";

export default class Growth extends Command {
	static description = "Start the growth domain";
	static hidden = true;
	static args = launchMessageArgs;
	static flags = baseLaunchFlags;
	static strict = false;

	async run(): Promise<void> {
		await runDomainEntryCommand("growth", this.argv);
	}
}
