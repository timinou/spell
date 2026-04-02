import { describe, expect, it, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import type { GoalResult } from "../../src/executor";
import type { HookContext } from "../../src/hooks";
import { WebhookHookExecutor } from "../../src/hooks";
import type { WebhookHook } from "../../src/manifest";

const BASE_RESULT: GoalResult = {
	goalName: "nightly",
	status: "success",
	duration: 321,
	runs: [],
	summary: "All checks passed",
};

const BASE_CONTEXT: HookContext = {
	goalName: "nightly",
	timestamp: new Date("2026-04-02T12:34:56.000Z"),
};

async function withServer(
	handler: (request: Request) => Response | Promise<Response>,
	run: (url: string) => Promise<void>,
): Promise<void> {
	const server = Bun.serve({
		port: 0,
		fetch: handler,
	});

	try {
		await run(server.url.toString());
	} finally {
		await server.stop(true);
	}
}

describe("WebhookHookExecutor", () => {
	it("posts json payload with goal name and status", async () => {
		const executor = new WebhookHookExecutor();
		const requests: Array<{ method: string; body: Record<string, string | number | undefined> }> = [];

		await withServer(
			async request => {
				requests.push({
					method: request.method,
					body: (await request.json()) as Record<string, string | number | undefined>,
				});
				return new Response("ok");
			},
			async url => {
				await executor.execute({ type: "webhook", url, method: "POST" }, BASE_RESULT, BASE_CONTEXT);
			},
		);

		expect(requests).toHaveLength(1);
		expect(requests[0]).toEqual({
			method: "POST",
			body: {
				goalName: "nightly",
				status: "success",
				summary: "All checks passed",
				error: undefined,
				duration: 321,
				date: "2026-04-02T12:34:56.000Z",
			},
		});
	});

	it("substitutes supported template variables and leaves unknown variables literal", async () => {
		const executor = new WebhookHookExecutor();
		const paths: string[] = [];

		await withServer(
			request => {
				paths.push(new URL(request.url).pathname + new URL(request.url).search);
				return new Response("ok");
			},
			async url => {
				const target: WebhookHook = {
					type: "webhook",
					method: "GET",
					url: `${url}notify/{{goalName}}/{{status}}?summary={{summary}}&duration={{duration}}&date={{date}}&unknown={{missing}}`,
				};
				await executor.execute(target, BASE_RESULT, BASE_CONTEXT);
			},
		);

		expect(paths).toEqual([
			"/notify/nightly/success?summary=All%20checks%20passed&duration=321&date=2026-04-02T12:34:56.000Z&unknown={{missing}}",
		]);
	});

	it("supports get requests without a body", async () => {
		const executor = new WebhookHookExecutor();
		const requests: Array<{ method: string; body: string }> = [];

		await withServer(
			async request => {
				requests.push({ method: request.method, body: await request.text() });
				return new Response("ok");
			},
			async url => {
				await executor.execute({ type: "webhook", url, method: "GET" }, BASE_RESULT, BASE_CONTEXT);
			},
		);

		expect(requests).toEqual([{ method: "GET", body: "" }]);
	});

	it("times out unreachable hooks without throwing", async () => {
		const executor = new WebhookHookExecutor();
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const server = Bun.serve({
			port: 0,
			async fetch() {
				await Bun.sleep(10_000);
				return new Response("late");
			},
		});

		try {
			const start = Date.now();
			await executor.execute(
				{ type: "webhook", url: server.url.toString(), method: "GET" },
				BASE_RESULT,
				BASE_CONTEXT,
			);
			expect(Date.now() - start).toBeLessThan(6_500);
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			server.stop(false);
		}
	}, 7_000);

	it("logs warning on non-2xx responses", async () => {
		const executor = new WebhookHookExecutor();
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		await withServer(
			() => new Response("bad", { status: 503, statusText: "Service Unavailable" }),
			async url => {
				await executor.execute({ type: "webhook", url, method: "POST" }, BASE_RESULT, BASE_CONTEXT);
			},
		);

		expect(warnSpy).toHaveBeenCalledWith("Webhook hook responded with non-2xx status", {
			url: expect.stringContaining("http://"),
			status: 503,
			statusText: "Service Unavailable",
		});
	});
});
