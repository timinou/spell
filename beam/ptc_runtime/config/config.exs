import Config

# Logger config is applied imperatively at boot by PtcRuntime.Logger.install/0
# (it must run before any stderr write). We still set a conservative default
# level here so compile-time purging behaves.
config :logger, level: :info

import_config "#{config_env()}.exs"
