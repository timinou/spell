/** Service type on the remote host */
export interface ServiceConfig {
	type: "systemd";
	unit: string;
}

/** A named deployment target */
export interface SyncTarget {
	name: string;
	host: string;
	user: string;
	port: number;
	sshKey?: string;
	projectRoot: string;
	service?: ServiceConfig;
	secrets?: string;
	include: string[];
	exclude: string[];
}

/** Sync behavior settings */
export interface SyncSettings {
	pushDebounce: string;
	pull: string[];
	pullInterval: string;
	sqliteBackup: boolean;
}

/** Bundle configuration */
export interface BundleConfig {
	platform: string;
	cacheDir: string;
}

/** Root sync configuration */
export interface SyncConfig {
	defaultTarget: string;
	targets: Map<string, SyncTarget>;
	sync: SyncSettings;
	bundle: BundleConfig;
}
