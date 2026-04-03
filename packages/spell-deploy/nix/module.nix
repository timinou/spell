{ config, lib, pkgs, ... }:

with lib;

let
  cfg = config.services.spell-server;
  enabledProjects = filterAttrs (_: project: project.enable) cfg.projects;
  hasDomains = any (project: project.domain != null) (attrValues enabledProjects);

  projectModule = { name, config, ... }: {
    options = {
      enable = mkEnableOption "Spell server project ${name}";

      projectRoot = mkOption {
        type = types.str;
        default = "/srv/spell/${name}";
        description = "Root directory for the project";
      };

      bundlePath = mkOption {
        type = types.str;
        default = "/srv/spell/.spell-bundle/spell";
        description = "Path to the compiled spell binary";
      };

      user = mkOption {
        type = types.str;
        default = "spell";
        description = "User to run the service as";
      };

      group = mkOption {
        type = types.str;
        default = "spell";
        description = "Group to run the service as";
      };

      port = mkOption {
        type = types.port;
        description = "HTTP port for the spell server";
      };

      domain = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Domain for Caddy reverse proxy (null = no proxy)";
      };

      environmentFile = mkOption {
        type = types.str;
        default = "${config.projectRoot}/.env";
        description = "Path to environment file";
      };

      backupSchedule = mkOption {
        type = types.str;
        default = "daily";
        description = "Systemd calendar expression for SQLite backups";
      };
    };
  };
in
{
  options.services.spell-server = {
    enable = mkEnableOption "Spell server deployment";

    projects = mkOption {
      type = types.attrsOf (types.submodule projectModule);
      default = {};
      description = "Spell server projects to deploy";
    };
  };

  config = mkIf cfg.enable {
    users.users.spell = {
      isSystemUser = true;
      group = "spell";
      home = "/srv/spell";
      createHome = true;
    };
    users.groups.spell = {};

    systemd.tmpfiles.rules = flatten (mapAttrsToList (_: project: [
      "d ${project.projectRoot} 0755 ${project.user} ${project.group} -"
      "d ${project.projectRoot}/data 0755 ${project.user} ${project.group} -"
      "d ${project.projectRoot}/artifacts 0755 ${project.user} ${project.group} -"
      "d ${project.projectRoot}/backups 0755 ${project.user} ${project.group} -"
    ]) enabledProjects);

    systemd.services = mkMerge [
      (mapAttrs' (name: project: nameValuePair "spell-${name}" {
        description = "Spell Server - ${name}";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        wantedBy = [ "multi-user.target" ];

        serviceConfig = {
          Type = "simple";
          User = project.user;
          Group = project.group;
          WorkingDirectory = project.projectRoot;
          ExecStart = "${project.bundlePath} server start";
          Restart = "on-failure";
          RestartSec = 5;
          EnvironmentFile = project.environmentFile;

          NoNewPrivileges = true;
          ProtectSystem = "strict";
          ProtectHome = true;
          PrivateTmp = true;
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectControlGroups = true;
          RestrictSUIDSGID = true;
          RestrictNamespaces = true;
          LockPersonality = true;
          MemoryDenyWriteExecute = false;
          ReadWritePaths = [ project.projectRoot ];
        };
      }) enabledProjects)
      (mapAttrs' (name: project: nameValuePair "spell-backup-${name}" {
        description = "SQLite backup for spell-${name}";
        serviceConfig = {
          Type = "oneshot";
          User = project.user;
          Group = project.group;
          ExecStart = pkgs.writeShellScript "spell-backup-${name}" ''
            cd ${project.projectRoot}
            mkdir -p backups
            for f in data/*.sqlite; do
              [ -f "$f" ] || continue
              ${pkgs.sqlite.out}/bin/sqlite3 "$f" ".backup backups/$(basename "$f" .sqlite)-$(date +%Y%m%d-%H%M%S).sqlite"
            done
          '';
        };
      }) enabledProjects)
    ];

    systemd.timers = mapAttrs' (name: project: nameValuePair "spell-backup-${name}" {
      description = "SQLite backup for spell-${name}";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = project.backupSchedule;
        Persistent = true;
      };
    }) enabledProjects;

    services.caddy.virtualHosts = mkMerge (mapAttrsToList (_: project:
      optionalAttrs (project.domain != null) {
        ${project.domain} = {
          extraConfig = ''
            reverse_proxy localhost:${toString project.port}
          '';
        };
      }
    ) enabledProjects);

    services.caddy.enable = hasDomains;
    networking.firewall.allowedTCPPorts = mkIf hasDomains [ 80 443 ];
  };
}
