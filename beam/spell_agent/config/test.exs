import Config

# Khepri/Ra emit verbose :debug/:info logs while booting the Ra system and during
# elections. They flood test output and obscure failures. Raise the floor to
# :warning for the durable-history test runs; raise to :error if even that is noisy.
config :logger, level: :warning
