import type { SystemdUnitConfig } from "./types";

function sanitizeUnitName(unitName: string): string {
	return unitName.replace(/[^A-Za-z0-9@_.-]+/g, "-");
}

/** Generate a hardened systemd service unit file */
export function generateSystemdUnit(config: SystemdUnitConfig): string {
	const unitName = sanitizeUnitName(config.unitName);
	return `[Unit]
Description=Spell Server - ${unitName}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${config.user}
Group=${config.group}
WorkingDirectory=${config.workingDirectory}
ExecStart=${config.execStart} server start
Restart=on-failure
RestartSec=5
EnvironmentFile=${config.environmentFile}

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=false
ReadWritePaths=${config.readWritePaths.join(" ")}

[Install]
WantedBy=multi-user.target
`;
}

/** Build config for a spell project's systemd unit */
export function buildUnitConfig(opts: {
	unitName: string;
	projectRoot: string;
	bundlePath: string;
	user: string;
}): SystemdUnitConfig {
	return {
		unitName: sanitizeUnitName(opts.unitName),
		execStart: opts.bundlePath,
		workingDirectory: opts.projectRoot,
		environmentFile: `${opts.projectRoot}/.env`,
		readWritePaths: [opts.projectRoot],
		user: opts.user,
		group: opts.user,
	};
}
