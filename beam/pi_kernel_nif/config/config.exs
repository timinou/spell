import Config
# Force the rustler NIF to compile from source (it's a local path crate, no
# precompiled artifacts). `skip_compilation?` stays false so `mix compile`
# builds the .so.
config :pi_kernel_nif, PiKernelNif, skip_compilation?: false
