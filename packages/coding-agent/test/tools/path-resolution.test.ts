import { describe, expect, it } from "bun:test";
import {
	detectCwdPrefixDuplication,
	formatCwdPrefixDuplicationMessage,
} from "@spell/pi-coding-agent/tools/path-resolution";

describe("detectCwdPrefixDuplication", () => {
	it("detects single-segment overlap", () => {
		const d = detectCwdPrefixDuplication("/proj/src", "src/foo.ts");
		expect(d).not.toBeNull();
		expect(d?.overlap).toBe(1);
		expect(d?.duplicatedPrefix).toBe("src");
		expect(d?.strippedPath).toBe("foo.ts");
	});

	it("detects multi-segment overlap", () => {
		const d = detectCwdPrefixDuplication(
			"/home/user/code/ora/monorepo/apps/hotelcomm",
			"apps/hotelcomm/lib/hotelcomm_web/controllers/dev_auth_controller.ex",
		);
		expect(d).not.toBeNull();
		expect(d?.overlap).toBe(2);
		expect(d?.duplicatedPrefix).toBe("apps/hotelcomm");
		expect(d?.strippedPath).toBe("lib/hotelcomm_web/controllers/dev_auth_controller.ex");
	});

	it("returns null for absolute paths", () => {
		expect(detectCwdPrefixDuplication("/proj/src", "/proj/src/src/foo.ts")).toBeNull();
	});

	it("returns null for explicitly cwd-anchored paths (./, ../)", () => {
		expect(detectCwdPrefixDuplication("/proj/src", "./src/foo.ts")).toBeNull();
		expect(detectCwdPrefixDuplication("/proj/src", "../src/foo.ts")).toBeNull();
	});

	it("does not false-positive on partial-segment substring overlap", () => {
		// cwd ends in `src`, path starts with `srcs` — different segments.
		expect(detectCwdPrefixDuplication("/proj/src", "srcs/foo.ts")).toBeNull();
		// cwd ends in `app`, path starts with `apps`.
		expect(detectCwdPrefixDuplication("/proj/app", "apps/x.ts")).toBeNull();
	});

	it("does not fire when path equals duplicated prefix entirely", () => {
		// Degenerate case: stripping would leave empty target. Better to allow
		// the underlying tool to handle (likely fails as a directory write).
		expect(detectCwdPrefixDuplication("/proj/src", "src")).toBeNull();
		expect(detectCwdPrefixDuplication("/proj/apps/foo", "apps/foo")).toBeNull();
	});

	it("returns longest overlap when multiple suffixes match", () => {
		// cwd `/a/b/a/b` — both 2-segment and 4-segment tails could match a
		// path starting with `a/b/a/b/x`. We want the longest.
		const d = detectCwdPrefixDuplication("/a/b/a/b", "a/b/a/b/x.ts");
		expect(d?.overlap).toBe(4);
		expect(d?.strippedPath).toBe("x.ts");
	});

	it("handles cwd / path-segment count asymmetry", () => {
		// path-segment count is 2, only 1 segment left after stripping is OK.
		const d = detectCwdPrefixDuplication("/proj/apps/foo", "apps/foo/x.ts");
		expect(d?.overlap).toBe(2);
		expect(d?.strippedPath).toBe("x.ts");
	});
});

describe("formatCwdPrefixDuplicationMessage", () => {
	it("includes supplied path, duplicated prefix, cwd, and stripped suggestion", () => {
		const dup = detectCwdPrefixDuplication("/proj/apps/foo", "apps/foo/lib/x.ts")!;
		const msg = formatCwdPrefixDuplicationMessage("apps/foo/lib/x.ts", "/proj/apps/foo", dup);
		expect(msg).toContain("apps/foo/lib/x.ts");
		expect(msg).toContain("/proj/apps/foo");
		expect(msg).toContain('"apps/foo"');
		expect(msg).toContain('"lib/x.ts"');
		expect(msg).toContain("Paths resolve from cwd");
	});
});

import { resolveCwdRelativePath } from "@spell/pi-coding-agent/tools/path-resolution";

describe("resolveCwdRelativePath", () => {
	const cwd = "/proj/apps/foo";

	it("no-overlap: resolves cwd-relative path as-is", () => {
		const r = resolveCwdRelativePath(cwd, "lib/x.ts", { exists: () => false });
		expect(r.decision).toBe("no-overlap");
		expect(r.path).toBe("/proj/apps/foo/lib/x.ts");
		expect(r.warning).toBeNull();
	});

	it("absolute paths bypass guard", () => {
		const r = resolveCwdRelativePath(cwd, "/etc/hosts", { exists: () => true });
		expect(r.decision).toBe("no-overlap");
		expect(r.path).toBe("/etc/hosts");
		expect(r.warning).toBeNull();
	});

	it("dot-anchored paths bypass guard", () => {
		const r = resolveCwdRelativePath(cwd, "./apps/foo/lib/x.ts", { exists: () => false });
		expect(r.decision).toBe("no-overlap");
		expect(r.warning).toBeNull();
	});

	it("coalesces when nested parent does not exist (bug pattern)", () => {
		// `apps/foo/lib/x.ts` from cwd `/proj/apps/foo` would nest;
		// nested parent `/proj/apps/foo/apps/foo/lib` does not exist.
		const r = resolveCwdRelativePath(cwd, "apps/foo/lib/x.ts", { exists: () => false });
		expect(r.decision).toBe("coalesced");
		expect(r.path).toBe("/proj/apps/foo/lib/x.ts");
		expect(r.warning).toContain("auto-stripped");
		expect(r.warning).toContain("apps/foo");
		expect(r.warning).toContain("lib/x.ts");
	});

	it("keeps nested when nested file or parent already exists on disk", () => {
		const nested = "/proj/apps/foo/apps/foo/lib/x.ts";
		const exists = (p: string) => p === nested;
		const r = resolveCwdRelativePath(cwd, "apps/foo/lib/x.ts", { exists });
		expect(r.decision).toBe("kept-nested");
		expect(r.path).toBe(nested);
		expect(r.warning).toContain("Kept literal interpretation");
	});

	it("keeps nested when nested PARENT exists even if file does not", () => {
		const nestedDir = "/proj/apps/foo/apps/foo/lib";
		const exists = (p: string) => p === nestedDir;
		const r = resolveCwdRelativePath(cwd, "apps/foo/lib/x.ts", { exists });
		expect(r.decision).toBe("kept-nested");
		expect(r.path).toBe("/proj/apps/foo/apps/foo/lib/x.ts");
	});

	it("dir mode ignores file existence (only parent dir counts)", () => {
		const nested = "/proj/apps/foo/apps/foo/lib/x.ts";
		const exists = (p: string) => p === nested; // file exists, parent dir does not
		const r = resolveCwdRelativePath(cwd, "apps/foo/lib/x.ts", { exists, mode: "dir" });
		expect(r.decision).toBe("coalesced");
	});

	it("degenerate: path equals cwd-tail entirely", () => {
		// path-segment count == overlap → strippedPath empty → degenerate.
		// Detector excludes this case; resolver returns "no-overlap" — the path
		// is treated as a relative dir reference. This is the safest fallback.
		const r = resolveCwdRelativePath(cwd, "apps/foo", { exists: () => false });
		expect(["no-overlap", "degenerate"]).toContain(r.decision);
	});
});
