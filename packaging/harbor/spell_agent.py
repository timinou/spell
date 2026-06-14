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

# The install script (staged next to this file) builds/copies a portable Spell
# binary and the autonomous domain spec into the container.
_INSTALL_SH = Path(__file__).parent / "install.sh"


class SpellAgent(BaseInstalledAgent):
    """Spell, driven autonomously inside a Harbor task container."""

    @staticmethod
    def name() -> str:
        return "spell"

    def version(self) -> str | None:
        return os.environ.get("SPELL_VERSION", "dev")

    @property
    def install_agent_script_path(self) -> Path:
        # BaseInstalledAgent runs this script in the container during install().
        return _INSTALL_SH

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

        cmd = (
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
