export interface PlanModeState {
	enabled: boolean;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
	reentry?: boolean;
	/** CUSTOM_ID of the org draft item created at plan mode entry (e.g. DRAFT-003-auth-migration). */
	orgItemId?: string;
	/** Absolute path to the .org file containing the draft item. */
	orgItemFile?: string;
}
