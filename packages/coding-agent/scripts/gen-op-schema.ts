#!/usr/bin/env bun
/**
 * Generate TypeBox Op schema from kernel `listOps()` NAPI introspection.
 *
 * The kernel Op enum is the sole source of truth. This script reads every
 * variant's metadata (fields, types, descriptions) and emits a TypeBox
 * discriminated-union schema with exactly one `Type.Object({...})` per
 * variant. The generated file is the TS-side contract.
 *
 * Usage: bun run gen:op-schema
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listOps } from "@oh-my-pi/pi-natives";

// ── FieldType → TypeBox-primitive mapping ──
// identifier = inline Type.String until promoted to codepath-types primitive

const FIELD_TYPES: Record<string, string> = {
  content: "contentSchema",
  identifier: 'Type.String({ description: "New identifier name" })',
  bool: "Type.Boolean()",
  symScope: "symScopeSchema",
  occurrence: "occurrenceSchema",
  direction: "directionSchema",
  spliceMode: "spliceModeSchema",
  lineAnchor: "lineAnchorSchema",
  lineSpan: "lineSpanSchema",
  lineAt: "lineAtSchema",
  diff: 'Type.String({ description: "unified diff" })',
  u32: "Type.Integer({ minimum: 0 })",
};

// ── Target-family → field schema for the `target` field ──

function targetFieldSchema(targetFamily: string): string {
  if (targetFamily === "file" || targetFamily === "line" || targetFamily === "heading") return "filePathSchema";
  if (targetFamily === "symbol" || targetFamily === "css") return "symbolPathSchema";
  return "Type.String()";
}

function fieldTypeExpression(
  typeName: string,
  fieldName: string,
  targetFamily: string,
  description: string,
): string {
  // The `target` field schema depends on the variant's targetFamily
  if (fieldName === "target" && typeName === "stringField") {
    return targetFieldSchema(targetFamily);
  }

  // Known typed fields use their primitive
  if (typeName in FIELD_TYPES) {
    return FIELD_TYPES[typeName] as string;
  }

  // Unknown FieldType — fail loud so new enum variants are explicitly handled
  throw new Error(
    `gen-op-schema: unknown FieldType '${typeName}'. ` +
      `Extend FIELD_TYPES in ${__filename} to handle this kernel-side enum variant. PLAN-308 D-3.`
  );
}

function schemaForField(
  field: { name: string; typeName: string; required: boolean; description: string },
  targetFamily: string,
): string {
  const expr = fieldTypeExpression(field.typeName, field.name, targetFamily, field.description);
  const indent = "    ";
  if (!field.required) {
    return `${indent}${field.name}: Type.Optional(${expr}),`;
  }
  return `${indent}${field.name}: ${expr},`;
}

function generateVariant(
  kind: string,
  targetFamily: string,
  fields: { name: string; typeName: string; required: boolean; description: string }[],
  description: string,
): string {
  const varName = `${kind}Op`;
  const kindField = `    kind: Type.Literal(${JSON.stringify(kind)}),`;
  const fieldLines = fields.map((f) => schemaForField(f, targetFamily)).join("\n");

  return [
    `export const ${varName} = Type.Object(`,
    `  {`,
    `${kindField}`,
    `${fieldLines}`,
    `  },`,
    `  { additionalProperties: false, description: ${JSON.stringify(description)} },`,
    `);`,
  ].join("\n");
}

function generateFile(): string {
  const ops = listOps();

  const variantBlocks = ops.map((op) =>
    generateVariant(op.kind, op.targetFamily, op.fields, op.description),
  );

  const varNames = ops.map((op) => `${op.kind}Op`);
  const unionBody = varNames.join(",\n  ");

  return [
    `// ── AUTO-GENERATED — DO NOT EDIT ──`,
    `// Source: kernel Op enum via list_ops() NAPI introspection`,
    `// Refresh: bun run gen:op-schema`,
    ``,
    `import { type Static, Type } from "@sinclair/typebox";`,
    `import {`,
    `  contentSchema,`,
    `  filePathSchema,`,
    `  symbolPathSchema,`,
    `  lineAnchorSchema,`,
    `  lineSpanSchema,`,
    `  lineAtSchema,`,
    `  occurrenceSchema,`,
    `  directionSchema,`,
    `  spliceModeSchema,`,
    `  symScopeSchema,`,
    `} from "./codepath-primitives";`,
    ``,
    `// ── Per-variant Op schemas ──`,
    `// Each corresponds 1:1 to a variant in the Rust \`Op\` enum.`,
    ``,
    ...variantBlocks,
    ``,
    `// ── Discriminated union of all Op variants ──`,
    ``,
    `export const editOpSchema = Type.Union([`,
    `  ${unionBody},`,
    `]);`,
    ``,
    `export type EditOp = Static<typeof editOpSchema>;`,
  ].join("\n");
}

async function main() {
  // Default output path
  const defaultOutputPath = path.join(import.meta.dir, '../src/tools/codepath-op-schema.generated.ts');

  // Accept --out PATH to override output location
  const outFlagIdx = process.argv.indexOf('--out');
  const outputPath = outFlagIdx !== -1 && outFlagIdx + 1 < process.argv.length
    ? path.resolve(process.argv[outFlagIdx + 1])
    : defaultOutputPath;
  const code = generateFile();
  await fs.writeFile(outputPath, code, "utf-8");

  // Format via Biome for stable byte-equality in regen test
  const { execSync } = await import("node:child_process");
  try {
    execSync(`bunx biome format --write "${outputPath}"`, {
      stdio: "inherit",
      cwd: path.join(import.meta.dir, ".."),
    });
  } catch {
    console.warn("Warning: Biome formatting skipped");
  }

  console.log(`✓ Generated ${outputPath} (${listOps().length} Op variants)`);
}

main().catch((err) => {
  console.error("Failed to generate Op schema:", err);
  process.exit(1);
});
