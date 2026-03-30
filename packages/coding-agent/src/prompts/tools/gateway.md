Manages local gateway services — register backends with .localhost aliases, list active services, remove aliases.

Use to expose local development servers (port-based backends) via named HTTPS URLs. Registered services are accessible at `https://<alias>.localhost` and are automatically cleaned up when the session ends unless marked persistent.