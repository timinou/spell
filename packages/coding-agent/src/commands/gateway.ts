/**
 * Manage the Spell HTTPS gateway daemon and services.
 */
import { ensureCerts, findMkcert, GatewayClient, PATHS } from "@oh-my-pi/pi-gateway";
import { logger } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { $ } from "bun";

const SUBCOMMANDS = ["init", "start", "stop", "status", "list", "add", "remove"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export default class Gateway extends Command {
	static description = "Manage the Spell HTTPS gateway";

	static args = {
		subcommand: Args.string({
			description: "Action to perform",
			required: false,
			options: SUBCOMMANDS as unknown as string[],
		}),
	};

	static flags = {
		alias: Flags.string({ char: "a", description: "Service alias (DNS label)" }),
		target: Flags.string({ char: "t", description: "Backend target URL" }),
		persistent: Flags.boolean({ char: "p", description: "Persist across daemon restarts" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Gateway);
		const sub = (args.subcommand ?? "status") as Subcommand;

		switch (sub) {
			case "init":
				return this.#init();
			case "start":
				return this.#start();
			case "stop":
				return this.#stop();
			case "status":
				return this.#status();
			case "list":
				return this.#list();
			case "add":
				return this.#add(flags);
			case "remove":
				return this.#remove(flags);
		}
	}

	async #init(): Promise<void> {
		// 1. Check mkcert availability
		const mkcertPath = findMkcert();
		if (!mkcertPath) {
			process.stdout.write(
				"mkcert is not installed.\n\nInstall it:\n" +
					"  macOS:  brew install mkcert\n" +
					"  Linux:  sudo apt install mkcert  (or see https://github.com/FiloSottile/mkcert)\n" +
					"  Windows: choco install mkcert\n",
			);
			return;
		}

		// 2. Install local CA if not already done
		process.stdout.write("Installing local CA...\n");
		const installResult = await $`${mkcertPath} -install`.quiet().nothrow();
		if (installResult.exitCode !== 0) {
			process.stdout.write(
				`Warning: mkcert -install exited with code ${installResult.exitCode}. CA may already be installed.\n`,
			);
		}

		// 3. Generate certs (skips if already present)
		if ((await Bun.file(PATHS.cert).exists()) && (await Bun.file(PATHS.key).exists())) {
			process.stdout.write("TLS certificates already exist, skipping generation.\n");
		} else {
			process.stdout.write("Generating TLS certificates...\n");
			await ensureCerts();
		}

		// 4. Check unprivileged port binding (Linux only)
		if (process.platform === "linux") {
			try {
				const result = await $`sysctl -n net.ipv4.ip_unprivileged_port_start`.quiet();
				const current = Number.parseInt(result.text().trim(), 10);
				if (current > 443) {
					process.stdout.write("Lowering unprivileged port start to 443...\n");
					await $`sudo sysctl -w net.ipv4.ip_unprivileged_port_start=443`.quiet();
				}
			} catch {
				logger.warn("Could not check/set sysctl ip_unprivileged_port_start");
			}
		}

		// 5. Verify daemon can start
		const client = new GatewayClient();
		try {
			const h = await client.health();
			process.stdout.write(`Gateway daemon running (PID ${h.pid}).\nInit complete.\n`);
		} catch (e) {
			logger.error("Failed to start gateway daemon", e as Record<string, unknown>);
		} finally {
			await client.dispose();
		}
	}

	async #start(): Promise<void> {
		const client = new GatewayClient();
		try {
			const h = await client.health();
			process.stdout.write(`Gateway daemon running (PID ${h.pid}).\n`);
		} catch (e) {
			logger.error("Failed to start gateway daemon", e as Record<string, unknown>);
		} finally {
			await client.dispose();
		}
	}

	async #stop(): Promise<void> {
		const client = new GatewayClient({ autoSpawn: false });
		try {
			const data = (await client.status()) as { pid?: number } | null;
			if (!data?.pid) {
				process.stdout.write("Gateway daemon is not running.\n");
				return;
			}
			process.kill(data.pid, "SIGTERM");
			process.stdout.write(`Sent SIGTERM to daemon (PID ${data.pid}).\n`);
		} catch {
			process.stdout.write("Gateway daemon is not running.\n");
		} finally {
			await client.dispose();
		}
	}

	async #status(): Promise<void> {
		const client = new GatewayClient({ autoSpawn: false });
		try {
			const h = await client.health();
			const services = await client.list();
			process.stdout.write(`Daemon PID: ${h.pid}\nStatus: ${h.status}\nServices: ${services.length}\n`);
		} catch {
			process.stdout.write("Gateway daemon is not running.\n");
		} finally {
			await client.dispose();
		}
	}

	async #list(): Promise<void> {
		const client = new GatewayClient({ autoSpawn: false });
		try {
			const services = await client.list();
			if (services.length === 0) {
				process.stdout.write("No services registered.\n");
				return;
			}
			// Header
			const cols = { alias: 20, target: 35, status: 10, persistent: 10 };
			process.stdout.write(
				`${"ALIAS".padEnd(cols.alias)}${"TARGET".padEnd(cols.target)}${"STATUS".padEnd(cols.status)}${"PERSIST".padEnd(cols.persistent)}\n`,
			);
			for (const s of services) {
				process.stdout.write(
					`${s.alias.padEnd(cols.alias)}${s.target.padEnd(cols.target)}${s.status.padEnd(cols.status)}${(s.persistent ? "yes" : "no").padEnd(cols.persistent)}\n`,
				);
			}
		} catch {
			process.stdout.write("Gateway daemon is not running.\n");
		} finally {
			await client.dispose();
		}
	}

	async #add(flags: { alias?: string; target?: string; persistent?: boolean }): Promise<void> {
		if (!flags.alias || !flags.target) {
			process.stdout.write("Error: --alias and --target are required for 'add'.\n");
			return;
		}
		const client = new GatewayClient();
		try {
			const entry = await client.register({
				alias: flags.alias,
				target: flags.target,
				persistent: flags.persistent,
			});
			process.stdout.write(`Registered ${entry.alias} → ${entry.target}\nURL: ${client.getAliasUrl(entry.alias)}\n`);
		} finally {
			await client.dispose();
		}
	}

	async #remove(flags: { alias?: string }): Promise<void> {
		if (!flags.alias) {
			process.stdout.write("Error: --alias is required for 'remove'.\n");
			return;
		}
		const client = new GatewayClient();
		try {
			await client.deregister(flags.alias);
			process.stdout.write(`Deregistered ${flags.alias}.\n`);
		} finally {
			await client.dispose();
		}
	}
}
