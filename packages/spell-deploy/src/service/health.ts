import type { HealthCheckOptions } from "./types";

export interface HealthCheckResult {
	ok: boolean;
	status: number;
	error?: string;
}

/** Check if the remote spell-server is healthy via HTTP */
export async function checkHealth(opts: HealthCheckOptions): Promise<HealthCheckResult> {
	const url = `http://${opts.host}:${opts.port}${opts.path}`;
	const authHeader = `Basic ${btoa(`${opts.auth.username}:${opts.auth.password}`)}`;

	for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
		try {
			const response = await fetch(url, {
				headers: { Authorization: authHeader },
				signal: AbortSignal.timeout(5000),
			});
			if (response.ok) {
				return { ok: true, status: response.status };
			}
			if (attempt < opts.retries) {
				await Bun.sleep(opts.retryDelay);
				continue;
			}
			return { ok: false, status: response.status, error: `HTTP ${response.status}` };
		} catch (err) {
			if (attempt < opts.retries) {
				await Bun.sleep(opts.retryDelay);
				continue;
			}
			return {
				ok: false,
				status: 0,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	return { ok: false, status: 0, error: "Max retries exceeded" };
}
