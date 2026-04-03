# Example NixOS configuration for Hetzner spell-server deployment
# Save as /etc/nixos/spell-server.nix and import from configuration.nix
{ config, pkgs, ... }:
{
  imports = [ ./module.nix ];

  services.spell-server = {
    enable = true;
    projects = {
      growth = {
        enable = true;
        port = 8787;
        domain = "growth.spell.example.com";
        backupSchedule = "*-*-* 03:00:00";
      };
      analytics = {
        enable = true;
        port = 8788;
        domain = "analytics.spell.example.com";
        backupSchedule = "*-*-* 03:30:00";
      };
    };
  };
}
