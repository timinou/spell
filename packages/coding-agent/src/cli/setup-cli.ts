/**
 * Setup CLI command handler.
 *
 * Handles `spell setup <component>` to install dependencies for optional features.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import spellHammerspoonLua from "../../../macos/hammerspoon/spell.lua" with { type: "text" };
import { theme } from "../modes/theme/theme";

export type SetupComponent = "stt" | "hammerspoon";

export interface SetupCommandArgs {
	component: SetupComponent;
	flags: {
		json?: boolean;
		check?: boolean;
	};
}

const VALID_COMPONENTS: SetupComponent[] = ["stt", "hammerspoon"];

/**
 * Parse setup subcommand arguments.
 * Returns undefined if not a setup command.
 */
export function parseSetupArgs(args: string[]): SetupCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "setup") {
		return undefined;
	}

	if (args.length < 2) {
		console.error(chalk.red(`Usage: ${APP_NAME} setup <component>`));
		console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const component = args[1];
	if (!VALID_COMPONENTS.includes(component as SetupComponent)) {
		console.error(chalk.red(`Unknown component: ${component}`));
		console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const flags: SetupCommandArgs["flags"] = {};
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--check" || arg === "-c") {
			flags.check = true;
		}
	}

	return {
		component: component as SetupComponent,
		flags,
	};
}

/**
 * Run the setup command.
 */
export async function runSetupCommand(cmd: SetupCommandArgs): Promise<void> {
	switch (cmd.component) {
		case "stt":
			await handleSttSetup(cmd.flags);
			break;
		case "hammerspoon":
			await handleHammerspoonSetup(cmd.flags);
			break;
	}
}

async function handleSttSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const { checkDependencies, formatDependencyStatus } = await import("../stt/setup");
	const status = await checkDependencies();

	if (flags.json) {
		console.log(JSON.stringify(status, null, 2));
		if (!status.recorder.available || !status.python.available || !status.whisper.available) process.exit(1);
		return;
	}

	console.log(formatDependencyStatus(status));

	if (status.recorder.available && status.python.available && status.whisper.available) {
		console.log(chalk.green(`\n${theme.status.success} Speech-to-text is ready`));
		return;
	}

	if (flags.check) {
		process.exit(1);
	}

	if (!status.python.available) {
		console.error(chalk.red(`\n${theme.status.error} Python not found`));
		console.error(chalk.dim("Install Python 3.8+ and ensure it's in your PATH"));
		process.exit(1);
	}

	if (!status.recorder.available) {
		console.error(chalk.yellow(`\n${theme.status.warning} No recording tool found`));
		console.error(chalk.dim(status.recorder.installHint));
	}

	if (!status.whisper.available) {
		console.log(chalk.dim(`\nInstalling openai-whisper...`));
		const { resolvePython } = await import("../stt/transcriber");
		const pythonCmd = resolvePython()!;
		const { $ } = await import("bun");
		const result = await $`${pythonCmd} -m pip install -q openai-whisper`.nothrow();
		if (result.exitCode !== 0) {
			console.error(chalk.red(`\n${theme.status.error} Failed to install openai-whisper`));
			console.error(chalk.dim("Try manually: pip install openai-whisper"));
			process.exit(1);
		}
	}

	const recheck = await checkDependencies();
	if (recheck.recorder.available && recheck.python.available && recheck.whisper.available) {
		console.log(chalk.green(`\n${theme.status.success} Speech-to-text is ready`));
	} else {
		console.error(chalk.red(`\n${theme.status.error} Setup incomplete`));
		console.log(formatDependencyStatus(recheck));
		process.exit(1);
	}
}

const HAMMERSPOON_INIT_SNIPPET = 'local spell = require("spell")\nspell.watchMissionControl()';

function getHammerspoonRoot(): string {
	return path.join(process.env.HOME ?? path.join("/", "tmp"), ".hammerspoon");
}

async function handleHammerspoonSetup(flags: { check?: boolean; json?: boolean }): Promise<void> {
	const hsPath = Bun.which("hs");
	const root = getHammerspoonRoot();
	const initPath = path.join(root, "init.lua");
	const scriptPath = path.join(root, "spell.lua");
	const available = Boolean(hsPath || (await Bun.file(root).exists()));

	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify({ available, hsPath: hsPath ?? null, root, initPath, scriptPath }, null, 2)}\n`,
		);
		if (!available) process.exit(1);
		return;
	}

	if (!available) {
		process.stderr.write("Hammerspoon not found. Install it first: brew install --cask hammerspoon\n");
		process.exit(1);
	}

	if (flags.check) {
		process.stdout.write("Hammerspoon is installed.\n");
		return;
	}

	await fs.mkdir(root, { recursive: true });
	await Bun.write(scriptPath, spellHammerspoonLua);

	let initText = "";
	try {
		initText = await Bun.file(initPath).text();
	} catch {}

	if (!initText.includes(HAMMERSPOON_INIT_SNIPPET)) {
		const prefix = initText.trim().length > 0 && !initText.endsWith("\n") ? "\n\n" : "";
		await Bun.write(initPath, `${initText}${prefix}${HAMMERSPOON_INIT_SNIPPET}\n`);
	}

	if (hsPath) {
		const { $ } = await import("bun");
		await $`${hsPath} -c ${"hs.reload()"}`.quiet().nothrow();
	}

	process.stdout.write("Hammerspoon integration installed.\n");
	process.stdout.write("Mission Control detection: enabled\n");
	process.stdout.write("Spell overview will appear when you open Mission Control.\n");
}

/**
 * Print setup command help.
 */
export function printSetupHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} setup`)} - Install dependencies for optional features

${chalk.bold("Usage:")}
  ${APP_NAME} setup <component> [options]

${chalk.bold("Components:")}
  stt          Install speech-to-text dependencies (openai-whisper, recording tools)
  hammerspoon  Install Mission Control integration for the macOS overview hotkey

${chalk.bold("Options:")}
  -c, --check   Check if dependencies are installed without installing
  --json        Output status as JSON

${chalk.bold("Examples:")}
  ${APP_NAME} setup stt                 Install speech-to-text dependencies
  ${APP_NAME} setup hammerspoon         Install Mission Control integration
  ${APP_NAME} setup stt --check         Check if STT dependencies are available
  ${APP_NAME} setup hammerspoon --check Check if Hammerspoon is available
`);
}
