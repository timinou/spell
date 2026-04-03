import type { SshOptions } from "../sync/types";

export interface AgeEncryptOptions {
	/** Recipients (public keys or key file paths) */
	recipients: string[];
	/** Plaintext input */
	input: string;
}

export interface AgeDecryptOptions {
	/** Identity file path for decryption */
	identityFile: string;
	/** Path to .env.age file */
	encryptedFile: string;
}

export interface SecretPushOptions {
	/** Decrypted env content */
	envContent: string;
	/** Remote path to write .env */
	remotePath: string;
	sshOptions: SshOptions;
}
