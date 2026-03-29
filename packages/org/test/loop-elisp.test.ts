import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { detectEmacs } from "../src/emacs/detection";

const ELISP_DIR = new URL("../elisp/tools", import.meta.url).pathname;

describe("loop navigation elisp", () => {
	let cwd: string;
	let filePath: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "org-loop-nav-"));
		filePath = path.join(cwd, "fixture.org");
		await Bun.write(
			filePath,
			"* DOING Root\n:PROPERTIES:\n:CUSTOM_ID: LOOP-1\n:LOOP_CHILDREN: LOOP-2\n:LAST_GATE_OUTCOME: pass\n:END:\n\n* Acceptance Criteria\n- done\n\n* DOING Child\n:PROPERTIES:\n:CUSTOM_ID: LOOP-2\n:LAST_GATE_OUTCOME: fail\n:END:\n",
		);
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("defines loop navigation helpers in elisp", async () => {
		const detection = await detectEmacs();
		if (!detection.found || !detection.path) {
			return;
		}
		const evalFile = path.join(cwd, "eval.el");
		await Bun.write(
			evalFile,
			`(progn (add-to-list 'load-path "${ELISP_DIR}") (require 'loop-navigation) (find-file "${filePath}") (goto-char (point-min)) (princ (format "%s|%s|%s|%s" (spell-loop-jump-to-linked "LOOP-2") (spell-loop-show-dep-graph) (if (spell-loop-highlight-acceptance) "t" "nil") (spell-loop-show-gate-results))))`,
		);
		const result = await $`${detection.path} --batch -Q -l ${evalFile}`.quiet().nothrow();
		const output = result.text();
		expect(output).toContain("LOOP-1 -> LOOP-2");
		expect(output).toContain("t");
		expect(output).toContain("pass");
	});
});
