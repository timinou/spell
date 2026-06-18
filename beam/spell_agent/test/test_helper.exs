# Live tests (tagged :live) hit the real Anthropic subscription + network and are
# excluded by default. Run them with `mix test --include live`.
ExUnit.start(exclude: [:live])
