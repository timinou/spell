import type { AgeDecryptOptions, AgeEncryptOptions } from "./types";

const AGE_INSTALL_INSTRUCTIONS =
	"age is not installed. Install it: https://github.com/FiloSottile/age\n" +
	"  Arch: pacman -S age\n" +
	"  macOS: brew install age\n" +
	"  Other: https://github.com/FiloSottile/age/releases";

/** Check if age binary is available */
export async function checkAgeBinary(): Promise<boolean> {
	const path = Bun.which("age");
	return path !== null;
}

/** Decrypt an .env.age file using age CLI */
export async function decryptAge(opts: AgeDecryptOptions): Promise<string> {
	if (!(await checkAgeBinary())) {
		throw new Error(AGE_INSTALL_INSTRUCTIONS);
	}

	const result = Bun.spawnSync(["age", "--decrypt", "-i", opts.identityFile, opts.encryptedFile], {
		stdout: "pipe",
		stderr: "pipe",
	});

	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString();
		throw new Error(`Failed to decrypt ${opts.encryptedFile}: ${stderr}`);
	}

	return result.stdout.toString();
}

/** Encrypt plaintext using age CLI */
export async function encryptAge(opts: AgeEncryptOptions): Promise<Uint8Array> {
	if (!(await checkAgeBinary())) {
		throw new Error("age is not installed. See decryptAge for install instructions.");
	}

	const recipientArgs = opts.recipients.flatMap(recipient => ["-r", recipient]);
	const proc = Bun.spawn(["age", "--encrypt", ...recipientArgs], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	proc.stdin.write(opts.input);
	proc.stdin.end();

	const output = await new Response(proc.stdout).arrayBuffer();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`age encrypt failed with exit code ${exitCode}`);
	}

	return new Uint8Array(output);
}
