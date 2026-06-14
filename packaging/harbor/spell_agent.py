"""Harbor installed-agent adapter for Spell.

Runs Spell as a fully-autonomous Terminal-Bench agent. Spell is installed into
the task container and driven headlessly via the `harbor` domain (defined
declaratively in spell.autonomous.kdl): no human in the loop, interactive tools
gated off, model pinned to the harness-injected $HARBOR_MODEL.

Register with Harbor:

    harbor run -d terminal-bench/terminal-bench-2 \
      --agent-import-path packaging.harbor.spell_agent:SpellAgent \
      -m anthropic/claude-opus-4-x

Contract: harbor.agents.installed.base.BaseInstalledAgent
  - install(): stage the Spell binary + the autonomous domain spec
  - run():     drive `spell --domain harbor -p "<instruction>"`
  - populate_context_post_run(): harvest the transcript for scoring/telemetry
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Where Spell + its domain spec land inside the task container.
SPELL_PREFIX = "/opt/spell"
SPELL_BIN = f"{SPELL_PREFIX}/spell"
DOMAIN_SPEC_DIR = "/root/.spell"  # user spell.kdl dir; domain spec imported here
TRANSCRIPT_PATH = "/tmp/spell-harbor-transcript.jsonl"

# Auth forwarding: Spell stores logins (OAuth subscription tokens AND API keys)
# in agent.db under its agent dir. We upload the host db into the container and
# point Spell at it via PI_CODING_AGENT_DIR, so YOUR login survives the run
# without re-authenticating. Host path resolves ~/.spell/agent/agent.db (or the
# SPELL_AGENT_DB override).
CONTAINER_AGENT_DIR = f"{SPELL_PREFIX}/agent"
CONTAINER_AGENT_DB = f"{CONTAINER_AGENT_DIR}/agent.db"
_HOST_AGENT_DB = Path(
    os.environ.get("SPELL_AGENT_DB")
    or (Path.home() / ".spell" / "agent" / "agent.db")
)

# Host dir holding the built dist (binary + domain spec). Built by
# packaging/harbor/build-portable-native.sh. Override with SPELL_DIST_DIR.
_DIST_DIR = Path(os.environ.get("SPELL_DIST_DIR") or (Path(__file__).parent / "dist"))


class SpellAgent(BaseInstalledAgent):
    """Spell, driven autonomously inside a Harbor task container."""

    @staticmethod
    def name() -> str:
        return "spell"

    def version(self) -> str | None:
        return os.environ.get("SPELL_VERSION", "dev")

    async def install(self, environment: BaseEnvironment) -> None:
        """Stage Spell into the task container — fully self-contained.

        Uploads the host-built dist (binary + domain spec) and the host login
        (agent.db), wires a minimal user spell.kdl, then verifies the native
        addon LOADS in THIS container (fail-loud on a libc mismatch, before the
        benchmark starts rather than at first tool call).
        """
        spell_bin = _DIST_DIR / "spell"
        domain_spec = _DIST_DIR / "spell.autonomous.kdl"
        if not spell_bin.is_file() or not domain_spec.is_file():
            raise RuntimeError(
                f"Spell dist missing in {_DIST_DIR}. Build it first:\n"
                f"  packaging/harbor/build-portable-native.sh"
            )

        # 1. binary + domain spec
        await self.exec_as_root(
            environment, command=f"mkdir -p {shlex.quote(SPELL_PREFIX)} {shlex.quote(DOMAIN_SPEC_DIR)}"
        )
        await environment.upload_file(spell_bin, SPELL_BIN)
        await environment.upload_file(domain_spec, f"{DOMAIN_SPEC_DIR}/spell.autonomous.kdl")
        await self.exec_as_root(environment, command=f"chmod +x {shlex.quote(SPELL_BIN)}")
        # Minimal user spell.kdl that imports the domain spec so `--domain
        # harbor` resolves. heredoc avoids nested-quote escaping.
        kdl_path = f"{DOMAIN_SPEC_DIR}/spell.kdl"
        await self.exec_as_agent(
            environment,
            command=(
                f"cat > {shlex.quote(kdl_path)} <<'EOF'\n"
                'import "./spell.autonomous.kdl"\n'
                "EOF\n"
            ),
        )

        # 2. login: upload agent.db so Spell finds YOUR credentials (OAuth
        #    subscription + API keys). Best-effort — if you only use an env API
        #    key, skipping this is harmless.
        if _HOST_AGENT_DB.is_file():
            await self.exec_as_agent(
                environment, command=f"mkdir -p {shlex.quote(CONTAINER_AGENT_DIR)}"
            )
            await environment.upload_file(_HOST_AGENT_DB, CONTAINER_AGENT_DB)
            for suffix in ("-wal", "-shm"):
                sidecar = _HOST_AGENT_DB.with_name(_HOST_AGENT_DB.name + suffix)
                if sidecar.is_file():
                    await environment.upload_file(sidecar, CONTAINER_AGENT_DB + suffix)

        # 3. fail-loud load verification (the real portability gate).
        result = await self.exec_as_agent(
            environment, command=f"{shlex.quote(SPELL_BIN)} --version"
        )
        if getattr(result, "return_code", 1) != 0:
            raise RuntimeError(
                "Spell binary failed to load in this container — likely a libc "
                "mismatch. Rebuild for this image's libc:\n"
                "  glibc image (default): packaging/harbor/build-portable-native.sh\n"
                "  musl/Alpine image:     TARGET=musl packaging/harbor/build-portable-native.sh"
            )

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        """Drive Spell headlessly via the `harbor` domain.

        `-p` (print mode) runs one autonomous turn to completion and exits — no
        TUI, no human input. `--domain harbor` selects the declarative
        autonomous profile (surface "none" ⇒ headless route + interactive tools
        gated; model pinned to $HARBOR_MODEL via the domain's env contract).
        `--json` emits the event stream so the trajectory is recoverable even on
        a mid-run timeout.
        """
        model = self._resolve_model()
        # The harbor domain `env { require "HARBOR_MODEL" }` fails loud if this
        # is unset — surface it here too for a clearer Harbor-side error.
        if not model:
            raise RuntimeError(
                "SpellAgent: no model resolved. Pass `-m <provider/model>` to "
                "`harbor run` (forwarded as $HARBOR_MODEL)."
            )

        # PI_CODING_AGENT_DIR points Spell at the uploaded agent.db (login).
        cmd = (
            f"PI_CODING_AGENT_DIR={shlex.quote(CONTAINER_AGENT_DIR)} "
            f"HARBOR_MODEL={shlex.quote(model)} "
            f"{shlex.quote(SPELL_BIN)} "
            f"--domain harbor "
            f"--no-session "  # ephemeral: no cross-task context leakage
            f"-p --mode json "
            f"{shlex.quote(instruction)} "
            f"> {shlex.quote(TRANSCRIPT_PATH)} 2>&1"
        )
        await self.exec_as_agent(environment, command=cmd)

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Parse the JSONL transcript into the Harbor context (best-effort).

        Surfaces the final assistant text + token usage for cost telemetry. A
        missing/partial transcript (timeout) still yields whatever was written.
        """
        try:
            raw = Path(TRANSCRIPT_PATH).read_text(encoding="utf-8")
        except OSError:
            return

        last_text: str | None = None
        usage: dict[str, int] = {}
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "assistant" and isinstance(event.get("text"), str):
                last_text = event["text"]
            ev_usage = event.get("usage")
            if isinstance(ev_usage, dict):
                for k, v in ev_usage.items():
                    if isinstance(v, int):
                        usage[k] = usage.get(k, 0) + v

        if last_text is not None:
            context.set_output(last_text)
        if usage:
            # Cost telemetry: real per-task token counts, not an estimate.
            context.metadata.setdefault("usage", usage)

    def _resolve_model(self) -> str:
        """Harbor passes the model via config/env; normalize to one string.

        Honors an explicit `model` attr (Harbor sets it from `-m`) and falls
        back to the HARBOR_MODEL/SPELL_MODEL env vars.
        """
        model = getattr(self, "model", None)
        if isinstance(model, str) and model:
            return model
        return os.environ.get("HARBOR_MODEL") or os.environ.get("SPELL_MODEL") or ""
