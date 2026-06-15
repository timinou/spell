"""Harbor installed-agent adapter for Spell.

Runs Spell as a fully-autonomous Terminal-Bench agent. Spell is installed into
the task container and driven headlessly via the `harbor` domain (defined
declaratively in spell.autonomous.kdl): no human in the loop, interactive tools
gated off, model pinned to the harness-injected $HARBOR_MODEL.

Register with Harbor:

    harbor run -d terminal-bench/terminal-bench-2 \
      --agent-import-path spell_harbor.spell_agent:SpellAgent \
      -m anthropic/claude-opus-4-x

Contract: harbor.agents.installed.base.BaseInstalledAgent
  - install(): stage the Spell binary + the autonomous domain spec
  - run():     drive `spell --domain harbor -p "<instruction>"`
  - populate_context_post_run(): harvest the transcript for scoring/telemetry
"""

from __future__ import annotations

import json
import os
import re
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Spell's config root in the container. Layout MUST mirror a real install
# (verified end-to-end in ubuntu:24.04):
#   /root/.spell/spell.kdl                    — user config (imports the domain spec)
#   /root/.spell/spell.autonomous.kdl         — the autonomous + harbor domains
#   /root/.spell/agent/agent.db               — login (PI_CODING_AGENT_DIR points here)
#   /root/.spell/natives/<version>/*.node     — native addon sidecar
# loadUserSpellKdl reads `dirname(PI_CODING_AGENT_DIR)/spell.kdl`, so the agent
# dir MUST be a child of the config root for the domain spec to resolve.
SPELL_PREFIX = "/opt/spell"
SPELL_BIN = f"{SPELL_PREFIX}/spell"
CONFIG_ROOT = "/root/.spell"
DOMAIN_SPEC_DIR = CONFIG_ROOT  # user spell.kdl + domain spec live here
NATIVES_DIR = f"{CONFIG_ROOT}/natives"  # + /<version>/*.node

# Harbor automatically collects files written under /logs/artifacts into the
# trial directory. Keep every critical debug signal there; /tmp is container-local
# and disappears before host-side postmortems can read it.
ARTIFACT_DIR = "/logs/artifacts"
TRANSCRIPT_PATH = f"{ARTIFACT_DIR}/spell-harbor-transcript.jsonl"
EXIT_CODE_PATH = f"{ARTIFACT_DIR}/spell-exit-code.txt"
RUN_METADATA_PATH = f"{ARTIFACT_DIR}/spell-run-metadata.json"
SMOKE_PATH = f"{ARTIFACT_DIR}/spell-smoke.txt"
APP_FILE_LIST_PATH = f"{ARTIFACT_DIR}/app-file-list.txt"
APP_ARTIFACT_DIR = f"{ARTIFACT_DIR}/app"
TRANSCRIPT_READ_LIMIT_BYTES = 4 * 1024 * 1024

# Auth forwarding: Spell stores logins (OAuth subscription tokens AND API keys)
# in agent.db under its agent dir. We upload the host db into the container and
# point Spell at it via PI_CODING_AGENT_DIR, so YOUR login survives the run
# without re-authenticating. Host path resolves ~/.spell/agent/agent.db (or the
# SPELL_AGENT_DB override).
CONTAINER_AGENT_DIR = f"{CONFIG_ROOT}/agent"
CONTAINER_AGENT_DB = f"{CONTAINER_AGENT_DIR}/agent.db"
_HOST_AGENT_DB = Path(
    os.environ.get("SPELL_AGENT_DB")
    or (Path.home() / ".spell" / "agent" / "agent.db")
)
_HOST_MODELS_DB = Path(
    os.environ.get("SPELL_MODELS_DB")
    or (Path.home() / ".spell" / "agent" / "models.db")
)
_HOST_MODELS_YML_CANDIDATES = [
    Path(os.environ["SPELL_MODELS_YML"]) if os.environ.get("SPELL_MODELS_YML") else None,
    Path.home() / ".spell" / "models.yml",
    Path.home() / ".spell" / "agent" / "models.yml",
    Path.home() / ".config" / "spell" / "models.yml",
]

_PROVIDER_ENV_NAMES = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
    "ZAI_API_KEY",
    "GLM_API_KEY",
    "CEREBRAS_API_KEY",
    "PERPLEXITY_API_KEY",
    "TOGETHER_API_KEY",
    "FIREWORKS_API_KEY",
    "VOYAGE_API_KEY",
)

# Host dir holding the built dist (binary + domain spec). Built by
# spell_harbor/build-portable-native.sh. Override with SPELL_DIST_DIR.
_DIST_DIR = Path(os.environ.get("SPELL_DIST_DIR") or (Path(__file__).parent / "dist"))


def _merge_metadata(context: AgentContext, values: dict[str, object]) -> None:
    metadata = getattr(context, "metadata", None)
    if not isinstance(metadata, dict):
        context.metadata = {}
    context.metadata.update(values)


def _parse_transcript(raw: str) -> tuple[str | None, dict[str, int]]:
    """Extract final assistant text + additive usage from Spell JSONL.

    The transcript intentionally captures stderr too, so tolerate non-JSON lines.
    """
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
            for key, value in ev_usage.items():
                if isinstance(value, int):
                    usage[key] = usage.get(key, 0) + value
    return last_text, usage


def _provider_env_exports() -> str:
    lines = []
    for name in _PROVIDER_ENV_NAMES:
        value = os.environ.get(name)
        if value:
            lines.append(f"export {name}={shlex.quote(value)}")
    return "\n".join(lines)


def _required_absolute_paths(instruction: str) -> list[str]:
    """Best-effort deliverable-path extraction from benchmark instructions."""
    lowered = instruction.lower()
    if not any(word in lowered for word in ("create", "write", "script", "file", "implement")):
        return []
    paths = re.findall(r"(?<![\w.-])(/app/[A-Za-z0-9_./+-]+)", instruction)
    # Trim common punctuation stuck to prose while preserving paths with dots.
    normalized = [path.rstrip(".,:;)\"'") for path in paths]
    return sorted(set(path for path in normalized if path.startswith("/app/") and path != "/app/"))


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
                f"  spell_harbor/build-portable-native.sh"
            )

        # 1. binary + domain spec
        await self.exec_as_root(
            environment, command=f"mkdir -p {shlex.quote(SPELL_PREFIX)} {shlex.quote(DOMAIN_SPEC_DIR)}"
        )
        await environment.upload_file(spell_bin, SPELL_BIN)
        await environment.upload_file(domain_spec, f"{DOMAIN_SPEC_DIR}/spell.autonomous.kdl")
        await self.exec_as_root(environment, command=f"chmod +x {shlex.quote(SPELL_BIN)}")

        # 1b. native addon SIDECAR. bun --compile does not embed .node as an
        #     fs-readable blob, so at runtime Spell loads it from
        #     ~/.spell/natives/<version>/. Upload it there. Without this, the
        #     binary runs but every native tool (find/edit/execute/org) fails to
        #     load and tries to download the addon from GitHub.
        node_files = list(_DIST_DIR.glob("pi_natives*.node"))
        version_file = _DIST_DIR / ".natives-version"
        if node_files and version_file.is_file():
            version = version_file.read_text().strip()
            natives_dir = f"{NATIVES_DIR}/{version}"
            await self.exec_as_agent(
                environment, command=f"mkdir -p {shlex.quote(natives_dir)}"
            )
            for node in node_files:
                await environment.upload_file(node, f"{natives_dir}/{node.name}")
        else:
            raise RuntimeError(
                f"Native addon sidecar missing in {_DIST_DIR} (need pi_natives*.node "
                f"+ .natives-version). Rebuild: spell_harbor/build-portable-native.sh"
            )
        # 1c. Container DNS hardening. Docker copies the host's /etc/resolv.conf
        #     into the task container but strips 127.0.0.0/8 nameservers (they
        #     are host-loopback, unreachable from inside the container). On hosts
        #     whose only fast resolver is 127.0.0.1 — a local DNS, a VPN gateway,
        #     or a relay like better-ccflare — the container is left with just the
        #     remaining (often remote / flaky) nameserver and NO fallback. When
        #     that resolver stalls, bun's getaddrinfo hangs for many minutes,
        #     every model call fails with "Unable to connect", the 3x auto-retry
        #     burns the whole agent budget, and the trial times out. Pin reliable
        #     public resolvers so name resolution is deterministic. Set
        #     SPELL_CONTAINER_DNS="a b" for custom resolvers, or "skip" to opt out.
        dns_env = os.environ.get("SPELL_CONTAINER_DNS", "1.1.1.1 8.8.8.8")
        if dns_env.strip().lower() not in ("skip", "off", "none", "host", ""):
            dns_content = "".join(f"nameserver {s}\n" for s in dns_env.split())
            await self.exec_as_root(
                environment,
                command=f"printf %s {shlex.quote(dns_content)} > /etc/resolv.conf",
            )

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
        await self.exec_as_agent(
            environment, command=f"mkdir -p {shlex.quote(CONTAINER_AGENT_DIR)}"
        )
        if _HOST_AGENT_DB.is_file():
            await environment.upload_file(_HOST_AGENT_DB, CONTAINER_AGENT_DB)
            for suffix in ("-wal", "-shm"):
                sidecar = _HOST_AGENT_DB.with_name(_HOST_AGENT_DB.name + suffix)
                if sidecar.is_file():
                    await environment.upload_file(sidecar, CONTAINER_AGENT_DB + suffix)

        # Dynamic/OAuth provider model discovery is cached separately from auth.
        # Ship it too so Harbor sees the same model list as normal Spell (e.g.
        # openai-codex/gpt-5.5) without needing an online discovery round trip.
        if _HOST_MODELS_DB.is_file():
            container_models_db = f"{CONTAINER_AGENT_DIR}/models.db"
            await environment.upload_file(_HOST_MODELS_DB, container_models_db)
            for suffix in ("-wal", "-shm"):
                sidecar = _HOST_MODELS_DB.with_name(_HOST_MODELS_DB.name + suffix)
                if sidecar.is_file():
                    await environment.upload_file(sidecar, container_models_db + suffix)

        # User model/provider config can live in either ~/.spell/models.yml or
        # the legacy agent dir. Upload first available config to the paths Spell
        # may consult inside this container.
        for candidate in _HOST_MODELS_YML_CANDIDATES:
            if candidate and candidate.is_file():
                await environment.upload_file(candidate, f"{CONFIG_ROOT}/models.yml")
                await environment.upload_file(candidate, f"{CONTAINER_AGENT_DIR}/models.yml")
                break

        # 3. fail-loud load verification (the real portability gate).
        result = await self.exec_as_agent(
            environment, command=f"{shlex.quote(SPELL_BIN)} --version"
        )
        if getattr(result, "return_code", 1) != 0:
            raise RuntimeError(
                "Spell binary failed to load in this container — likely a libc "
                "mismatch. Rebuild for this image's libc:\n"
                "  glibc image (default): spell_harbor/build-portable-native.sh\n"
                "  musl/Alpine image:     TARGET=musl spell_harbor/build-portable-native.sh"
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

        _merge_metadata(context, {"model": model, "artifact_dir": ARTIFACT_DIR})
        await self._prepare_artifact_dir(environment, model)

        # PI_CODING_AGENT_DIR points Spell at the uploaded agent.db (login).
        spell_cmd = (
            f"PI_CODING_AGENT_DIR={shlex.quote(CONTAINER_AGENT_DIR)} "
            f"HARBOR_MODEL={shlex.quote(model)} "
            f"{shlex.quote(SPELL_BIN)} "
            f"--domain harbor "
            f"--model {shlex.quote(model)} "
            f"--no-session "  # ephemeral: no cross-task context leakage
            f"-p --mode json "
            f"{shlex.quote(instruction)}"
        )
        provider_env_exports = _provider_env_exports()
        run_script = (
            "set -u\n"
            f"{provider_env_exports}\n"
            f"mkdir -p {shlex.quote(ARTIFACT_DIR)}\n"
            f": > {shlex.quote(TRANSCRIPT_PATH)}\n"
            f"printf '%s\\n' {shlex.quote(spell_cmd)} > {shlex.quote(ARTIFACT_DIR + '/spell-command.txt')}\n"
            f"{spell_cmd} > {shlex.quote(TRANSCRIPT_PATH)} 2>&1\n"
            "code=$?\n"
            f"printf '%s\\n' \"$code\" > {shlex.quote(EXIT_CODE_PATH)}\n"
            "exit 0\n"
        )
        # Harbor raises NonZeroAgentExitCodeError before returning control to the
        # adapter. Always return 0 from the wrapper, then classify Spell's real
        # exit code ourselves so transcript parsing, metadata, and solution
        # capture still happen for startup/model failures.
        await self.exec_as_agent(environment, command=f"sh -lc {shlex.quote(run_script)}")
        return_code = await self._read_exit_code(environment)
        _merge_metadata(context, {"spell_exit_code": return_code})

        raw = await self._read_transcript(environment)
        if raw:
            self._populate_context_from_raw(context, raw)
        else:
            _merge_metadata(context, {"transcript_missing": True})

        required_paths = _required_absolute_paths(instruction)
        await self._capture_solution_state(environment, required_paths)

        if return_code != 0:
            tail = await self._tail_transcript(environment)
            await self._write_run_metadata(environment, model, return_code, required_paths, failed=True)
            raise RuntimeError(
                f"Spell exited non-zero ({return_code}) before completing the Harbor task.\n"
                f"Transcript: {TRANSCRIPT_PATH}\n"
                f"Last transcript lines:\n{tail}"
            )

        missing_paths = await self._check_required_paths(environment, required_paths)
        smoke = await self._run_smoke_gates(environment, required_paths)
        await self._write_run_metadata(
            environment,
            model,
            return_code,
            required_paths,
            missing_paths=missing_paths,
            smoke=smoke,
        )
        if missing_paths:
            raise RuntimeError(
                "Spell finished without creating required deliverable path(s): "
                + ", ".join(missing_paths)
            )

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Parse the JSONL transcript into the Harbor context (best-effort).

        Primary parsing now happens while the container is still available in
        `run()`. This host-side hook remains as a fallback for Docker's mounted
        `/logs/artifacts` layout or local/manual invocations.
        """
        for path in (Path(TRANSCRIPT_PATH), Path("/tmp/spell-harbor-transcript.jsonl")):
            try:
                raw = path.read_text(encoding="utf-8")
            except OSError:
                continue
            self._populate_context_from_raw(context, raw)
            return

    def _populate_context_from_raw(self, context: AgentContext, raw: str) -> None:
        last_text, usage = _parse_transcript(raw)
        if last_text is not None:
            context.set_output(last_text)
        if usage:
            context.metadata.setdefault("usage", usage)

    async def _prepare_artifact_dir(self, environment: BaseEnvironment, model: str) -> None:
        metadata = {"model": model, "spell_bin": SPELL_BIN, "transcript": TRANSCRIPT_PATH}
        script = (
            f"mkdir -p {shlex.quote(ARTIFACT_DIR)} {shlex.quote(APP_ARTIFACT_DIR)}\n"
            f"cat > {shlex.quote(RUN_METADATA_PATH)} <<'EOF'\n"
            f"{json.dumps(metadata, sort_keys=True)}\n"
            "EOF\n"
        )
        await self.exec_as_agent(environment, command=f"sh -lc {shlex.quote(script)}")

    async def _read_exit_code(self, environment: BaseEnvironment) -> int:
        result = await self.exec_as_agent(
            environment,
            command=f"cat {shlex.quote(EXIT_CODE_PATH)} 2>/dev/null || printf '1\\n'",
        )
        raw = str(getattr(result, "stdout", "") or getattr(result, "output", "") or "1").strip()
        try:
            return int(raw.splitlines()[-1] if raw else "1")
        except ValueError:
            return 1

    async def _read_transcript(self, environment: BaseEnvironment) -> str:
        script = (
            f"if [ -f {shlex.quote(TRANSCRIPT_PATH)} ]; then "
            f"python - <<'PY'\n"
            "from pathlib import Path\n"
            f"p = Path({TRANSCRIPT_PATH!r})\n"
            f"limit = {TRANSCRIPT_READ_LIMIT_BYTES}\n"
            "data = p.read_bytes()[-limit:]\n"
            "print(data.decode('utf-8', 'replace'), end='')\n"
            "PY\n"
            "fi"
        )
        result = await self.exec_as_agent(environment, command=f"sh -lc {shlex.quote(script)}")
        return str(getattr(result, "stdout", "") or getattr(result, "output", "") or "")

    async def _tail_transcript(self, environment: BaseEnvironment) -> str:
        result = await self.exec_as_agent(
            environment,
            command=f"tail -200 {shlex.quote(TRANSCRIPT_PATH)} 2>/dev/null || true",
        )
        return str(getattr(result, "stdout", "") or getattr(result, "output", "") or "")

    async def _capture_solution_state(self, environment: BaseEnvironment, required_paths: list[str]) -> None:
        copy_paths = sorted(set(required_paths + (["/app/filter.py"] if "/app/filter.py" in required_paths else [])))
        script = f"""
import os
import shutil
from pathlib import Path
artifact_dir = Path({ARTIFACT_DIR!r})
app_artifact_dir = Path({APP_ARTIFACT_DIR!r})
artifact_dir.mkdir(parents=True, exist_ok=True)
app_artifact_dir.mkdir(parents=True, exist_ok=True)
with Path({APP_FILE_LIST_PATH!r}).open("w", encoding="utf-8") as out:
    root = Path("/app")
    if root.exists():
        for dirpath, _dirnames, filenames in os.walk(root):
            for filename in sorted(filenames):
                path = Path(dirpath) / filename
                try:
                    stat = path.stat()
                    out.write(f"{{path}}\\t{{stat.st_size}}\\n")
                except OSError as exc:
                    out.write(f"{{path}}\\tERROR {{exc}}\\n")
    else:
        out.write("/app\\tMISSING\\n")
for raw in {copy_paths!r}:
    src = Path(raw)
    if not src.is_file():
        continue
    rel = src.relative_to("/")
    dst = artifact_dir / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
"""
        await self.exec_as_agent(
            environment,
            command=f"python - <<'PY'\n{script}\nPY",
        )

    async def _check_required_paths(self, environment: BaseEnvironment, required_paths: list[str]) -> list[str]:
        if not required_paths:
            return []
        script = "\n".join(
            [
                "import json",
                "from pathlib import Path",
                f"paths = {required_paths!r}",
                "print(json.dumps([p for p in paths if not Path(p).exists()]))",
            ]
        )
        result = await self.exec_as_agent(environment, command=f"python - <<'PY'\n{script}\nPY")
        raw = str(getattr(result, "stdout", "") or getattr(result, "output", "") or "[]").strip()
        try:
            parsed = json.loads(raw.splitlines()[-1] if raw else "[]")
        except json.JSONDecodeError:
            return required_paths
        return [str(path) for path in parsed if isinstance(path, str)]

    async def _run_smoke_gates(self, environment: BaseEnvironment, required_paths: list[str]) -> dict[str, object]:
        smoke: dict[str, object] = {"ran": False}
        if "/app/filter.py" not in required_paths:
            return smoke
        script = f"""
from pathlib import Path
import subprocess
sample = Path('/tmp/spell-smoke.html')
sample.write_text('<!doctype html><html><body><script>alert(1)</script><p>ok</p></body></html>', encoding='utf-8')
result = subprocess.run(['python', '/app/filter.py', str(sample)], text=True, capture_output=True, timeout=30)
content = sample.read_text(encoding='utf-8', errors='replace') if sample.exists() else ''
ok = result.returncode == 0 and '<script' not in content.lower() and 'ok' in content
report = [
    f'returncode={{result.returncode}}',
    f'ok={{ok}}',
    '--- stdout ---',
    result.stdout[-4000:],
    '--- stderr ---',
    result.stderr[-4000:],
    '--- output ---',
    content[-4000:],
]
Path({SMOKE_PATH!r}).write_text('\\n'.join(report), encoding='utf-8')
raise SystemExit(0 if ok else 7)
"""
        result = await self.exec_as_agent(environment, command=f"python - <<'PY'\n{script}\nPY")
        code = getattr(result, "return_code", 1)
        smoke.update({"ran": True, "return_code": code, "ok": code == 0, "path": SMOKE_PATH})
        return smoke

    async def _write_run_metadata(
        self,
        environment: BaseEnvironment,
        model: str,
        return_code: int,
        required_paths: list[str],
        *,
        failed: bool = False,
        missing_paths: list[str] | None = None,
        smoke: dict[str, object] | None = None,
    ) -> None:
        metadata = {
            "model": model,
            "return_code": return_code,
            "transcript": TRANSCRIPT_PATH,
            "required_paths": required_paths,
            "missing_paths": missing_paths or [],
            "smoke": smoke or {},
            "failed": failed,
        }
        script = (
            f"cat > {shlex.quote(RUN_METADATA_PATH)} <<'EOF'\n"
            f"{json.dumps(metadata, sort_keys=True)}\n"
            "EOF\n"
        )
        await self.exec_as_agent(environment, command=f"sh -lc {shlex.quote(script)}")

    def _resolve_model(self) -> str:
        """Harbor passes the model via config/env; normalize to one string.

        Harbor constructs the agent with `model_name=` (from `-m/--model`; see
        BaseAgent.__init__), so that attribute is the primary source. Fall back
        to an explicit `model` attr and then the HARBOR_MODEL/SPELL_MODEL env
        vars for manual/headless invocation.
        """
        for attr in ("model_name", "model"):
            value = getattr(self, attr, None)
            if isinstance(value, str) and value:
                return value
        return os.environ.get("HARBOR_MODEL") or os.environ.get("SPELL_MODEL") or ""
