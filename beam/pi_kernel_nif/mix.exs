defmodule PiKernelNif.MixProject do
  use Mix.Project

  # P3.3b (PLAN-334): the BEAM-side Mix project hosting the rustler NIF skin over
  # pi-kernel. Proves gate 1 (NIF read == NAPI read) and is the substrate for
  # gate 2 (panic-safety) and gate 3 (lock-liveness). Standalone so the heavy
  # NIF link is isolated from the pi-natives integration-test binaries.

  def project do
    [
      app: :pi_kernel_nif,
      version: "0.1.0",
      elixir: "~> 1.15",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  def application do
    [extra_applications: [:logger]]
  end

  defp deps do
    [
      {:rustler, "~> 0.38.0"},
      {:jason, "~> 1.4"}
    ]
  end
end
