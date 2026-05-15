/**
 * Tier 3 test harness — spawn a real spell-server subprocess with our SPA
 * mounted, return a handle the test can drive. Modeled after the
 * TestSocketClient pattern in packages/spell-server/test/socket/integration.test.ts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export interface TestSpellServer {
	url: string;
	token: string;
	port: number;
	configDir: string;
	stop: () => Promise<void>;
}

export interface TestSpellServerOptions {
	token?: string;
	cassetteDir?: string;
	cassetteMode?: "record" | "replay" | "passthrough";
	extraEnv?: Record<string, string>;
}

async function pickFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = net.createServer();
		s.listen(0, () => {
			const addr = s.address();
			if (typeof addr === "object" && addr) {
				const port = addr.port;
				s.close(() => resolve(port));
			} else {
				s.close(() => reject(new Error("could not pick free port")));
			}
		});
	});
}

async function waitForHttp(url: string, deadlineMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		try {
			const r = await fetch(url);
			if (r.ok) return;
		} catch {
			// not ready yet
		}
		await Bun.sleep(100);
	}
	throw new Error(`server at ${url} did not become ready within ${deadlineMs}ms`);
}

export async function startTestSpellServer(opts: TestSpellServerOptions = {}): Promise<TestSpellServer> {
	const token = opts.token ?? `tok-${Math.random().toString(36).slice(2, 10)}`;
	const port = await pickFreePort();
	const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-team-chat-e2e-"));
	const dotSpell = path.join(configDir, ".spell");
	await fs.mkdir(dotSpell, { recursive: true });
	await fs.writeFile(
		path.join(dotSpell, "server.kdl"),
		`http {\n\tport ${port}\n\tauth {\n\t\tusername "spell"\n\t\tpassword "test"\n\t}\n}\nweb {\n\ttoken "tester" "${token}"\n}\n`,
	);
	await fs.writeFile(
		path.join(dotSpell, "autonomy.kdl"),
		`name "e2e"\nversion "1.0"\nsetup "noop" {\n\tdomain "coding"\n}\n`,
	);

	const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
	const serverEntry = path.join(repoRoot, "packages", "spell-server", "src", "main.ts");
	const distDir = path.resolve(import.meta.dir, "..", "..", "dist");

	const env: Record<string, string> = {
		...process.env,
		SPELL_WEB_DIST: distDir,
		PI_LOG_LEVEL: "warn",
		...(opts.extraEnv ?? {}),
	};
	if (opts.cassetteDir) {
		env.SPELL_CASSETTE_DIR = path.resolve(opts.cassetteDir);
		env.SPELL_CASSETTE_MODE = opts.cassetteMode ?? "passthrough";
	}

	const child: ChildProcess = spawn("bun", ["run", serverEntry, "--config-dir", dotSpell], {
		cwd: repoRoot,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	const url = `http://127.0.0.1:${port}`;
	try {
		await waitForHttp(`${url}/web/`, 10_000);
	} catch (err) {
		child.kill("SIGTERM");
		throw err;
	}

	return {
		url,
		token,
		port,
		configDir,
		async stop() {
			child.kill("SIGTERM");
			await new Promise<void>(r => {
				child.on("exit", () => r());
				setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						// already dead
					}
					r();
				}, 3000);
			});
			await fs.rm(configDir, { recursive: true, force: true });
		},
	};
}
