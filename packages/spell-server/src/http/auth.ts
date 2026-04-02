import * as crypto from "node:crypto";
import type { ServerConfig } from "./types";

function decodeBasicCredentials(value: string): string | null {
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		return null;
	}
}

export function verifyBasicAuth(request: Request, config: ServerConfig): boolean {
	const header = request.headers.get("Authorization");
	if (!header?.startsWith("Basic ")) {
		return false;
	}

	const decoded = decodeBasicCredentials(header.slice(6));
	if (!decoded) {
		return false;
	}

	const separatorIndex = decoded.indexOf(":");
	if (separatorIndex === -1) {
		return false;
	}

	const user = decoded.slice(0, separatorIndex);
	const pass = decoded.slice(separatorIndex + 1);
	return user === config.auth.username && pass === config.auth.password;
}

export async function verifyHmac(request: Request, body: string, secret: string): Promise<boolean> {
	const signature = request.headers.get("X-Signature-256");
	if (!signature?.startsWith("sha256=")) {
		return false;
	}

	const mac = crypto.createHmac("sha256", secret).update(body).digest("hex");
	const expected = `sha256=${mac}`;
	const receivedBuffer = Buffer.from(signature);
	const expectedBuffer = Buffer.from(expected);
	if (receivedBuffer.length !== expectedBuffer.length) {
		return false;
	}
	return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function verifyBearerToken(request: Request, goalName: string, goalTokens: Record<string, string>): boolean {
	const header = request.headers.get("Authorization");
	if (!header?.startsWith("Bearer ")) {
		return false;
	}

	const token = header.slice(7);
	return goalTokens[goalName] === token;
}
