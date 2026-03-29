export type ServiceCommandAction = "service:list" | "service:connect" | "service:disconnect";

export interface ServiceListCommand {
	action: "service:list";
	_rid?: string;
}

export interface ServiceConnectCommand {
	action: "service:connect";
	_rid?: string;
	name: string;
	displayName?: string;
	description?: string;
	domains?: string[];
	loginUrl?: string;
	parentService?: string;
}

export interface ServiceDisconnectCommand {
	action: "service:disconnect";
	_rid?: string;
	name: string;
}

export type ServiceCommand = ServiceListCommand | ServiceConnectCommand | ServiceDisconnectCommand;

export const serviceCommandActions: ServiceCommandAction[] = ["service:list", "service:connect", "service:disconnect"];

export function isServiceCommand(action: string): action is ServiceCommandAction {
	return serviceCommandActions.includes(action as ServiceCommandAction);
}
