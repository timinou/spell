from __future__ import annotations

import json
import unittest

from spell_harbor.transcript import parse_transcript, parse_transcript_failure


def line(event: dict) -> str:
    return json.dumps(event)


class TranscriptParsingTest(unittest.TestCase):
    def test_parse_transcript_extracts_message_end_text_and_usage(self) -> None:
        raw = "\n".join(
            [
                "plain stderr line",
                line(
                    {
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "done"}],
                            "usage": {"input": 3, "output": 2, "ignored": 1.5},
                        },
                    }
                ),
            ]
        )

        text, usage = parse_transcript(raw)

        self.assertEqual(text, "done")
        self.assertEqual(usage, {"input": 3, "output": 2})

    def test_parse_transcript_failure_prefers_retry_final_error_with_model_context(self) -> None:
        raw = "\n".join(
            [
                line(
                    {
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "provider": "openai-codex",
                            "model": "gpt-5.5",
                            "stopReason": "error",
                            "errorMessage": "Unable to connect",
                            "content": [],
                        },
                    }
                ),
                line(
                    {
                        "type": "auto_retry_end",
                        "success": False,
                        "finalError": "Final attempt 3/3 failed. Unable to connect.",
                    }
                ),
            ]
        )

        failure = parse_transcript_failure(raw)

        self.assertIsNotNone(failure)
        assert failure is not None
        self.assertEqual(failure.kind, "auto_retry")
        self.assertEqual(failure.message, "Final attempt 3/3 failed. Unable to connect.")
        self.assertEqual(failure.provider, "openai-codex")
        self.assertEqual(failure.model, "gpt-5.5")
        self.assertIn("openai-codex/gpt-5.5", failure.format())

    def test_parse_transcript_failure_ignores_successful_messages(self) -> None:
        raw = line(
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "stopReason": "stop",
                    "content": [{"type": "text", "text": "ok"}],
                },
            }
        )

        self.assertIsNone(parse_transcript_failure(raw))


if __name__ == "__main__":
    unittest.main()
