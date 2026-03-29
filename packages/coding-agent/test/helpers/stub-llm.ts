import type { LoopRole } from "../../src/loop/contracts";
import type { LoopRoleResponder, LoopRoleResponse } from "../../src/loop/orchestration/phase-coordinator";
import type { LoopSnapshot } from "../../src/loop/types";

export class StubLoopResponder implements LoopRoleResponder {
	#responses = new Map<string, LoopRoleResponse>();

	set(role: LoopRole, response: LoopRoleResponse): void {
		this.#responses.set(role, response);
	}

	async run(role: LoopRole, _prompt: string, _loop: LoopSnapshot): Promise<LoopRoleResponse> {
		const response = this.#responses.get(role);
		if (!response) {
			throw new Error(`No stub response configured for role ${role}`);
		}
		return structuredClone(response);
	}
}
