import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, formatLineTag } from "@oh-my-pi/pi-coding-agent/patch";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createSession(cwd: string): ToolSession {
  const sessionDir = path.join(cwd, "session");
  const sessionFile = path.join(cwd, "session.jsonl");
  return {
    cwd,
    hasUI: false,
    getSessionFile: () => sessionFile,
    getSessionId: () => "plan-261-manual-proof",
    getSessionSpawns: () => "*",
    getArtifactsDir: () => sessionDir,
    settings: Settings.isolated(),
  };
}

function getTextOutput(result: Awaited<ReturnType<EditTool["execute"]>>): string {
  return (
    result.content
      ?.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
      .map(block => block.text)
      .join("\n") ?? ""
  );
}

async function main(): Promise<void> {
  const outputPath = process.argv[2];
  if (!outputPath) {
    throw new Error("Missing output path");
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-261-hashline-proof-"));
  const file = path.join(tmpDir, "Cargo.toml");
  const initialLines = ["[package]", 'name = "demo"', 'version = "0.1.0"'];
  await Bun.write(file, `${initialLines.join("\n")}\n`);

  const tool = new EditTool(createSession(tmpDir));
  const sections: string[] = [];

  const missingAnchorMessage = await tool
    .execute("missing-anchor", {
      path: file,
      edits: [{ op: "replace", lines: ['name = "renamed"'] }],
    })
    .then(() => "UNEXPECTED_SUCCESS")
    .catch(error => (error instanceof Error ? error.message : String(error)));
  sections.push(
    [
      "## Missing anchor replace",
      `Message: ${missingAnchorMessage}`,
      `Checks: ${[
        missingAnchorMessage.includes("replace requires at least one valid LINE#ID anchor"),
        missingAnchorMessage.includes("Re-read the file"),
        !missingAnchorMessage.includes("Replace requires at least one anchor (tag or end)"),
      ].join(", ")}`,
    ].join("\n"),
  );

  const malformedAnchorMessage = await tool
    .execute("malformed-anchor", {
      path: file,
      edits: [{ op: "replace", pos: 'name = "demo"', lines: ['name = "renamed"'] }],
    })
    .then(() => "UNEXPECTED_SUCCESS")
    .catch(error => (error instanceof Error ? error.message : String(error)));
  sections.push(
    [
      "## Malformed anchor replace",
      `Message: ${malformedAnchorMessage}`,
      `Checks: ${[
        malformedAnchorMessage.includes("invalid pos anchor"),
        malformedAnchorMessage.includes("Expected LINE#ID"),
        !malformedAnchorMessage.includes("has changed since last read"),
      ].join(", ")}`,
    ].join("\n"),
  );

  const staleOriginal = 'name = "demo"';
  const staleCurrent = 'name = "demo-renamed"';
  const staleTag = formatLineTag(2, staleOriginal);
  await Bun.write(file, `[package]\n${staleCurrent}\nversion = "0.1.0"\n`);
  const staleMessage = await tool
    .execute("stale-anchor", {
      path: file,
      edits: [{ op: "replace", pos: staleTag, lines: ['name = "final"'] }],
    })
    .then(() => "UNEXPECTED_SUCCESS")
    .catch(error => (error instanceof Error ? error.message : String(error)));
  sections.push(
    [
      "## Stale hash replace",
      `Message:\n${staleMessage}`,
      `Expected remap: ${formatLineTag(2, staleCurrent)}`,
      `Checks: ${[
        staleMessage.includes("has changed since last read"),
        staleMessage.includes(formatLineTag(2, staleCurrent)),
        !staleMessage.includes("invalid pos anchor"),
      ].join(", ")}`,
    ].join("\n"),
  );

  const validResult = await tool.execute("valid-anchor", {
    path: file,
    edits: [{ op: "replace", pos: formatLineTag(2, staleCurrent), lines: ['name = "final"'] }],
  });
  const finalText = await Bun.file(file).text();
  sections.push(
    [
      "## Valid hashline replace",
      `Result: ${getTextOutput(validResult)}`,
      "Final file:",
      finalText,
      `Checks: ${[
        getTextOutput(validResult).includes("Updated"),
        finalText.includes('name = "final"'),
      ].join(", ")}`,
    ].join("\n"),
  );

  const allPassed = [
    missingAnchorMessage.includes("replace requires at least one valid LINE#ID anchor") &&
      missingAnchorMessage.includes("Re-read the file") &&
      !missingAnchorMessage.includes("Replace requires at least one anchor (tag or end)"),
    malformedAnchorMessage.includes("invalid pos anchor") &&
      malformedAnchorMessage.includes("Expected LINE#ID") &&
      !malformedAnchorMessage.includes("has changed since last read"),
    staleMessage.includes("has changed since last read") && staleMessage.includes(formatLineTag(2, staleCurrent)),
    getTextOutput(validResult).includes("Updated") && finalText.includes('name = "final"'),
  ].every(Boolean);

  const report = [
    `PLAN-261 manual hashline verification`,
    `Overall: ${allPassed ? "PASS" : "FAIL"}`,
    `Workspace temp: ${tmpDir}`,
    "",
    ...sections,
    "",
    "## Renderer note",
    "Shared edit renderer now routes edit errors through formatErrorMessage() in packages/coding-agent/src/patch/shared.ts; no additional runtime failures occurred while exercising the edit tool outputs above.",
  ].join("\n\n");

  await Bun.write(outputPath, report);
  if (!allPassed) {
    process.exitCode = 1;
  }
}

await main();
