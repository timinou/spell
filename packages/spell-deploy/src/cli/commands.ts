import * as path from "node:path";
import { loadSyncConfig } from "../config/loader";
import type { SyncConfig, SyncTarget } from "../config/types";
import { decryptAge } from "../secrets/age";
import { executeSecretPush } from "../secrets/push";
import { buildInstallUnitCommand, buildServiceCommand, serviceAction } from "../service/lifecycle";
import { buildUnitConfig, generateSystemdUnit } from "../service/systemd";
import { executePull } from "../sync/pull";
import { executePush } from "../sync/push";
import { buildSshCommand, execSsh, sshOptionsFromTarget } from "../sync/ssh";
import { buildQuotedPath } from "../sync/utils";
import { WatchOrchestrator } from "../sync/watch";
import type { DeployContext } from "./types";

export async function resolveContext(opts: {
	projectRoot?: string;
	targetName?: string;
	dryRun: boolean;
}): Promise<{ context: DeployContext; config: SyncConfig; target: SyncTarget }> {
	const projectRoot = opts.projectRoot ?? process.cwd();
	const config = await loadSyncConfig(projectRoot);
	const targetName = opts.targetName ?? config.defaultTarget;
	const target = config.targets.get(targetName);
	if (!target) {
		const available = [...config.targets.keys()].join(", ");
		throw new Error(`Unknown target "${targetName}". Available: ${available}`);
	}
	return {
		context: { projectRoot, targetName, dryRun: opts.dryRun },
		config,
		target,
	};
}

export async function pushCommand(ctx: DeployContext, _config: SyncConfig, target: SyncTarget): Promise<void> {
	const sshOpts = sshOptionsFromTarget(target);

	if (target.service) {
		if (ctx.dryRun) {
			const cmd = buildServiceCommand(sshOpts, target.service.unit, "stop");
			console.error(`[dry-run] ${cmd.description}`);
		} else {
			await serviceAction(sshOpts, target.service.unit, "stop");
		}
	}

	await executePush({
		target,
		localRoot: ctx.projectRoot,
		dryRun: ctx.dryRun,
	});

	if (target.service) {
		if (ctx.dryRun) {
			const cmd = buildServiceCommand(sshOpts, target.service.unit, "start");
			console.error(`[dry-run] ${cmd.description}`);
		} else {
			await serviceAction(sshOpts, target.service.unit, "start");
		}
	}
}

export async function pullCommand(ctx: DeployContext, config: SyncConfig, target: SyncTarget): Promise<void> {
	await executePull({
		target,
		sync: config.sync,
		localRoot: ctx.projectRoot,
		dryRun: ctx.dryRun,
	});
}

export async function statusCommand(
	_ctx: DeployContext,
	_config: SyncConfig,
	target: SyncTarget,
): Promise<{
	serviceRunning: boolean;
	healthOk: boolean;
	error?: string;
}> {
	const sshOpts = sshOptionsFromTarget(target);
	let serviceRunning = false;

	if (target.service) {
		try {
			await serviceAction(sshOpts, target.service.unit, "status");
			serviceRunning = true;
		} catch {
			serviceRunning = false;
		}
	}

	return { serviceRunning, healthOk: serviceRunning };
}

export async function secretsCommand(ctx: DeployContext, _config: SyncConfig, target: SyncTarget): Promise<void> {
	if (!target.secrets) {
		throw new Error(`No secrets configured for target "${ctx.targetName}"`);
	}
	const sshOpts = sshOptionsFromTarget(target);
	const identityFile = sshOpts.sshKey ?? "~/.ssh/id_ed25519";
	const encryptedPath = path.resolve(ctx.projectRoot, target.secrets);

	const envContent = await decryptAge({
		identityFile,
		encryptedFile: encryptedPath,
	});

	if (ctx.dryRun) {
		console.error(`[dry-run] Would push decrypted secrets to ${target.projectRoot}/.env`);
		return;
	}

	await executeSecretPush({
		envContent,
		remotePath: `${target.projectRoot}/.env`,
		sshOptions: sshOpts,
	});
}

export function watchCommand(ctx: DeployContext, config: SyncConfig, target: SyncTarget): WatchOrchestrator {
	return new WatchOrchestrator({
		target,
		sync: config.sync,
		localRoot: ctx.projectRoot,
		onSync: event => {
			console.error(`[watch] ${event.type} at ${new Date(event.timestamp).toISOString()}`);
		},
		onError: error => {
			console.error(`[watch] error: ${error.message}`);
		},
	});
}

export async function initCommand(ctx: DeployContext, _config: SyncConfig, target: SyncTarget): Promise<void> {
	const sshOpts = sshOptionsFromTarget(target);
	const qRoot = buildQuotedPath(target.projectRoot);
	const mkdirCmd = buildSshCommand(sshOpts, `mkdir -p ${qRoot} ${qRoot}/data ${qRoot}/artifacts ${qRoot}/backups`);
	if (ctx.dryRun) {
		console.error(`[dry-run] ${mkdirCmd.description}`);
		return;
	}
	await execSsh(mkdirCmd);

	if (!target.service) {
		return;
	}

	const bundlePath = "/srv/spell/.spell-bundle/spell";
	const unitConfig = buildUnitConfig({
		unitName: target.service.unit,
		projectRoot: target.projectRoot,
		bundlePath,
		user: target.user,
	});
	const unitContent = generateSystemdUnit(unitConfig);
	const installCmd = buildInstallUnitCommand(sshOpts, unitContent, target.service.unit);
	const proc = Bun.spawn(installCmd.args, {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(installCmd.stdin);
	proc.stdin.end();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`${installCmd.description} failed: ${stderr}`);
	}
}

export async function bootstrapCommand(ctx: DeployContext, config: SyncConfig, target: SyncTarget): Promise<void> {
	await initCommand(ctx, config, target);
	if (target.secrets) {
		await secretsCommand(ctx, config, target);
	}
	await pushCommand(ctx, config, target);
}
