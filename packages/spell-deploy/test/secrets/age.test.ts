import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkAgeBinary, decryptAge, encryptAge } from "../../src/secrets/age";
import { buildSecretPushCommand } from "../../src/secrets/push";
import type { SshOptions } from "../../src/sync/types";

const sshOptions: SshOptions = {
	host: "spell.example.com",
	user: "spell",
	port: 2222,
	sshKey: "~/.ssh/id_ed25519",
	connectTimeout: 10,
};

describe("age helpers", () => {
	it("returns a boolean when checking for the age binary", async () => {
		expect(typeof (await checkAgeBinary())).toBe("boolean");
	});
});

describe("buildSecretPushCommand", () => {
	it("produces SSH args with the remote secret push script", () => {
		const command = buildSecretPushCommand({
			envContent: "DATABASE_URL=postgres://db\n",
			remotePath: "/srv/spell/app/.env",
			sshOptions,
		});

		expect(command.args).toEqual([
			"ssh",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			"ConnectTimeout=10",
			"-p",
			"2222",
			"-i",
			"~/.ssh/id_ed25519",
			"spell@spell.example.com",
			"cat > /srv/spell/app/.env.tmp && chmod 600 /srv/spell/app/.env.tmp && mv /srv/spell/app/.env.tmp /srv/spell/app/.env",
		]);
	});

	it("pipes env content over stdin", () => {
		const command = buildSecretPushCommand({
			envContent: "SECRET_KEY=shh\n",
			remotePath: "/srv/spell/app/.env",
			sshOptions,
		});

		expect(command.stdin).toBe("SECRET_KEY=shh\n");
	});

	it("keeps chmod 600 in the remote script", () => {
		const command = buildSecretPushCommand({
			envContent: "",
			remotePath: "/srv/spell/app/.env",
			sshOptions,
		});

		expect(command.args.at(-1)).toContain("chmod 600 /srv/spell/app/.env.tmp");
	});

	it("uses an atomic tmp and mv pattern on the remote host", () => {
		const command = buildSecretPushCommand({
			envContent: "A=1\n",
			remotePath: "/srv/spell/app/.env",
			sshOptions,
		});

		expect(command.args.at(-1)).toBe(
			"cat > /srv/spell/app/.env.tmp && chmod 600 /srv/spell/app/.env.tmp && mv /srv/spell/app/.env.tmp /srv/spell/app/.env",
		);
	});

	it("omits the SSH key flag when no key is configured", () => {
		const command = buildSecretPushCommand({
			envContent: "A=1\n",
			remotePath: "/srv/spell/app/.env",
			sshOptions: {
				host: "spell.example.com",
				user: "spell",
				port: 22,
				connectTimeout: 10,
			},
		});

		expect(command.args).not.toContain("-i");
		expect(command.args).toEqual([
			"ssh",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			"ConnectTimeout=10",
			"-p",
			"22",
			"spell@spell.example.com",
			"cat > /srv/spell/app/.env.tmp && chmod 600 /srv/spell/app/.env.tmp && mv /srv/spell/app/.env.tmp /srv/spell/app/.env",
		]);
	});
});

const ageInstalled = Bun.which("age");
const ageKeygenInstalled = Bun.which("age-keygen");
const tempDirs: string[] = [];

afterAll(async () => {
	await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!ageInstalled || !ageKeygenInstalled)("age integration", () => {
	it("encrypts and decrypts a secret env file roundtrip", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-deploy-age-"));
		tempDirs.push(tempDir);

		const keyFile = path.join(tempDir, "test-key.txt");
		const encryptedFile = path.join(tempDir, ".env.age");
		const plaintext = "DATABASE_URL=postgres://localhost/spell\nAPI_KEY=secret\n";

		const keygen = Bun.spawnSync(["age-keygen", "-o", keyFile], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (keygen.exitCode !== 0) {
			throw new Error(`age-keygen failed: ${keygen.stderr.toString()}`);
		}

		const keyContents = await Bun.file(keyFile).text();
		const recipientLine = keyContents.split("\n").find(line => line.startsWith("# public key: "));
		if (!recipientLine) {
			throw new Error("age-keygen output did not include a public key line");
		}
		const recipient = recipientLine.replace("# public key: ", "").trim();

		const encrypted = await encryptAge({
			recipients: [recipient],
			input: plaintext,
		});
		await Bun.write(encryptedFile, encrypted);

		const decrypted = await decryptAge({
			identityFile: keyFile,
			encryptedFile,
		});
		expect(decrypted).toBe(plaintext);
	});
});
