import { describe, expect, it } from "bun:test";
import {
  type SettingPath,
  Settings,
} from "@spell/pi-coding-agent/config/settings";
import {
  BUILTIN_TOOLS,
  compactToolDescription,
  createTools,
  getToolTier,
  HIDDEN_TOOLS,
  TOOL_TIERS,
  type ToolSession,
} from "@spell/pi-coding-agent/tools";

Bun.env.PI_PYTHON_SKIP_CHECK = "1";

function createTestSession(overrides: Partial<ToolSession> = {}): ToolSession {
  return {
    cwd: "/tmp/test",
    hasUI: false,
    getSessionFile: () => null,
    getSessionSpawns: () => "*",
    settings: Settings.isolated(),
    ...overrides,
  };
}

function createSettingsWithOverrides(
  overrides: Partial<Record<SettingPath, unknown>> = {},
): Settings {
  return Settings.isolated({
    "bashInterceptor.enabled": true,
    ...overrides,
  });
}

function createDiscoverySessionHooks(): Partial<ToolSession> {
  const selected: string[] = [];
  return {
    isMCPDiscoveryEnabled: () => true,
    getDiscoverableMCPTools: () => [],
    getSelectedMCPToolNames: () => [...selected],
    activateDiscoveredMCPTools: async (toolNames) => {
      const activated: string[] = [];
      for (const name of toolNames) {
        if (!selected.includes(name)) {
          selected.push(name);
          activated.push(name);
        }
      }
      return activated;
    },
  };
}

describe("createTools", () => {
  it("creates all builtin tools by default", async () => {
    const session = createTestSession();
    const tools = await createTools(session);
    const names = tools.map((t) => t.name);

    // Core tools should always be present
    expect(names).toContain("bash");
    expect(names).toContain("get");
    expect(names).toContain("edit");
    expect(names).toContain("create");

    // FUP-095: the lsp tool was removed; its surface is covered by find
    // (#hover/#signature/#type_definition/#diagnostics, def→/ref→) and
    // edit (symbolRename).
    expect(names).not.toContain("lsp");

    expect(names).toContain("task");
    expect(names).toContain("todo_write");
    expect(names).toContain("fetch");
    expect(names).toContain("web_search");
    expect(names).not.toContain("autonomy_state");
  });

  it("never registers the removed lsp tool, even if requested (FUP-095)", async () => {
    const session = createTestSession();
    const tools = await createTools(session, ["get", "lsp", "create"]);
    const names = tools.map((t) => t.name);

    // `lsp` is silently dropped from the requested subset; it no longer exists.
    expect(names).toEqual(["get", "create"]);
  });

  it("respects requested tool subset", async () => {
    const session = createTestSession();
    const tools = await createTools(session, ["get", "create"]);
    const names = tools.map((t) => t.name);

    expect(names).toEqual(["get", "create"]);
  });

  it("lowercases requested tool subset", async () => {
    const session = createTestSession();
    const tools = await createTools(session, ["Get", "Create"]);
    const names = tools.map((t) => t.name);

    expect(names).toEqual(["get", "create"]);
  });

  it("includes hidden tools when explicitly requested", async () => {
    const session = createTestSession();
    const tools = await createTools(session, ["report_finding"]);
    const names = tools.map((t) => t.name);

    expect(names).toEqual(["report_finding"]);
  });

  it("includes submit_result tool when required", async () => {
    const session = createTestSession({ requireSubmitResultTool: true });
    const tools = await createTools(session);
    const names = tools.map((t) => t.name);

    expect(names).toContain("submit_result");
  });

  it("excludes ask tool when hasUI is false", async () => {
    const session = createTestSession({ hasUI: false });
    const tools = await createTools(session);
    const names = tools.map((t) => t.name);

    expect(names).not.toContain("ask");
  });

  it("includes ask tool when hasUI is true", async () => {
    const session = createTestSession({ hasUI: true });
    const tools = await createTools(session);
    const names = tools.map((t) => t.name);

    expect(names).toContain("ask");
  });

  it("excludes render_mermaid tool by default", async () => {
    const session = createTestSession();
    const tools = await createTools(session);
    const names = tools.map((t) => t.name);

    expect(names).not.toContain("render_mermaid");
  });

  it("includes render_mermaid tool when enabled", async () => {
    const session = createTestSession({
      settings: createSettingsWithOverrides({
        "renderMermaid.enabled": true,
      }),
    });
    const tools = await createTools(session);
    const names = tools.map((t) => t.name);

    expect(names).toContain("render_mermaid");
  });

  it("excludes inspect_image tool by default", async () => {
    const session = createTestSession();
    const tools = await createTools(session);
    const names = tools.map((t) => t.name);

    expect(names).not.toContain("inspect_image");
  });

  it("includes inspect_image tool when enabled", async () => {
    const session = createTestSession({
      settings: createSettingsWithOverrides({
        "inspect_image.enabled": true,
      }),
    });
    const tools = await createTools(session);
    const names = tools.map((t) => t.name);

    expect(names).toContain("inspect_image");
  });

  it("excludes search_tool_bm25 by default", async () => {
    const session = createTestSession();
    const tools = await createTools(session);
    const names = tools.map((t) => t.name);

    expect(names).not.toContain("search_tool_bm25");
  });

  it("excludes search_tool_bm25 when MCP tool discovery lacks execution hooks", async () => {
    const session = createTestSession({
      settings: createSettingsWithOverrides({
        "mcp.discoveryMode": true,
      }),
    });
    const tools = await createTools(session);
    const names = tools.map((t) => t.name);

    expect(names).not.toContain("search_tool_bm25");
  });

  it("includes search_tool_bm25 when MCP tool discovery is enabled and executable", async () => {
    const session = createTestSession({
      settings: createSettingsWithOverrides({
        "mcp.discoveryMode": true,
      }),
      ...createDiscoverySessionHooks(),
    });
    const tools = await createTools(session);
    const names = tools.map((t) => t.name);

    expect(names).toContain("search_tool_bm25");
  });

  it("HIDDEN_TOOLS contains explicit-only tools", () => {
    expect(Object.keys(HIDDEN_TOOLS).sort()).toEqual([
      "autonomy_state",
      "report_finding",
      "resolve",
      "submit_result",
    ]);
  });
});

describe("TOOL_TIERS", () => {
  it("covers every BUILTIN_TOOLS key", () => {
    const builtinKeys = Object.keys(BUILTIN_TOOLS).sort();
    const tieredKeys = Object.keys(TOOL_TIERS).sort();
    expect(tieredKeys).toEqual(builtinKeys);
  });

  it("assigns core tier to essential tools", () => {
    const coreTier: string[] = ["bash", "task", "ask"]; // lsp demoted in PLAN-318 W6
    for (const name of coreTier) {
      expect(getToolTier(name)).toBe("core");
    }
  });

  it("assigns standard tier to find/edit/create/status (post-PLAN-306 cutover)", () => {
    for (const name of ["find", "edit", "create", "status", "get", "manage"]) {
      expect(getToolTier(name)).toBe("standard");
    }
  });

  it("assigns specialized tier to deferred tools", () => {
    // gateway/loop_* dropped in PLAN-306 W11.4.d (BUILTIN_TOOLS commit 2f6958d7a)
    const specialized: string[] = ["canvas", "browser", "calc", "lsp"]; // lsp demoted in PLAN-318 W6
    for (const name of specialized) {
      expect(getToolTier(name)).toBe("specialized");
    }
  });

  it("defaults unknown tools to standard tier", () => {
    expect(getToolTier("mcp_some_custom_tool")).toBe("standard");
    expect(getToolTier("unknown_tool")).toBe("standard");
  });
});

describe("compactToolDescription", () => {
  it("extracts first sentence", () => {
    const full =
      "Performs structural code search using AST matching. Supports multiple patterns and languages.";
    expect(compactToolDescription(full)).toBe(
      "Performs structural code search using AST matching.",
    );
  });

  it("handles descriptions starting with XML tags", () => {
    const full =
      "<instruction>\nUse this for search. It supports regex.\n</instruction>";
    expect(compactToolDescription(full)).toBe("Use this for search.");
  });

  it("truncates long descriptions without sentence boundary", () => {
    const full = `A${"a".repeat(200)}`;
    const result = compactToolDescription(full);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result).toEndWith("...");
  });

  it("returns empty string for empty input", () => {
    expect(compactToolDescription("")).toBe("");
  });

  it("extracts first sentence from multiline description", () => {
    const full =
      "Reads files from local filesystem or internal URLs.\n\n<instruction>\nUse offset for large files.\n</instruction>";
    expect(compactToolDescription(full)).toBe(
      "Reads files from local filesystem or internal URLs.",
    );
  });

  it("truncates at first period even inside abbreviations", () => {
    // The non-greedy regex matches at the first period boundary.
    // Acceptable: abbreviation periods are rare in tool descriptions, and the
    // truncated prefix is still a useful compact summary.
    const full = "Use e.g. offset and limit for pagination. Supports images.";
    expect(compactToolDescription(full)).toBe("Use e.g.");
  });

  it("returns full string when no sentence boundary and under 120 chars", () => {
    const full = "A tool that does something without any sentence terminator";
    expect(compactToolDescription(full)).toBe(full);
  });
});

describe("compact description wrapping on real tool objects", () => {
  /** Helper: clone a tool the way sdk.ts and agent-session.ts do. */
  function wrapCompact(tool: { description: string }) {
    const compact = compactToolDescription(tool.description);
    return Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
      description: compact,
    });
  }

  it("clone has name as own property (required by API serialization)", async () => {
    const session = createTestSession({
      settings: Settings.isolated({ "calc.enabled": true }),
    });
    const tools = await createTools(session);
    const calc = tools.find((t) => t.name === "calc")!;
    const clone = wrapCompact(calc);

    // The crash: providers read tool.name and expect it as an own property.
    // Object.create(tool) put name on the prototype — invisible to spread/JSON.
    expect(Object.hasOwn(clone, "name")).toBe(true);
    expect(clone.name).toBe("calc");
    // Verify spread sees name (simulates provider serialization)
    const spread = { ...clone };
    expect(spread.name).toBe("calc");
  });

  it("clone preserves execute via prototype", async () => {
    const session = createTestSession({
      settings: Settings.isolated({ "calc.enabled": true }),
    });
    const tools = await createTools(session);
    const calc = tools.find((t) => t.name === "calc")!;
    const clone = wrapCompact(calc);

    expect(typeof clone.execute).toBe("function");
    expect(clone.parameters).toBe(calc.parameters);
  });

  it("clone uses compact description without mutating original", async () => {
    const session = createTestSession({
      settings: Settings.isolated({ "calc.enabled": true }),
    });
    const tools = await createTools(session);
    const calc = tools.find((t) => t.name === "calc")!;
    const originalDesc = calc.description;
    const clone = wrapCompact(calc);

    expect(clone.description.length).toBeLessThan(originalDesc.length);
    expect(calc.description).toBe(originalDesc); // original unmodified
  });

  it("works on every specialized tool in the registry", async () => {
    const session = createTestSession({
      settings: Settings.isolated({
        "browser.enabled": true,

        "inspect_image.enabled": true,
        "renderMermaid.enabled": true,
        "calc.enabled": true,
      }),
    });
    const tools = await createTools(session);
    for (const tool of tools) {
      if (getToolTier(tool.name) !== "specialized") continue;
      const clone = wrapCompact(tool);
      expect(Object.hasOwn(clone, "name")).toBe(true);
      expect(clone.name).toBe(tool.name);
      expect(typeof clone.execute).toBe("function");
      expect(clone.description.length).toBeLessThanOrEqual(
        tool.description.length,
      );
    }
  });
});

describe("registry invariants", () => {
  it("every BUILTIN_TOOLS key is classified in TOOL_TIERS", () => {
    const builtin = Object.keys(BUILTIN_TOOLS);
    const tiered = new Set(Object.keys(TOOL_TIERS));
    const unclassified = builtin.filter((k) => !tiered.has(k));
    expect(unclassified).toEqual([]);
  });
});
