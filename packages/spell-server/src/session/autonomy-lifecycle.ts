import type { RpcSpawnOptions } from "@oh-my-pi/telegram-bridge";
import type { BaseSpawnOptions, SessionLifecycle } from "./types";

export class AutonomyLifecycle implements SessionLifecycle<string> {
	buildSpawnOptions(_goalName: string, base: BaseSpawnOptions): RpcSpawnOptions {
		const tools = base.tools.includes("autonomy_state") ? [...base.tools] : [...base.tools, "autonomy_state"];
		return {
			cwd: base.cwd,
			tools,
			appendSystemPrompt: base.appendSystemPrompt,
			sessionDir: base.sessionDir,
			sandboxPolicyPath: base.sandboxPolicyPath,
		};
	}

	getIdleTimeout(_goalName: string): null {
		return null;
	}
}
