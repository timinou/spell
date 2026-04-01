import { describe, test, expect, afterEach } from "bun:test";
import { FormatRegistry } from "@sinclair/typebox";
import { loadScraperConfig } from "../../src/scraper/config-loader.ts";

// TypeBox does not ship a built-in uri format checker; register a minimal one so
// Value.Check() does not reject the 'uri' format with "Unknown format" errors.
FormatRegistry.Set("uri", (v: string) => { try { new URL(v); return true; } catch { return false; } });

// ─── Shared minimal YAML fixture ─────────────────────────────────────────────

/** Minimal valid YAML satisfying every required ScraperConfig field. */
const MINIMAL_YAML = `
name: test-scraper
url: https://example.com
containers:
  - selector: .ad
    fields:
      - name: title
        selector: h1
schemaManifest:
  entities:
    - name: ad
      tableName: ads
      columns:
        - name: id
          type: INTEGER
          primary: true
        - name: platform_id
          type: TEXT
        - name: scraped_at
          type: TEXT
`;

// Track temp files created per test so we can clean up after each.
const tmpFiles: string[] = [];

async function writeTmp(name: string, content: string): Promise<string> {
  const path = `/tmp/spell-cfg-test-${name}-${Date.now()}.yaml`;
  await Bun.write(path, content);
  tmpFiles.push(path);
  return path;
}

afterEach(async () => {
  // Best-effort cleanup.
  while (tmpFiles.length > 0) {
    const p = tmpFiles.pop()!;
    try {
      await Bun.file(p).exists() && Bun.write(p, ""); // truncate
      const { unlinkSync } = await import("fs");
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("loadScraperConfig", () => {
  describe("valid config", () => {
    test("parses minimal valid YAML into a typed ScraperConfig", async () => {
      const path = await writeTmp("valid", MINIMAL_YAML);
      const config = await loadScraperConfig(path);

      expect(config.name).toBe("test-scraper");
      expect(config.url).toBe("https://example.com");
      expect(config.containers).toHaveLength(1);
      expect(config.containers[0].selector).toBe(".ad");
      expect(config.schemaManifest.entities[0].tableName).toBe("ads");
    });

    test("optional fields are absent rather than null", async () => {
      const path = await writeTmp("optional", MINIMAL_YAML);
      const config = await loadScraperConfig(path);

      expect(config.setupActions).toBeUndefined();
      expect(config.pagination).toBeUndefined();
      expect(config.rateLimit).toBeUndefined();
      expect(config.errorHandling).toBeUndefined();
    });
  });

  describe("template variable resolution", () => {
    test("{{ query.url }} is replaced from options", async () => {
      const yaml = MINIMAL_YAML.replace(
        "url: https://example.com",
        "url: '{{ query.url }}'",
      );
      const path = await writeTmp("template", yaml);

      const config = await loadScraperConfig(path, {
        query: { url: "https://resolved.example.com" },
      });

      expect(config.url).toBe("https://resolved.example.com");
    });

    test("unresolvable template variable becomes empty string", async () => {
      // name is a plain string so an empty result is fine for this smoke test.
      const yaml = MINIMAL_YAML.replace(
        "name: test-scraper",
        "name: '{{ missing.key }}'",
      );
      const path = await writeTmp("missing-template", yaml);

      const config = await loadScraperConfig(path, {});
      // Empty string substituted — name becomes "".
      expect(config.name).toBe("");
    });

    test("no options: template variables are left as-is in the raw text", async () => {
      // When options is undefined the raw text is parsed unchanged.
      // "{{ query.url }}" is a valid YAML string, so it parses to a string value,
      // which then fails TypeBox's uri format check — that's the expected behaviour.
      const yaml = MINIMAL_YAML.replace(
        "url: https://example.com",
        "url: '{{ query.url }}'",
      );
      const path = await writeTmp("no-options-template", yaml);

      // Should throw because "{{ query.url }}" is not a valid URI.
      await expect(loadScraperConfig(path)).rejects.toThrow();
    });
  });

  describe("error handling", () => {
    test("throws when file does not exist", async () => {
      await expect(
        loadScraperConfig("/tmp/this-file-does-not-exist-9z8y7x.yaml"),
      ).rejects.toThrow("Failed to read scraper config");
    });

    test("throws when file is empty", async () => {
      const path = await writeTmp("empty", "");
      await expect(loadScraperConfig(path)).rejects.toThrow(
        "is empty",
      );
    });

    test("throws when YAML is malformed", async () => {
      const path = await writeTmp("malformed", "name: [unclosed");
      await expect(loadScraperConfig(path)).rejects.toThrow(
        "Failed to parse YAML",
      );
    });

    test("throws when required field 'name' is missing", async () => {
      const yaml = MINIMAL_YAML.replace("name: test-scraper\n", "");
      const path = await writeTmp("missing-name", yaml);

      await expect(loadScraperConfig(path)).rejects.toThrow(/name/i);
    });

    test("throws when required field 'url' is missing", async () => {
      const yaml = MINIMAL_YAML.replace("url: https://example.com\n", "");
      const path = await writeTmp("missing-url", yaml);

      await expect(loadScraperConfig(path)).rejects.toThrow(/url/i);
    });

    test("throws when required field 'containers' is missing", async () => {
      const yaml = MINIMAL_YAML.replace(
        /containers:[\s\S]*?(?=schemaManifest)/,
        "",
      );
      const path = await writeTmp("missing-containers", yaml);

      await expect(loadScraperConfig(path)).rejects.toThrow(/containers/i);
    });

    test("throws when 'schemaManifest' is missing", async () => {
      const yaml = MINIMAL_YAML.replace(/schemaManifest:[\s\S]*$/, "");
      const path = await writeTmp("missing-manifest", yaml);

      await expect(loadScraperConfig(path)).rejects.toThrow(/schemaManifest/i);
    });

    test("throws on non-object YAML (plain scalar)", async () => {
      const path = await writeTmp("scalar", "just a string");
      await expect(loadScraperConfig(path)).rejects.toThrow(
        "must be a YAML mapping",
      );
    });

    test("error message includes the config path", async () => {
      const path = await writeTmp("path-in-error", "name: [unclosed");
      await expect(loadScraperConfig(path)).rejects.toThrow(path);
    });
  });
});
