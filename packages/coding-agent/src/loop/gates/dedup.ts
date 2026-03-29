import { hashContent, normalizeFindingText } from "../hash";

export interface DedupResult {
	hash: string;
	repeated: boolean;
	normalizedFindings: string[];
}

export class FindingDedup {
	#findings = new Map<string, string>();

	evaluate(gateId: string, findings: string[]): DedupResult {
		const normalizedFindings = findings.map(normalizeFindingText).filter(Boolean);
		const hash = hashContent(normalizedFindings.join("\n"));
		const previous = this.#findings.get(gateId);
		this.#findings.set(gateId, hash);
		return {
			hash,
			repeated: previous === hash,
			normalizedFindings,
		};
	}
}
