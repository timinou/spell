import * as path from "node:path";
import type { ManifestSnapshot, ManifestTicket } from "../types";

function getManifestDir(cwd: string, loopId: string): string {
	return path.join(cwd, ".local/!tracks/loops", loopId, "manifest");
}

function renderTicketOrg(ticket: ManifestTicket): string {
	const lines: string[] = [`* ${ticket.state} ${ticket.title}`, ":PROPERTIES:", `:CUSTOM_ID: ${ticket.id}`];
	if (ticket.specPath) lines.push(`:SPEC_PATH: ${ticket.specPath}`);
	if (ticket.effort) lines.push(`:EFFORT: ${ticket.effort}`);
	if (ticket.priority) lines.push(`:PRIORITY: ${ticket.priority}`);
	if (ticket.layer) lines.push(`:LAYER: ${ticket.layer}`);
	if (ticket.dependencies.length > 0) lines.push(`:DEPENDS: ${ticket.dependencies.join(" ")}`);
	if (ticket.triggers.length > 0) lines.push(`:TRIGGER: ${ticket.triggers.join(" ")}`);
	for (const gate of ticket.gates) {
		if (gate.type === "command") lines.push(`:GATE_CMD: ${gate.command}`);
		if (gate.type === "artifact") lines.push(`:GATE_ARTIFACT: ${gate.path}`);
		if (gate.type === "llm-review") lines.push(`:GATE_LLM: ${gate.criteria}`);
	}
	if (ticket.orgItemId) lines.push(`:ORG_ITEM_ID: ${ticket.orgItemId}`);
	if (ticket.childLoopId) lines.push(`:CHILD_LOOP_ID: ${ticket.childLoopId}`);
	if (ticket.iterationHistory.length > 0) lines.push(`:ITERATION_HISTORY: ${ticket.iterationHistory.join(",")}`);
	if (ticket.changedFiles.length > 0) lines.push(`:CHANGED_FILES: ${ticket.changedFiles.join("|")}`);
	if (ticket.findings.length > 0) lines.push(`:FINDINGS: ${ticket.findings.join("|")}`);
	lines.push(":END:");
	if (ticket.acceptanceCriteria.length > 0) {
		lines.push("", "** Acceptance Criteria");
		for (const criterion of ticket.acceptanceCriteria) {
			lines.push(`- [ ] ${criterion}`);
		}
	}
	if (ticket.tags.length > 0) {
		lines.push("", `#+TAGS: ${ticket.tags.join(" ")}`);
	}
	lines.push("");
	return lines.join("\n");
}

function renderManifestOrg(manifest: ManifestSnapshot, loopName: string): string {
	const lines: string[] = [
		`#+TITLE: Manifest for ${loopName}`,
		`#+MANIFEST_VERSION: ${manifest.version}`,
		`#+CREATED_AT: ${new Date(manifest.createdAt).toISOString()}`,
		`#+UPDATED_AT: ${new Date(manifest.updatedAt).toISOString()}`,
		"",
		"* Overview",
		`Total tickets: ${manifest.tickets.length}`,
		`Dependency edges: ${manifest.dependencyEdges.length}`,
		`Trigger rules: ${manifest.triggerRules.length}`,
		"",
		"* Tickets",
	];
	for (const ticket of manifest.tickets) {
		lines.push(`- [[id:${ticket.id}]] ${ticket.state} ${ticket.title}`);
	}
	if (manifest.dependencyEdges.length > 0) {
		lines.push("", "* Dependencies");
		for (const edge of manifest.dependencyEdges) {
			lines.push(`- ${edge.from} -> ${edge.to}`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

export async function writeManifest(
	cwd: string,
	loopId: string,
	loopName: string,
	manifest: ManifestSnapshot,
): Promise<string> {
	const manifestDir = getManifestDir(cwd, loopId);
	const manifestPath = path.join(manifestDir, "..", "manifest.org");
	await Bun.write(manifestPath, renderManifestOrg(manifest, loopName));
	for (const ticket of manifest.tickets) {
		const ticketPath = path.join(manifestDir, `${ticket.id}.org`);
		await Bun.write(ticketPath, renderTicketOrg(ticket));
	}
	return manifestPath;
}

export { getManifestDir, renderManifestOrg, renderTicketOrg };
