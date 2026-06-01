import { APP_NAME } from "@spell/pi-utils";
import { Args, Command } from "@spell/pi-utils/cli";
import { runDomainEntryCommand } from "./domain-entry";
import { baseLaunchFlags, launchMessageArgs } from "./launch-common";

export default class Domain extends Command {
	static description = "Start a Spell domain";
	static args = {
		name: Args.string({
			description: "Domain name to start (for example: growth)",
			required: true,
		}),
		...launchMessageArgs,
	};
	static flags = baseLaunchFlags;
	static examples = [
		`# Start the growth domain\n  ${APP_NAME} domain growth`,
		`# Start the growth domain with an initial prompt\n  ${APP_NAME} domain growth "Summarize campaign performance"`,
	];
	static strict = false;

	async run(): Promise<void> {
		const domainName = this.argv[0]?.trim();
		if (!domainName) {
			throw new Error("Missing required argument: name");
		}
		await runDomainEntryCommand(domainName, this.argv.slice(1));
	}
}
