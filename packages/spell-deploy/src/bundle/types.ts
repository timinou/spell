import type { SshOptions } from "../sync/types";

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

export interface BundleUploadOptions {
	localBinaryPath: string;
	remoteBundleDir: string;
	sshOptions: SshOptions;
}
