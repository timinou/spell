#!/usr/bin/env bun

import * as fs from "node:fs";

const mode = process.env.PI_TEST_EMBEDDING_WORKER_MODE ?? "success";
const stateFile = process.env.PI_TEST_EMBEDDING_WORKER_STATE_FILE;

function markModeSeen(key) {
	if (!stateFile) return false;
	try {
		const existing = fs.readFileSync(stateFile, "utf8");
		if (existing.split("\n").includes(key)) {
			return true;
		}
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
			throw error;
		}
	}
	fs.appendFileSync(stateFile, `${key}\n`);
	return false;
}

function buildBatchVectors(texts) {
	return texts.map((_text, index) => [1, index + 1, texts.length || 1]);
}

function buildQueryVector(text) {
	return [1, Math.max(text.length, 1), 1];
}

function respond(payload) {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function handleRequest(line) {
	if (mode === "malformed_once" && !markModeSeen("malformed_once")) {
		process.stdout.write("{not-json\n");
		process.exit(0);
	}

	const request = JSON.parse(line);
	if (request.command === "embed_batch") {
		const texts = Array.isArray(request.texts) ? request.texts : [];
		let vectors = buildBatchVectors(texts);
		if (mode === "short_batch") {
			vectors = vectors.slice(0, Math.max(texts.length - 1, 0));
		}
		if (mode === "batch_dim_mismatch" && vectors.length > 0) {
			vectors = vectors.map((vector, index) => (index === Math.min(1, vectors.length - 1) ? vector.slice(0, 2) : vector));
		}
		respond({ ok: true, vectors });
		return;
	}

	if (request.command === "embed_query") {
		const text = typeof request.text === "string" ? request.text : "";
		const vector = mode === "query_dim_mismatch" ? [1, Math.max(text.length, 1)] : buildQueryVector(text);
		respond({ ok: true, vector });
		return;
	}

	if (request.command === "init") {
		respond({ ok: true });
		return;
	}

	respond({ ok: false, error: `unsupported command ${request.command}` });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
	buffer += chunk;
	while (true) {
		const newlineIndex = buffer.indexOf("\n");
		if (newlineIndex === -1) break;
		const line = buffer.slice(0, newlineIndex).trim();
		buffer = buffer.slice(newlineIndex + 1);
		if (line.length === 0) continue;
		handleRequest(line);
	}
});
process.stdin.resume();
