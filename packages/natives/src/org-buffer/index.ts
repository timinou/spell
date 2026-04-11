import { native } from "../native";
import type { OrgBufferOptions, OrgBufferResult } from "./types";

export type { OrgBufferOptions, OrgBufferResult } from "./types";

export function executeOrg(options: OrgBufferOptions): OrgBufferResult {
	return native.executeOrg(options);
}
