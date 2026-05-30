import { isEnoent } from "@spell/pi-utils";

/**
 * The native org parser currently surfaces missing files through NAPI as a
 * GenericFailure instead of a normal ENOENT fs error.
 */
export function isMissingOrgFileError(err: unknown): boolean {
	return (
		isEnoent(err) ||
		(err instanceof Error && err.message.includes("No such file or directory") && err.message.includes("os error 2"))
	);
}
