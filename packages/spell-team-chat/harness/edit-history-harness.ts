import { mount } from "svelte";
import EditHistoryPanel from "../src/components/EditHistoryPanel.svelte";
import type { EditHistoryEntry, EditHistoryResult } from "../src/lib/protocol";

// Representative fixture covering every state the panel renders: a multi-file
// rename group, single edits, committed (warning) entries, a reverted (redoable)
// entry, two workspaces, and distinct actors.
const now = Math.floor(Date.now() / 1000);
const entries: EditHistoryEntry[] = [
	// Newest: a 3-file cross-file rename (one undo group), uncommitted.
	{ id: "42", file: "/repo/packages/core/src/registry.ts", workspace: "/repo/packages/core", groupId: "g-rename-1", reverted: false, committed: false, commit: "a1b2c3d", agentLabel: "Alice", timestamp: now - 30 },
	{ id: "41", file: "/repo/packages/core/src/index.ts", workspace: "/repo/packages/core", groupId: "g-rename-1", reverted: false, committed: false, commit: "a1b2c3d", agentLabel: "Alice", timestamp: now - 31 },
	{ id: "40", file: "/repo/packages/api/src/handlers.ts", workspace: "/repo/packages/api", groupId: "g-rename-1", reverted: false, committed: false, commit: "a1b2c3d", agentLabel: "Alice", timestamp: now - 32 },
	// A single edit to a committed file (undo would decline).
	{ id: "39", file: "/repo/apps/web/src/App.tsx", workspace: "/repo/apps/web", groupId: null, reverted: false, committed: true, commit: "f4e5d6c", agentLabel: "Bob", timestamp: now - 240 },
	// A plain single uncommitted edit.
	{ id: "38", file: "/repo/apps/web/src/styles/theme.css", workspace: "/repo/apps/web", groupId: null, reverted: false, committed: false, commit: null, agentLabel: "Bob", timestamp: now - 600 },
	// An already-undone edit (redoable).
	{ id: "37", file: "/repo/packages/core/src/legacy.ts", workspace: "/repo/packages/core", groupId: null, reverted: true, committed: false, commit: null, agentLabel: "Alice", timestamp: now - 1800 },
];

const data: EditHistoryResult = {
	entries,
	total: entries.length,
	undoable: entries.filter((e) => !e.reverted).length,
	redoable: entries.filter((e) => e.reverted).length,
};

const onEditHistory = async (): Promise<EditHistoryResult> => data;

const target = document.getElementById("harness");
if (target) {
	mount(EditHistoryPanel, {
		target,
		props: { sessionId: "demo", onEditHistory, onClose: () => {} },
	});
}
