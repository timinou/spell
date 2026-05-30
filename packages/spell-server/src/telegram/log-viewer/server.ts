import { isEnoent, logger } from "@spell/pi-utils";
import type { ChatSession } from "../../rpc/bridge-types";
import type { TelegramBridgeConfig } from "../types";
import { renderSessionHtml, renderSessionListHtml } from "./renderer";

export interface SessionProvider {
	getAllSessions(): ChatSession[];
	getTranscriptPath(chatId: string): string | undefined;
}

function getBearerToken(authorization: string | null): string | undefined {
	if (!authorization) {
		return undefined;
	}
	const match = /^Bearer\s+(.+)$/.exec(authorization.trim());
	return match?.[1]?.trim();
}

function headerContainsLoopback(headerValue: string | null): boolean {
	if (!headerValue) {
		return false;
	}

	const candidates = headerValue
		.toLowerCase()
		.split(",")
		.map(part => part.trim());

	for (const candidate of candidates) {
		if (!candidate) {
			continue;
		}
		if (candidate.includes("127.0.0.1") || candidate.includes("::1") || candidate.includes("localhost")) {
			return true;
		}
		if (candidate.includes("for=127.0.0.1") || candidate.includes("for=::1")) {
			return true;
		}
	}

	return false;
}

function isAuthorized(request: Request, authToken: string): boolean {
	const headers = request.headers;
	if (headerContainsLoopback(headers.get("host"))) {
		return true;
	}
	if (headerContainsLoopback(headers.get("x-forwarded-for"))) {
		return true;
	}
	if (headerContainsLoopback(headers.get("x-real-ip"))) {
		return true;
	}
	if (headerContainsLoopback(headers.get("forwarded"))) {
		return true;
	}

	const bearerToken = getBearerToken(headers.get("authorization"));
	return bearerToken !== undefined && bearerToken === authToken;
}

async function readTranscriptJsonl(transcriptPath: string): Promise<string | undefined> {
	try {
		return await Bun.file(transcriptPath).text();
	} catch (err) {
		if (isEnoent(err)) {
			return undefined;
		}
		throw err;
	}
}

function notFound(): Response {
	return new Response("Not found", { status: 404 });
}

/**
 * Start the optional HTTP log viewer for active Telegram sessions.
 */
export function startLogViewer(config: TelegramBridgeConfig, processManager: SessionProvider) {
	if (config.logViewerPort === undefined) {
		return undefined;
	}

	try {
		const server = Bun.serve({
			port: config.logViewerPort,
			fetch: async request => {
				if (!isAuthorized(request, config.botToken)) {
					return new Response("Unauthorized", { status: 401 });
				}

				if (request.method !== "GET") {
					return notFound();
				}

				try {
					const pathname = new URL(request.url).pathname;

					if (pathname === "/") {
						const html = renderSessionListHtml(processManager.getAllSessions());
						return new Response(html, {
							status: 200,
							headers: { "content-type": "text/html; charset=utf-8" },
						});
					}

					const match = /^\/session\/([^/]+?)(\/raw)?$/.exec(pathname);
					if (match) {
						let chatId: string;
						try {
							chatId = decodeURIComponent(match[1]);
						} catch {
							return notFound();
						}

						const transcriptPath = processManager.getTranscriptPath(chatId);
						if (!transcriptPath) {
							return notFound();
						}

						const jsonlContent = await readTranscriptJsonl(transcriptPath);
						if (match[2] === "/raw") {
							return new Response(jsonlContent ?? "no messages yet\n", {
								status: 200,
								headers: { "content-type": "text/plain; charset=utf-8" },
							});
						}

						const html = renderSessionHtml(jsonlContent ?? "");
						return new Response(html, {
							status: 200,
							headers: { "content-type": "text/html; charset=utf-8" },
						});
					}

					return notFound();
				} catch (err) {
					logger.error("Log viewer request failed", { error: String(err) });
					return new Response("Internal server error", { status: 500 });
				}
			},
		});

		logger.debug("Telegram log viewer started", { port: server.port });
		return server;
	} catch (err) {
		if (String(err).includes("EADDRINUSE")) {
			logger.warn("Log viewer port already in use, skipping startup", {
				port: config.logViewerPort,
			});
			return undefined;
		}
		throw err;
	}
}
