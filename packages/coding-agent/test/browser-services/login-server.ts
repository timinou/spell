/**
 * Fake login server for browser service E2E tests.
 * Pattern follows ReconnectTestServer from test/browser-reconnect/server.ts.
 *
 * Routes:
 * - GET /         -> login form HTML
 * - POST /login   -> validates credentials, sets session cookie, redirects to /dashboard
 * - GET /dashboard -> shows logged-in page if session cookie present, else redirects to /
 * - GET /api/check -> returns JSON { loggedIn: true/false }
 */

interface LoginServerState {
	baseUrl: string;
	port: number;
}

const SESSION_TOKEN = "spell-test-session-valid";

const LOGIN_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Login</title></head>
<body>
  <form id="login-form" method="POST" action="/login">
    <input id="username" name="username" type="text" placeholder="Username" />
    <input id="password" name="password" type="password" placeholder="Password" />
    <button id="submit" type="submit">Log In</button>
  </form>
</body>
</html>`;

const DASHBOARD_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Dashboard</title></head>
<body>
  <div id="logged-in">Welcome! You are logged in.</div>
</body>
</html>`;

export class LoginServer {
	#server: ReturnType<typeof Bun.serve> | null = null;
	#port: number | null = null;

	async start(): Promise<LoginServerState> {
		if (this.#server) {
			return this.state();
		}
		const server = Bun.serve({
			port: this.#port ?? 0,
			fetch: request => {
				const url = new URL(request.url);

				if (url.pathname === "/" && request.method === "GET") {
					return new Response(LOGIN_PAGE, {
						headers: { "content-type": "text/html; charset=utf-8" },
					});
				}

				if ((url.pathname === "/login" && request.method === "POST") || url.pathname === "/auto-login") {
					// Accept any request — sets session cookie and redirects to dashboard.
					// GET /auto-login is available for headless tests that struggle with form POSTs.
					return new Response(null, {
						status: 302,
						headers: {
							location: "/dashboard",
							"set-cookie": `session=${SESSION_TOKEN}; Path=/; HttpOnly`,
						},
					});
				}

				if (url.pathname === "/dashboard" && request.method === "GET") {
					if (this.#hasSession(request)) {
						return new Response(DASHBOARD_PAGE, {
							headers: { "content-type": "text/html; charset=utf-8" },
						});
					}
					return new Response(null, {
						status: 302,
						headers: { location: "/" },
					});
				}

				if (url.pathname === "/api/check" && request.method === "GET") {
					const loggedIn = this.#hasSession(request);
					return Response.json({ loggedIn });
				}

				return new Response("not found", { status: 404 });
			},
		});

		this.#server = server;
		if (typeof server.port !== "number") {
			server.stop(true);
			this.#server = null;
			throw new Error("Login server did not receive a bound port");
		}
		this.#port = server.port;
		return this.state();
	}

	async stop(): Promise<void> {
		if (this.#server) {
			this.#server.stop(true);
			this.#server = null;
		}
	}

	state(): LoginServerState {
		if (!this.#server || this.#port === null) {
			throw new Error("Login server is not running");
		}
		return {
			baseUrl: `http://127.0.0.1:${this.#port}`,
			port: this.#port,
		};
	}

	#hasSession(request: Request): boolean {
		const cookie = request.headers.get("cookie") ?? "";
		return cookie.includes(`session=${SESSION_TOKEN}`);
	}
}
