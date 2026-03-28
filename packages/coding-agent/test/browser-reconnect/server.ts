import type { ServerWebSocket } from "bun";

interface RestartOptions {
	delayMs?: number;
}

interface ReconnectTestServerOptions {
	reconnectDelayMs?: number;
	maxReconnectAttempts?: number;
}

interface ServerState {
	baseUrl: string;
	port: number;
}

const DEFAULT_RECONNECT_DELAY_MS = 400;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 6;

const PAGE_TEMPLATE = ({
	reconnectDelayMs,
	maxReconnectAttempts,
}: {
	reconnectDelayMs: number;
	maxReconnectAttempts: number;
}) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Reconnect Test</title>
  </head>
  <body>
    <main>
      <h1>Reconnect test page</h1>
      <p id="status">booting</p>
      <p id="attempts">0</p>
    </main>
    <script>
      const status = document.getElementById("status");
      const attempts = document.getElementById("attempts");
      const reconnectDelayMs = ${reconnectDelayMs};
      const maxReconnectAttempts = ${maxReconnectAttempts};
      let retries = 0;
      let socket;

      function setStatus(value) {
        status.textContent = value;
      }

      function setAttempts(value) {
        attempts.textContent = String(value);
      }

      function connect() {
        setStatus("connecting");
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        socket = new WebSocket(scheme + "://" + location.host + "/ws");

        socket.onopen = () => {
          retries = 0;
          setAttempts(0);
          setStatus("open");
        };

        socket.onmessage = event => {
          if (event.data === "heartbeat") {
            setStatus("open");
          }
        };

        socket.onerror = () => {
          setStatus("error");
        };

        socket.onclose = () => {
          if (retries >= maxReconnectAttempts) {
            setStatus("stalled");
            return;
          }
          retries += 1;
          setAttempts(retries);
          setStatus("reconnecting");
          setTimeout(connect, reconnectDelayMs);
        };
      }

      connect();
    </script>
  </body>
</html>`;

export class ReconnectTestServer {
	#server: Bun.Server<undefined> | null = null;
	#port: number | null = null;
	#reconnectDelayMs: number;
	#maxReconnectAttempts: number;
	#heartbeatTimer: NodeJS.Timeout | null = null;
	#connections = new Set<ServerWebSocket<undefined>>();

	constructor(options?: ReconnectTestServerOptions) {
		this.#reconnectDelayMs = options?.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
		this.#maxReconnectAttempts = options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
	}

	async start(): Promise<ServerState> {
		if (this.#server) {
			return this.state();
		}
		const server = Bun.serve({
			port: this.#port ?? 0,
			fetch: request => {
				const url = new URL(request.url);
				if (url.pathname === "/") {
					return new Response(
						PAGE_TEMPLATE({
							reconnectDelayMs: this.#reconnectDelayMs,
							maxReconnectAttempts: this.#maxReconnectAttempts,
						}),
						{ headers: { "content-type": "text/html; charset=utf-8" } },
					);
				}
				if (url.pathname === "/ws") {
					const upgraded = server.upgrade(request);
					if (upgraded) {
						return new Response(null);
					}
					return new Response("upgrade failed", { status: 400 });
				}
				return new Response("not found", { status: 404 });
			},
			websocket: {
				open: ws => {
					this.#connections.add(ws);
					ws.send("heartbeat");
				},
				close: ws => {
					this.#connections.delete(ws);
				},
				message: () => {},
			},
		});

		this.#server = server;
		if (typeof server.port !== "number") {
			server.stop(true);
			this.#server = null;
			throw new Error("Reconnect test server did not receive a bound port");
		}
		this.#port = server.port;
		this.#startHeartbeat();
		return this.state();
	}

	async restart(options?: RestartOptions): Promise<ServerState> {
		const delayMs = options?.delayMs ?? 0;
		await this.stop();
		if (delayMs > 0) {
			await Bun.sleep(delayMs);
		}
		return this.start();
	}

	async stop(): Promise<void> {
		this.#stopHeartbeat();
		for (const ws of this.#connections) {
			try {
				ws.close();
			} catch {
				// no-op: socket might already be closed while shutting down
			}
		}
		this.#connections.clear();
		if (this.#server) {
			this.#server.stop(true);
			this.#server = null;
		}
	}

	state(): ServerState {
		if (!this.#server || this.#port === null) {
			throw new Error("Reconnect test server is not running");
		}
		return {
			baseUrl: `http://127.0.0.1:${this.#port}`,
			port: this.#port,
		};
	}

	#startHeartbeat(): void {
		this.#stopHeartbeat();
		this.#heartbeatTimer = setInterval(() => {
			for (const ws of this.#connections) {
				try {
					ws.send("heartbeat");
				} catch {
					this.#connections.delete(ws);
				}
			}
		}, 500);
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatTimer) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = null;
		}
	}
}
