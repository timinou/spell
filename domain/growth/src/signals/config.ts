import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SignalConfig } from "./types.ts";

// ─── TypeBox schema ────────────────────────────────────────────────────────────

const SignalSourceSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  url: Type.String(),
  scraperConfig: Type.String(),
  schedule: Type.String(),
  enabled: Type.Boolean(),
});

const SignalConfigSchema = Type.Object({
  sources: Type.Array(SignalSourceSchema),
});

type SignalConfigRaw = Static<typeof SignalConfigSchema>;

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Read, parse, and validate a signals config from `configPath`.
 *
 * The file must be a JSON document matching `SignalConfigSchema`.
 * Throws a descriptive `Error` when the file cannot be read, is not valid
 * JSON, or fails schema validation.
 */
export async function loadSignalConfig(configPath: string): Promise<SignalConfig> {
  let rawText: string;
  try {
    rawText = await Bun.file(configPath).text();
  } catch (err) {
    throw new Error(`Failed to read signal config at "${configPath}": ${String(err)}`);
  }

  if (rawText.trim() === "") {
    throw new Error(
      `Signal config at "${configPath}" is empty. A valid JSON document is required.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Failed to parse JSON in "${configPath}": ${String(err)}`);
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new Error(
      `Signal config at "${configPath}" must be a JSON object, got: ${typeof parsed}`,
    );
  }

  if (!Value.Check(SignalConfigSchema, parsed)) {
    const errors = [...Value.Errors(SignalConfigSchema, parsed)];
    const details = errors
      .slice(0, 10)
      .map((e) => `  ${e.path}: ${e.message}`)
      .join("\n");
    throw new Error(`Signal config at "${configPath}" failed validation:\n${details}`);
  }

  return parsed as SignalConfigRaw as SignalConfig;
}
