export interface DeployContext {
	/** Resolved project root */
	projectRoot: string;
	/** Target name (from CLI arg or default) */
	targetName: string;
	/** Dry-run mode */
	dryRun: boolean;
}
