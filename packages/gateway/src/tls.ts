/**
 * TLS certificate management via mkcert.
 *
 * Generates wildcard certificates for *.localhost using mkcert.
 * Certificates are stored at ~/.spell/gateway/tls/.
 */
import * as fs from "node:fs/promises";
import { logger } from "@spell/pi-utils";
import { $ } from "bun";
import { PATHS } from "./protocol";

export interface TlsConfig {
	cert: string;
	key: string;
}

/** Check if mkcert is installed and return its path. */
export function findMkcert(): string | null {
	return Bun.which("mkcert");
}

/** Get the mkcert CA root directory. */
export async function getCaRootPath(): Promise<string | null> {
	if (!findMkcert()) return null;
	const result = await $`mkcert -CAROOT`.quiet().nothrow();
	if (result.exitCode !== 0) return null;
	return result.text().trim() || null;
}

/** Check if wildcard certificates already exist. */
async function certsExist(): Promise<boolean> {
	try {
		await fs.access(PATHS.cert);
		await fs.access(PATHS.key);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure TLS certificates exist. Generate them via mkcert if missing.
 * Throws if mkcert is not installed.
 */
export async function ensureCerts(): Promise<TlsConfig> {
	if (await certsExist()) {
		logger.debug("[gateway] TLS certificates found", { cert: PATHS.cert });
		return { cert: PATHS.cert, key: PATHS.key };
	}

	const mkcert = findMkcert();
	if (!mkcert) {
		throw new Error(
			"mkcert is not installed. Run 'spell gateway init' to set up TLS certificates.\n" +
				"Install mkcert: https://github.com/FiloSottile/mkcert#installation",
		);
	}

	await fs.mkdir(PATHS.tlsDir, { recursive: true });

	logger.debug("[gateway] Generating wildcard TLS certificates...");
	const result = await $`mkcert -cert-file ${PATHS.cert} -key-file ${PATHS.key} "*.localhost" localhost`
		.quiet()
		.nothrow();

	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString();
		throw new Error(`mkcert failed (exit ${result.exitCode}): ${stderr}`);
	}

	logger.debug("[gateway] TLS certificates generated", { cert: PATHS.cert });
	return { cert: PATHS.cert, key: PATHS.key };
}
