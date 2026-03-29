import type { LoopDomainDefinition } from "../types";
import { createArchitectureDomain } from "./architecture";
import { createCodeDomain } from "./code";
import { createDocsDomain } from "./docs";
import { createSecurityDomain } from "./security";
import { createTestDomain } from "./test";
import { createUiDomain } from "./ui";

export class LoopDomainRegistry {
	#domains = new Map<string, LoopDomainDefinition>();

	constructor() {
		for (const domain of [
			createCodeDomain(),
			createTestDomain(),
			createArchitectureDomain(),
			createUiDomain(),
			createSecurityDomain(),
			createDocsDomain(),
		]) {
			this.register(domain);
		}
	}

	register(domain: LoopDomainDefinition): void {
		if (this.#domains.has(domain.name)) {
			throw new Error(`Duplicate loop domain: ${domain.name}`);
		}
		this.#domains.set(domain.name, domain);
	}

	get(name: string): LoopDomainDefinition | undefined {
		return this.#domains.get(name);
	}

	list(): LoopDomainDefinition[] {
		return Array.from(this.#domains.values()).map(domain => ({ ...domain, defaultGates: [...domain.defaultGates] }));
	}
}
