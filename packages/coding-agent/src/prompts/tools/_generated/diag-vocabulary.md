|variant|severity|template|
|---|---|---|
|ambiguous_target|error|`ambiguous target: {count} nodes matched; use a more specific path or add predicates`|
|artifact_not_found|error|`artifact not found: {uri}`|
|cancelled|info|`operation cancelled`|
|encoding_fallback|warning|`file is not valid UTF-8; using latin-1 lossy fallback`|
|file_exists|error|`file `{path}` already exists; use `force: true` to overwrite / `create` to recreate`|
|file_not_found|error|`file not found: {path}`|
|inaccessible|error|`cannot access `{path}`: {reason}`|
|incompatible_target_shape|error|`incompatible target shape for `{op_kind}`: {detail}`|
|missing_actions|error|`edit command requires `actions` parameter`|
|no_matches|warning|`zero matches for target `{target}``|
|parse_error|error|`parse failed at position {pos}`|
|range_bounds_inverted|error|`line range bounds inverted: start {start} > end {end}`|
|range_clamped|info|`range bounds clamped to file extent ({lines} lines)`|
|scheme_not_implemented|info|`scheme `{scheme}` is recognised but not yet implemented in this release`|
|stale_anchor|error|`anchor `{source}#{hash}` is stale — file has changed since read; re-read the file`|
|suffix_suggestion|warning|`no match for `{tried}` — did you mean `{suggestion}`?`|
|unknown_locator_scheme|error|`unknown locator scheme `{scheme}` — available: {available}`|
|unsupported_action_for_resolver|error|`no resolver supports action `{action}` for target `{target}``|
|unsupported_operation|error|`unsupported operation: {detail}`|
|zero_byte_delete_blocked|error|`refusing to delete symbol {symbol} — the file would become zero bytes; use a bare-path target to remove the file instead`|