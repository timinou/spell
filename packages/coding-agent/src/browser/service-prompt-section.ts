import { logger } from "@spell/pi-utils";
import { ServiceRegistry } from "./service-registry";

export async function buildServicePromptSection(registryPath?: string): Promise<string | null> {
	try {
		const registry = new ServiceRegistry(registryPath);
		const services = await registry.list();
		if (services.length === 0) return null;
		const names = services.map(s => s.name).join(", ");
		return `Connected browser services: ${names}. Use service:list for details.`;
	} catch (err) {
		logger.warn("Failed to read service registry for prompt injection", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
