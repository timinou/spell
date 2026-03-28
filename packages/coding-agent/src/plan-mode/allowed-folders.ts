export interface PlanModeAllowedFolder {
	path: string;
	description: string;
}

export function listPlanModeAllowedFolders(allowedFolders: Record<string, string>): PlanModeAllowedFolder[] {
	return Object.entries(allowedFolders).map(([path, description]) => ({ path, description }));
}
