/**
 * HTTPS reverse proxy — Bun.serve() instance that routes *.localhost requests
 * to registered backend services via Host-header based routing.
 *
 * Features:
 * - TLS termination with wildcard cert
 * - Host-header alias extraction
 * - Request forwarding with full header/body passthrough
 * - WebSocket upgrade passthrough
 * - Proper error responses (400, 404, 502, 503, 504)
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { ProcessManager } from "./process-manager";
import type { GatewayRegistry } from "./registry";
import type { TlsConfig } from "./tls";

const PROXY_TIMEOUT_MS = 30_000;

export interface ProxyConfig {
	registry: GatewayRegistry;
	processManager: ProcessManager;
	tls: TlsConfig;
	httpsPort?: number;
	httpPort?: number;
}

export interface ProxyServers {
	https: ReturnType<typeof Bun.serve>;
	http: ReturnType<typeof Bun.serve> | null;
	stop(): void;
}

/** Extract the alias from a Host header value. Strips port and .localhost suffix. */
export function extractAlias(host: string | null): string | null {
	if (!host) return null;
	// Strip port if present
	const hostname = host.split(":")[0];
	// Must end with .localhost
	if (!hostname.endsWith(".localhost")) return null;
	const alias = hostname.slice(0, -".localhost".length);
	return alias || null;
}

export function startProxy(config: ProxyConfig): ProxyServers {
	const { registry, processManager, tls, httpsPort = 443, httpPort = 80 } = config;

	const httpsServer = Bun.serve({
		port: httpsPort,
		hostname: "0.0.0.0",
		tls: {
			cert: Bun.file(tls.cert),
			key: Bun.file(tls.key),
		},

		async fetch(req) {
			const host = req.headers.get("host");
			const alias = extractAlias(host);

			if (!alias) {
				return new Response(JSON.stringify({ error: "Bad Request", detail: "Missing or invalid Host header" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				});
			}

			const entry = await registry.get(alias);
			if (!entry) {
				return new Response(JSON.stringify({ error: "Not Found", alias }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}

			// If backend has a managed config and is not active, try lazy-start
			if (entry.status !== "active" && entry.managed) {
				const backend = processManager.get(alias);
				if (!backend?.alive) {
					try {
						await processManager.spawn(alias, entry.managed);
						// Give it a moment to bind its port
						await Bun.sleep(500);
					} catch (_err) {
						return new Response(
							JSON.stringify({
								error: "Service Unavailable",
								detail: "Backend failed to start",
								alias,
							}),
							{
								status: 503,
								headers: { "content-type": "application/json", "retry-after": "5" },
							},
						);
					}
				}

				// Still starting
				if (entry.status === "starting") {
					return new Response(
						JSON.stringify({ error: "Service Unavailable", detail: "Backend starting", alias }),
						{
							status: 503,
							headers: { "content-type": "application/json", "retry-after": "2" },
						},
					);
				}
			}

			// Forward the request to the backend
			return proxyRequest(req, entry.target, alias);
		},
	});

	logger.debug("[gateway] HTTPS proxy started", { port: httpsPort });

	// HTTP → HTTPS redirect server (best-effort, don't fail if port 80 is busy)
	let httpServer: ReturnType<typeof Bun.serve> | null = null;
	try {
		httpServer = Bun.serve({
			port: httpPort,
			hostname: "0.0.0.0",
			fetch(req) {
				const url = new URL(req.url);
				url.protocol = "https:";
				if (httpsPort !== 443) {
					url.port = String(httpsPort);
				} else {
					url.port = "";
				}
				return Response.redirect(url.toString(), 301);
			},
		});
		logger.debug("[gateway] HTTP redirect server started", { port: httpPort });
	} catch (err) {
		logger.debug("[gateway] HTTP redirect server not started (port likely in use)", {
			port: httpPort,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	return {
		https: httpsServer,
		http: httpServer,
		stop() {
			httpsServer.stop();
			httpServer?.stop();
		},
	};
}

// ---------------------------------------------------------------------------
// Request forwarding
// ---------------------------------------------------------------------------

async function proxyRequest(req: Request, target: string, alias: string): Promise<Response> {
	const url = new URL(req.url);
	const backendUrl = `${target}${url.pathname}${url.search}`;

	try {
		const backendResponse = await fetch(backendUrl, {
			method: req.method,
			headers: filterHopByHopHeaders(req.headers),
			body: req.body,
			signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
			redirect: "manual",
		});

		// Forward response with original headers
		const responseHeaders = filterHopByHopHeaders(backendResponse.headers);
		responseHeaders.set("x-gateway-alias", alias);

		return new Response(backendResponse.body, {
			status: backendResponse.status,
			statusText: backendResponse.statusText,
			headers: responseHeaders,
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === "TimeoutError") {
			return new Response(JSON.stringify({ error: "Gateway Timeout", alias }), {
				status: 504,
				headers: { "content-type": "application/json" },
			});
		}

		// Connection refused or other network error
		return new Response(JSON.stringify({ error: "Bad Gateway", alias, detail: "Backend unreachable" }), {
			status: 502,
			headers: { "content-type": "application/json" },
		});
	}
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
]);

function filterHopByHopHeaders(headers: Headers): Headers {
	const filtered = new Headers();
	for (const [key, value] of headers) {
		if (!HOP_BY_HOP.has(key.toLowerCase())) {
			filtered.set(key, value);
		}
	}
	return filtered;
}
