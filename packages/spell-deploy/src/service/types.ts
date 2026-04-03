export interface SystemdUnitConfig {
	/** Service unit name, e.g. "spell-growth" */
	unitName: string;
	/** Path to spell binary on remote */
	execStart: string;
	/** Working directory on remote */
	workingDirectory: string;
	/** Path to .env file on remote */
	environmentFile: string;
	/** Directories the service can write to */
	readWritePaths: string[];
	/** User to run as */
	user: string;
	/** Group to run as */
	group: string;
}

export interface HealthCheckOptions {
	host: string;
	port: number;
	/** Basic auth credentials */
	auth: { username: string; password: string };
	/** Path to check, default "/api/goals" */
	path: string;
	/** Max retries */
	retries: number;
	/** Delay between retries in ms */
	retryDelay: number;
}

export type ServiceAction = "start" | "stop" | "restart" | "enable" | "disable" | "status";
