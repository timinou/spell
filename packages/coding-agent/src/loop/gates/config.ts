import type { LoopGateConfig } from "../types";

export function normalizeGateConfig(config: LoopGateConfig): LoopGateConfig {
	if (config.trigger.kind === "every-n") {
		if (!config.trigger.every || config.trigger.every <= 0) {
			throw new Error(`Gate ${config.id}: every-n trigger requires a positive every value`);
		}
	}
	return {
		...config,
		maxAttempts: config.maxAttempts ?? 1,
		priority: config.priority ?? 0,
	};
}

export function normalizeGateConfigs(configs: LoopGateConfig[]): LoopGateConfig[] {
	return configs.map(normalizeGateConfig);
}
