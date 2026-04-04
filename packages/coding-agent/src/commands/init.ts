import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type InitCommandArgs, runInitCommand } from "../cli/init-cli";

export default class Init extends Command {
	static description = "Initialize Spell configuration for a project";
	static flags = {
		force: Flags.boolean({ char: "f", description: "Overwrite existing configuration" }),
		domain: Flags.string({ char: "d", description: "Override detected domain (e.g. growth)" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Init);
		const cmd: InitCommandArgs = { flags: { force: flags.force, domain: flags.domain } };
		await runInitCommand(cmd);
	}
}
