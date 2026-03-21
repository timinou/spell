export interface PlanModeState {
	enabled: boolean;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
	reentry?: boolean;
	/** When true, ultraplan mode is active (runs Metis gap analysis and optional Momus review). */
	ultraplan?: boolean;
	/** When set to "design", activates the UI/UX design planning workflow with Aphrodite/Athena gates. */
	flavor?: "design";
}
