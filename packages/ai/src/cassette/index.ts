import { defaultFingerprint } from "./match";
import { redactHeaders, applyDefaultRedaction } from "./redact";
import { replaySse } from "./sse";
import { loadCassette, saveCassette } from "./store";

export type CassetteMode = "record" | "replay" | "passthrough";

export interface CassetteOptions {
	dir: string;
	mode: CassetteMode;
	fingerprint?: (req: Request) => string | Promise<string>;
	redactRequest?: (req: Request) => Request;
}

export interface Cassette {
	fingerprint: string;
	request: {
		method: string;
		url: string;
		headers: Record<string, string>;
		body: string;
	};
	response: {
		status: number;
		statusText: string;
		headers: Record<string, string>;
		kind: "buffered" | "sse";
		body?: string;
		events?: Array<{ deltaMs: number; data: string }>;
	};
	recordedAt: string;
}

export function cassetteFetch(
	inner: typeof globalThis.fetch,
	opts: CassetteOptions,
): typeof globalThis.fetch {
	if (opts.mode === "passthrough") {
		return inner;
	}

	const fn = async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
		const req = new Request(input as any, init as any);
		const fp = await Promise.resolve((opts.fingerprint ?? defaultFingerprint)(req));

		if (opts.mode === "replay") {
			const cassette = (await loadCassette(opts.dir, fp)) as Cassette | null;
			if (!cassette) {
				throw new Error(
					`Cassette miss: no recording found for fingerprint=${fp}. Hint: record first by running in record mode.`,
				);
			}
			const { response } = cassette;
			const headers = new Headers(response.headers);
			if (response.kind === "sse" && response.events) {
				return new Response(replaySse(response.events), {
					status: response.status,
					statusText: response.statusText,
					headers,
				});
			}
			return new Response(response.body ?? "", {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}

		// record mode
		const bodyText = await req.clone().text();
		const redactedReq = opts.redactRequest ? opts.redactRequest(req) : applyDefaultRedaction(req);
		const response = await inner(req);

		const headersObj: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			headersObj[key.toLowerCase()] = value;
		});

		const isSse = response.headers.get("content-type")?.startsWith("text/event-stream") ?? false;

		if (!response.body) {
			const cassette: Cassette = {
				fingerprint: fp,
				request: {
					method: req.method,
					url: req.url,
					headers: Object.fromEntries(redactedReq.headers.entries()),
					body: bodyText,
				},
				response: {
					status: response.status,
					statusText: response.statusText,
					headers: redactHeaders(headersObj),
					kind: "buffered",
					body: "",
				},
				recordedAt: new Date().toISOString(),
			};
			await saveCassette(opts.dir, cassette);
			return response;
		}

		const [sideA, sideB] = response.body.tee();

		if (isSse) {
			const events: Array<{ deltaMs: number; data: string }> = [];
			let lastTime = performance.now();
			const decoder = new TextDecoder();

			(async () => {
				const reader = sideB.getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						const now = performance.now();
						events.push({
							deltaMs: Math.round(now - lastTime),
							data: decoder.decode(value, { stream: true }),
						});
						lastTime = now;
					}
				} finally {
					reader.releaseLock();
					const cassette: Cassette = {
						fingerprint: fp,
						request: {
							method: req.method,
							url: req.url,
							headers: Object.fromEntries(redactedReq.headers.entries()),
							body: bodyText,
						},
						response: {
							status: response.status,
							statusText: response.statusText,
							headers: redactHeaders(headersObj),
							kind: "sse",
							events,
						},
						recordedAt: new Date().toISOString(),
					};
					await saveCassette(opts.dir, cassette);
				}
			})();
		} else {
			(async () => {
				const text = await new Response(sideB).text();
				const cassette: Cassette = {
					fingerprint: fp,
					request: {
						method: req.method,
						url: req.url,
						headers: Object.fromEntries(redactedReq.headers.entries()),
						body: bodyText,
					},
					response: {
						status: response.status,
						statusText: response.statusText,
						headers: redactHeaders(headersObj),
						kind: "buffered",
						body: text,
					},
					recordedAt: new Date().toISOString(),
				};
				await saveCassette(opts.dir, cassette);
			})();
		}

		return new Response(sideA, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
	return fn as typeof globalThis.fetch;
}

export { defaultFingerprint } from "./match";
export { applyDefaultRedaction } from "./redact";
