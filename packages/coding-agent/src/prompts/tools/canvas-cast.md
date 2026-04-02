Publish, update, unpublish, or inspect Spellcast manifests.

Use this when a project contains `*.spellcast.manifest.yaml` files and you need to sync the declared app files to the Spellcasting server.

Actions:
- `publish`: upload a manifest and its declared files, returning the public URL
- `update`: upload a new tarball for an already-published manifest
- `unpublish`: remove a published manifest from the server and clear local state
- `status`: list discovered spellcasts and whether they are published or draft

Requirements:
- The user must already be authenticated with `/login spellcasting`
- `manifest` is required for `publish`, `update`, and `unpublish`
- Manifest file paths are resolved relative to the current working directory