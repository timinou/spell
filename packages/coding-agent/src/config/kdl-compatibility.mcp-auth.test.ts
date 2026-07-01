/**
 * WAVE 1 (BUG-491): the KDL `mcp { server X { auth { ... } } }` block must
 * round-trip the full set of OAuth refresh coordinates.
 *
 * `MCPManager.#resolveAuthConfig` needs `tokenUrl`, `clientId`, and
 * `clientSecret` (in addition to `type` + `credentialId`) to proactively and
 * forcibly refresh an MCP OAuth token. If the KDL reader/writer drop those
 * fields, a persisted `auth {}` block silently loses the ability to refresh and
 * the server 401s on the next token expiry.
 *
 * These tests pin the invariant: read → (all fields) and read → write → read is
 * lossless.
 */

import { Document, format, Node, parse } from "@bgotink/kdl";
import { describe, expect, it } from "bun:test";

import { readMcpServers, writeMcpServers } from "./kdl-compatibility";

/** Parse a spell.kdl fragment and return its `mcp` block node. */
function mcpNodeFrom(source: string): Node {
	const doc = parse(source);
	const node = doc.findNodeByName("mcp");
	if (!node) throw new Error("no `mcp` block in source");
	return node;
}

/** Serialize a server map into a fresh `mcp` block and return the KDL text. */
function writeToKdl(value: Parameters<typeof writeMcpServers>[1]): string {
	const node = Node.create("mcp");
	writeMcpServers(node, value);
	const doc = new Document([node]);
	return format(doc);
}

const FULL_AUTH_KDL = `
mcp {
	server notion type=http {
		url "https://mcp.notion.com/mcp"
		auth type=oauth credentialId="cred-abc" tokenUrl="https://mcp.notion.com/token" clientId="client-xyz" clientSecret="NOTION_CLIENT_SECRET" // pragma: allowlist secret
	}
}
`;

describe("readMcpServers — OAuth auth coordinates", () => {
	it("reads all five auth fields (type, credentialId, tokenUrl, clientId, clientSecret)", () => {
		const { value } = readMcpServers(mcpNodeFrom(FULL_AUTH_KDL));
		expect(value.notion?.auth).toEqual({
			type: "oauth",
			credentialId: "cred-abc",
			tokenUrl: "https://mcp.notion.com/token",
			clientId: "client-xyz",
			clientSecret: "NOTION_CLIENT_SECRET", // pragma: allowlist secret
		});
	});

	it("still reads a minimal auth block (type + credentialId only) — backward compatible", () => {
		const { value } = readMcpServers(
			mcpNodeFrom(`
mcp {
	server linear type=http {
		url "https://mcp.linear.app/mcp"
		auth type=oauth credentialId="cred-minimal"
	}
}
`),
		);
		expect(value.linear?.auth).toEqual({ type: "oauth", credentialId: "cred-minimal" });
	});

	it("does not attach refresh coordinates to an apikey auth block", () => {
		const { value } = readMcpServers(
			mcpNodeFrom(`
mcp {
	server svc type=http {
		url "https://example.com/mcp"
		auth type=apikey credentialId="cred-key"
	}
}
`),
		);
		expect(value.svc?.auth?.type).toBe("apikey");
		expect(value.svc?.auth?.tokenUrl).toBeUndefined();
	});
});

describe("writeMcpServers — OAuth auth coordinates", () => {
	it("emits all five auth fields", () => {
		const kdl = writeToKdl({
			notion: {
				type: "http",
				url: "https://mcp.notion.com/mcp",
				auth: {
					type: "oauth",
					credentialId: "cred-abc",
					tokenUrl: "https://mcp.notion.com/token",
					clientId: "client-xyz",
					clientSecret: "NOTION_CLIENT_SECRET", // pragma: allowlist secret
				},
			},
		});
		expect(kdl).toContain("credentialId");
		expect(kdl).toContain("tokenUrl");
		expect(kdl).toContain("clientId");
		expect(kdl).toContain("clientSecret");
		expect(kdl).toContain("NOTION_CLIENT_SECRET");
	});
});

describe("round-trip — read → write → read is lossless", () => {
	it("preserves the full OAuth auth block across a serialize cycle", () => {
		const first = readMcpServers(mcpNodeFrom(FULL_AUTH_KDL)).value;
		const kdl = writeToKdl(first);
		const second = readMcpServers(mcpNodeFrom(kdl)).value;
		expect(second).toEqual(first);
		expect(second.notion?.auth).toEqual({
			type: "oauth",
			credentialId: "cred-abc",
			tokenUrl: "https://mcp.notion.com/token",
			clientId: "client-xyz",
			clientSecret: "NOTION_CLIENT_SECRET", // pragma: allowlist secret
		});
	});
});
