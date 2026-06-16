from __future__ import annotations

import json
import unittest

try:
    from harbor.models.agent.context import AgentContext

    from spell_harbor.spell_agent import SpellAgent
except ModuleNotFoundError as exc:  # pragma: no cover - depends on Harbor being installed
    AgentContext = None  # type: ignore[assignment]
    SpellAgent = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


def line(event: dict) -> str:
    return json.dumps(event)


@unittest.skipIf(_IMPORT_ERROR is not None, f"Harbor unavailable: {_IMPORT_ERROR}")
class SpellAgentContextTest(unittest.TestCase):
    def test_populate_context_stores_output_in_metadata_for_current_harbor(self) -> None:
        assert AgentContext is not None
        assert SpellAgent is not None
        context = AgentContext()
        raw = line(
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "done"}],
                    "usage": {"input": 3, "output": 2},
                },
            }
        )

        SpellAgent._populate_context_from_raw(SpellAgent.__new__(SpellAgent), context, raw)

        self.assertEqual(context.metadata["output"], "done")
        self.assertEqual(context.metadata["usage"], {"input": 3, "output": 2})


if __name__ == "__main__":
    unittest.main()
