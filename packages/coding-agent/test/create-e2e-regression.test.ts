import { test, expect } from "bun:test";
import { CreateTool } from "@oh-my-pi/pi-coding-agent/tools";
import * as fs from "node:fs/promises";
import * as path from "node:path";

test("e2e: create tool actually writes the file (PLAN-296 regression)", async () => {
  const tmp = "/tmp/spell-smoke-create-" + Date.now();
  await fs.mkdir(tmp, { recursive: true });
  try {
    const tool = new CreateTool({
      cwd: tmp,
      hasUI: false,
      getSessionFile: () => null,
      getSessionSpawns: () => "*",
      settings: {} as any,
    } as any);

    const result = await tool.execute("t", {
      path: "apps/hotelcomm/test/hotelcomm/boot/pgvector_types_guard_test.exs",
      content: 'defmodule Hotelcomm.Boot.PgvectorTypesGuardTest do\n  use ExUnit.Case\nend\n',
    });

    const text = result.content.find((c: any) => c.type === "text")?.text ?? "";
    console.log("[create] result text:", text);
    const target = path.join(tmp, "apps/hotelcomm/test/hotelcomm/boot/pgvector_types_guard_test.exs");
    expect(await fs.exists(target)).toBe(true);
    const content = await fs.readFile(target, "utf-8");
    expect(content).toContain("PgvectorTypesGuardTest");
    console.log("[create] ✓ file persisted; bytes:", content.length);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
