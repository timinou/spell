import type { TypstBlockModel, TypstHitTestResult, TypstSurfaceState } from "@oh-my-pi/pi-natives";
import { exportTypstDocument, type TypstDocumentArtifacts } from "./pdf-export";
import { TypstVisualEditEngine, type TypstEditFailure, type TypstEditResult } from "./editor-engine";

export interface TypstTemplateVariable {
	name: string;
	label: string;
	description: string;
	defaultValue: string;
}

export interface TypstTemplateAsset {
	key: string;
	label: string;
	defaultPath: string;
}

export interface TypstTemplateDefinition {
	id: string;
	name: string;
	path: string;
	visualSource: string;
	variables: TypstTemplateVariable[];
	assets: TypstTemplateAsset[];
}

export interface TypstWorkflowDocument {
	template: TypstTemplateDefinition;
	source: string;
	state: TypstSurfaceState;
	selectedAnchor?: string;
}

export interface AgentInsertSectionRequest {
	afterAnchor: string;
	heading: string;
	body: string;
}

export interface AssetValidationResult {
	ok: boolean;
	path: string;
	error?: string;
}

export interface TypstMappingArtifact {
	hit: TypstHitTestResult;
	source: string;
	selectedAnchor?: string;
}

const TEMPLATE_CATALOG: TypstTemplateDefinition[] = [
	{
		id: "weekly-digest",
		name: "Weekly Digest",
		path: "domain/growth/templates/weekly-digest.typ",
		visualSource: [
			'#let report_title = "Weekly Digest"',
			'#let date_range = "Week of Apr 12"',
			"= Executive Summary",
			"",
			"Summarize campaign momentum for the week in a visual-first report shell.",
			"",
			'- Call out the primary win for the week.',
			'- Flag one risk that needs follow-up.',
			"",
			'#image("assets/hero.svg")',
			"",
			"| Metric | Value |",
			"| CTR | 4.2% |",
			"| ROAS | 3.8x |",
		].join("\n"),
		variables: [
			{ name: "report_title", label: "Report title", description: "Primary heading shown in the digest.", defaultValue: "Weekly Digest" },
			{ name: "date_range", label: "Date range", description: "Subtitle for the covered week.", defaultValue: "Week of Apr 12" },
		],
		assets: [{ key: "hero", label: "Hero image", defaultPath: "assets/hero.svg" }],
	},
	{
		id: "launch-brief",
		name: "Launch Brief",
		path: "domain/growth/templates/campaign-brief.typ",
		visualSource: [
			'#let launch_name = "Spring Release"',
			"= Launch Brief",
			"",
			"Frame the new release for a non-technical stakeholder audience.",
			"",
			'- Audience: existing enterprise customers.',
			'- CTA: book rollout training.',
			"",
			'#image("assets/executive-cover.svg")',
		].join("\n"),
		variables: [
			{ name: "launch_name", label: "Launch name", description: "Human-readable name for the release.", defaultValue: "Spring Release" },
		],
		assets: [{ key: "cover", label: "Cover image", defaultPath: "assets/executive-cover.svg" }],
	},
	{
		id: "performance-review",
		name: "Performance Review",
		path: "domain/growth/templates/client-proposal.typ",
		visualSource: [
			'#let report_title = "Performance Review"',
			"= Performance Review",
			"",
			"| Campaign | Spend | ROAS |",
			"| Retargeting | $4,200 | 5.1x |",
			"| Prospecting | $8,900 | 2.9x |",
		].join("\n"),
		variables: [
			{ name: "report_title", label: "Report title", description: "Heading used in the performance review.", defaultValue: "Performance Review" },
		],
		assets: [],
	},
];

export class TypstTemplateWorkflow {
	#engine = new TypstVisualEditEngine();
	#currentTemplate = TEMPLATE_CATALOG[0];
	#selectedAnchor = "";
	#assetCatalog = new Set(["assets/hero.svg", "assets/executive-cover.svg", "assets/chart-q2.svg"]);

	get templates(): TypstTemplateDefinition[] {
		return TEMPLATE_CATALOG;
	}

	get document(): TypstWorkflowDocument {
		return {
			template: this.#currentTemplate,
			source: this.#engine.source,
			state: this.#engine.state,
			selectedAnchor: this.#selectedAnchor || undefined,
		};
	}

	openTemplate(templateId: string): TypstWorkflowDocument {
		const template = TEMPLATE_CATALOG.find((candidate) => candidate.id === templateId);
		if (!template) {
			throw new Error(`Unknown Typst template: ${templateId}`);
		}
		this.#currentTemplate = template;
		const state = this.#engine.load(template.visualSource);
		this.#selectedAnchor = state.blocks[0]?.anchor ?? "";
		return this.document;
	}

	selectAnchor(anchor: string): void {
		this.#selectedAnchor = anchor;
	}

	hitTest(x: number, y: number): TypstHitTestResult {
		return this.#engine.hitTest(x, y);
	}

	updateVariable(name: string, value: string, anchor?: string): TypstEditResult {
		return this.#engine.applyEdit({
			op: "set_variable",
			anchor,
			name,
			value: toTypstString(value),
			expectedDocumentVersion: this.#engine.state.documentVersion,
		});
	}

	populateVariables(values: Record<string, string>): TypstEditResult[] {
		const results: TypstEditResult[] = [];
		for (const [name, value] of Object.entries(values)) {
			results.push(this.updateVariable(name, value));
		}
		return results;
	}

	replaceAsset(path: string, anchor?: string): TypstEditResult {
		const validation = this.validateAsset(path);
		if (!validation.ok) {
			return rejectWorkflow(this.#engine.state, this.#engine.source, validation.error ?? "Invalid asset path.");
		}
		const target = anchor ?? this.firstBlock((block) => block.kind === "image")?.anchor;
		if (!target) {
			return rejectWorkflow(this.#engine.state, this.#engine.source, "No image block is available for asset replacement.");
		}
		return this.#engine.applyEdit({
			op: "replace_asset_ref",
			anchor: target,
			path,
			expectedDocumentVersion: this.#engine.state.documentVersion,
		});
	}

	rewriteBlockFromAgent(anchor: string, text: string): TypstEditResult {
		this.#selectedAnchor = anchor;
		return this.#engine.applyEdit({
			op: "set_block_text",
			anchor,
			text,
			expectedDocumentVersion: this.#engine.state.documentVersion,
		});
	}

	insertSectionFromAgent(request: AgentInsertSectionRequest): TypstEditResult[] {
		const headingResult = this.#engine.applyEdit({
			op: "insert_block_after",
			anchor: request.afterAnchor,
			kind: "heading",
			text: request.heading,
			level: 2,
			expectedDocumentVersion: this.#engine.state.documentVersion,
		});
		if (!headingResult.accepted) {
			return [headingResult];
		}
		const headingBlock = headingResult.state.blocks.find(
			(block) => block.kind === "heading" && block.text === request.heading,
		);
		if (!headingBlock) {
			return [headingResult, rejectWorkflow(this.#engine.state, this.#engine.source, "Inserted heading could not be remapped.")];
		}
		this.#selectedAnchor = headingBlock.anchor;
		return [
			headingResult,
			this.#engine.applyEdit({
				op: "insert_block_after",
				anchor: headingBlock.anchor,
				kind: "paragraph",
				text: request.body,
				expectedDocumentVersion: this.#engine.state.documentVersion,
			}),
		];
	}

	refreshGeneratedSummary(anchor: string, summary: string): TypstEditResult {
		return this.rewriteBlockFromAgent(anchor, summary);
	}

	validateAsset(path: string): AssetValidationResult {
		if (this.#assetCatalog.has(path)) {
			return { ok: true, path };
		}
		return { ok: false, path, error: `Asset ${path} is not available in the workflow catalog.` };
	}

	assetUsage(): string[] {
		return this.#engine.state.blocks
			.filter((block) => block.kind === "image")
			.map((block) => getImagePath(block) ?? block.text);
	}

	snapshotSvg(): string {
		return this.#engine.snapshotSvg();
	}

	firstBlock(predicate: (block: TypstBlockModel) => boolean): TypstBlockModel | undefined {
		return this.#engine.state.blocks.find(predicate);
	}

	mappingArtifact(x: number, y: number): TypstMappingArtifact {
		return {
			hit: this.#engine.hitTest(x, y),
			source: this.#engine.source,
			selectedAnchor: this.#selectedAnchor || undefined,
		};
	}

	async exportArtifacts(outputDir: string, fileStem = this.#currentTemplate.id): Promise<TypstDocumentArtifacts> {
		return exportTypstDocument(this.#engine.source, outputDir, fileStem, { root: outputDir });
	}
}

function getImagePath(block: TypstBlockModel): string | undefined {
	if (typeof block.meta !== "object" || block.meta === null) return undefined;
	const candidate = (block.meta as { path?: unknown }).path;
	return typeof candidate === "string" ? candidate : undefined;
}

function toTypstString(value: string): string {
	return JSON.stringify(value);
}

function rejectWorkflow(state: TypstSurfaceState, source: string, message: string): TypstEditFailure {
	return {
		accepted: false,
		source,
		state,
		reason: "unsupported_block",
		diagnostics: [{ code: "workflow_rejected", message }],
	};
}
