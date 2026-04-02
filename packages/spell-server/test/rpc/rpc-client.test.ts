import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "../../src/rpc/rpc-client";
import type { RpcEvent } from "../../src/rpc/types";

const TEST_TIMEOUT_MS = 1_000;

function eventWithType<TType extends RpcEvent["type"]>(
	event: RpcEvent,
	type: TType,
): event is Extract<RpcEvent, { type: TType }> {
	return event.type === type;
}

describe("RpcClient", () => {
	let spellBinDir = "";
	let spellPath = "";

	beforeAll(async () => {
		spellBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-rpc-client-"));
		spellPath = path.join(spellBinDir, "spell");
		const mockScript = `#!/usr/bin/env bun
		const args = process.argv.slice(2);
		const promptFlag = args.indexOf("--append-system-prompt");
		const modelFlag = args.indexOf("--model");
		const scenario = promptFlag >= 0 && args[promptFlag + 1] ? args[promptFlag + 1] : "default";
		const selectedModel = modelFlag >= 0 && args[modelFlag + 1] ? args[modelFlag + 1] : null;

		const send = event => process.stdout.write(JSON.stringify(event) + "\\n");
		send({ type: "ready" });

		if (scenario === "startup-events") {
		  send({ type: "message_start" });
		  send({ type: "message_end" });
		}
		if (scenario === "partial-line") {
		  process.stdout.write('{"type":"tool_execution_start","toolCallId":"tool-1",');
		  process.stdout.write('"toolName":"bash"}\\n');
		}
		if (scenario === "exit-soon") {
		  setTimeout(() => process.exit(2), 20);
		}

		let stdinBuffer = "";
		process.stdin.setEncoding("utf8");
		process.stdin.resume();
		process.stdin.on("data", chunk => {
		  stdinBuffer += chunk;
		  while (true) {
		    const newline = stdinBuffer.indexOf("\\n");
		    if (newline === -1) break;
		    const line = stdinBuffer.slice(0, newline).trim();
		    stdinBuffer = stdinBuffer.slice(newline + 1);
		    if (!line) continue;

		    const command = JSON.parse(line);
		    if (scenario === "model-flag") {
		      send({ type: "response", command: "echo", success: true, data: { command, args, selectedModel } });
		    } else if (scenario === "prompt-response-error" && command.type === "prompt") {
		      send({ type: "response", command: "prompt", success: false, error: "No model selected" });
		      continue;
		    } else {
		      send({ type: "response", command: "echo", success: true, data: command });
		    }

		    if (command.type === "prompt") {
		      send({ type: "agent_start" });
		      if (scenario === "assistant-error-message-end") {
		        send({
		          type: "message_end",
		          message: { role: "assistant", stopReason: "error", errorMessage: "Invalid API key" },
		        });
		        continue;
		      }
		      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
		      send({ type: "agent_end" });
		    }
		  }
		});
		`;
		await Bun.write(spellPath, mockScript);
		await fs.chmod(spellPath, 0o755);
	});

	afterAll(async () => {
		await fs.rm(spellBinDir, { recursive: true, force: true });
	});

	it("sends prompt command as JSON line", async () => {
		const client = new RpcClient(
			{
				cwd: import.meta.dir,
				tools: ["read", "grep"],
				appendSystemPrompt: "default",
			},
			{ command: spellPath },
		);
		const events: RpcEvent[] = [];
		client.onEvent(event => {
			events.push(event);
		});

		await client.start();
		await client.prompt("hello rpc");

		const responses = events.filter(event => eventWithType(event, "response"));
		const echoResponse = responses.find(event => event.command === "echo");
		if (!echoResponse || !echoResponse.success) {
			throw new Error("Expected successful echo response");
		}
		expect(echoResponse.data).toEqual({ type: "prompt", message: "hello rpc" });

		await client.kill();
	});

	it("passes explicit model flag to the spawned spell process", async () => {
		const client = new RpcClient(
			{
				cwd: import.meta.dir,
				tools: ["read", "grep"],
				model: "claude-sonnet-4-5",
				appendSystemPrompt: "model-flag",
			},
			{ command: spellPath },
		);
		const events: RpcEvent[] = [];
		client.onEvent(event => {
			events.push(event);
		});

		await client.start();
		await client.prompt("hello rpc");

		const responses = events.filter(event => eventWithType(event, "response"));
		const echoResponse = responses.find(event => event.command === "echo");
		if (!echoResponse || !echoResponse.success) {
			throw new Error("Expected successful echo response");
		}
		expect(echoResponse.data).toEqual({
			command: { type: "prompt", message: "hello rpc" },
			args: [
				"--mode",
				"rpc",
				"--tools",
				"read,grep",
				"--model",
				"claude-sonnet-4-5",
				"--append-system-prompt",
				"model-flag",
			],
			selectedModel: "claude-sonnet-4-5",
		});

		await client.kill();
	});

	it("parses events from stdout stream", async () => {
		const client = new RpcClient(
			{
				cwd: import.meta.dir,
				tools: ["read"],
				appendSystemPrompt: "startup-events",
			},
			{ command: spellPath },
		);
		const events: RpcEvent[] = [];
		client.onEvent(event => {
			events.push(event);
		});

		await client.start();
		await Bun.sleep(30);

		expect(events.some(event => eventWithType(event, "message_start"))).toBe(true);
		expect(events.some(event => eventWithType(event, "message_end"))).toBe(true);

		await client.kill();
	});

	it("handles process exit gracefully", async () => {
		const client = new RpcClient(
			{
				cwd: import.meta.dir,
				tools: ["read"],
				appendSystemPrompt: "exit-soon",
			},
			{ command: spellPath },
		);
		const onClosed = Promise.withResolvers<void>();
		client.onEvent(event => {
			if (eventWithType(event, "error")) {
				onClosed.resolve();
			}
		});

		await client.start();
		await Promise.race([
			onClosed.promise,
			Bun.sleep(TEST_TIMEOUT_MS).then(() => {
				throw new Error("Timed out waiting for RPC exit event");
			}),
		]);

		expect(client.alive).toBe(false);
	});

	it("resolves prompt completion when prompt command returns an error response", async () => {
		const client = new RpcClient(
			{
				cwd: import.meta.dir,
				tools: ["read"],
				appendSystemPrompt: "prompt-response-error",
			},
			{ command: spellPath },
		);
		const events: RpcEvent[] = [];
		client.onEvent(event => {
			events.push(event);
		});

		await client.start();
		await Promise.race([
			client.prompt("hello rpc"),
			Bun.sleep(TEST_TIMEOUT_MS).then(() => {
				throw new Error("Timed out waiting for prompt error response");
			}),
		]);

		const responses = events.filter(event => eventWithType(event, "response"));
		expect(responses).toContainEqual({
			type: "response",
			command: "prompt",
			success: false,
			error: "No model selected",
		});

		await client.kill();
	});

	it("resolves prompt completion when assistant message ends with an error", async () => {
		const client = new RpcClient(
			{
				cwd: import.meta.dir,
				tools: ["read"],
				appendSystemPrompt: "assistant-error-message-end",
			},
			{ command: spellPath },
		);
		const events: RpcEvent[] = [];
		client.onEvent(event => {
			events.push(event);
		});

		await client.start();
		await Promise.race([
			client.prompt("hello rpc"),
			Bun.sleep(TEST_TIMEOUT_MS).then(() => {
				throw new Error("Timed out waiting for assistant error message_end");
			}),
		]);

		const messageEnd = events.find(event => eventWithType(event, "message_end"));
		expect(messageEnd).toEqual({
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "Invalid API key" },
		});

		await client.kill();
	});

	it("buffers partial JSON lines correctly", async () => {
		const client = new RpcClient(
			{
				cwd: import.meta.dir,
				tools: ["read"],
				appendSystemPrompt: "partial-line",
			},
			{ command: spellPath },
		);
		const events: RpcEvent[] = [];
		client.onEvent(event => {
			events.push(event);
		});

		await client.start();
		await Bun.sleep(30);

		const toolEvent = events.find(event => eventWithType(event, "tool_execution_start"));
		expect(toolEvent).toBeDefined();
		expect(toolEvent?.toolCallId).toBe("tool-1");
		expect(toolEvent?.toolName).toBe("bash");

		await client.kill();
	});

	it("removes event listeners by reference", async () => {
		const client = new RpcClient(
			{
				cwd: import.meta.dir,
				tools: ["read"],
				appendSystemPrompt: "startup-events",
			},
			{ command: spellPath },
		);
		const removedEvents: RpcEvent[] = [];
		const retainedEvents: RpcEvent[] = [];
		const removedListener = (event: RpcEvent): void => {
			removedEvents.push(event);
		};

		client.onEvent(removedListener);
		(client as unknown as { offEvent?: (callback: (event: RpcEvent) => void) => void }).offEvent?.(removedListener);
		client.onEvent(event => {
			retainedEvents.push(event);
		});

		await client.start();
		await Bun.sleep(30);

		expect(retainedEvents.some(event => eventWithType(event, "message_end"))).toBe(true);
		expect(removedEvents).toEqual([]);

		await client.kill();
	});
});
