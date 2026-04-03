export interface BundleManifest {
	version: string;
	platform: string;
	hash: string;
	builtAt: string;
	binaryPath: string;
}

export interface BundleBuildOptions {
	/** Target platform, e.g. "linux-x64" */
	platform: string;
	/** Where to output the compiled binary */
	outputPath: string;
	/** Entry point to compile */
	entryPoint: string;
}
