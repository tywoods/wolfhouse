#!/usr/bin/env python3
"""Unit tests for Discord bot/webhook wake admission (stdlib only)."""

from __future__ import annotations

import os
import unittest
from types import SimpleNamespace

from wolfhouse.discord_bot_wake import (
    bot_wake_admit,
    bot_wake_config_from_env,
    json_job_match,
    message_channel_ids,
)


class _FakeAuthor:
    def __init__(self, *, display_name=None, name=None, global_name=None, bot=False):
        self.display_name = display_name
        self.name = name
        self.global_name = global_name
        self.bot = bot


class _FakeChannel:
    def __init__(self, channel_id, parent_id=None):
        self.id = channel_id
        self.parent_id = parent_id


class _FakeMessage:
    def __init__(
        self,
        *,
        content="",
        author=None,
        channel=None,
        webhook_id=None,
        embeds=None,
    ):
        self.content = content
        self.author = author
        self.channel = channel
        self.webhook_id = webhook_id
        self.embeds = embeds or []


THREAD_ID = "1537017482748100678"
PARENT_ID = "1111111111111111111"
AUTHOR = "Luna Chief of Staff"


class DiscordBotWakeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._env_keys = [
            "DISCORD_BOT_WAKE_CHANNELS",
            "DISCORD_BOT_WAKE_AUTHORS",
            "DISCORD_BOT_WAKE_JSON_SOURCE",
            "DISCORD_BOT_WAKE_JSON_TYPES",
            "DISCORD_BOT_WAKE_REQUIRE_JSON",
        ]
        self._prev = {k: os.environ.get(k) for k in self._env_keys}
        for k in self._env_keys:
            os.environ.pop(k, None)

    def tearDown(self) -> None:
        for k, v in self._prev.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _arm_chief_of_staff(self) -> None:
        os.environ["DISCORD_BOT_WAKE_CHANNELS"] = THREAD_ID
        os.environ["DISCORD_BOT_WAKE_AUTHORS"] = AUTHOR

    def _job_message(self, *, content: str, bot: bool = True, webhook: bool = True) -> _FakeMessage:
        return _FakeMessage(
            content=content,
            author=_FakeAuthor(display_name=AUTHOR, name="chief_of_staff", bot=bot),
            channel=_FakeChannel(int(THREAD_ID), parent_id=int(PARENT_ID)),
            webhook_id="999" if webhook else None,
        )

    def test_inactive_without_config(self):
        cfg = bot_wake_config_from_env()
        self.assertFalse(cfg["active"])
        msg = self._job_message(content='{"source":"grok-bot","type":"ping","id":"luna-ping-004"}')
        self.assertFalse(bot_wake_admit(msg))

    def test_admits_chief_of_staff_webhook_in_watched_thread(self):
        self._arm_chief_of_staff()
        msg = self._job_message(
            content='Job ready\n{"source":"grok-bot","type":"ping","id":"luna-ping-004"}'
        )
        self.assertTrue(bot_wake_admit(msg))

    def test_rejects_wrong_thread(self):
        self._arm_chief_of_staff()
        msg = self._job_message(content='{"source":"grok-bot","type":"ping","id":"x"}')
        msg.channel = _FakeChannel(2222222222222222222)
        self.assertFalse(bot_wake_admit(msg))

    def test_rejects_wrong_author(self):
        self._arm_chief_of_staff()
        msg = self._job_message(content='{"source":"grok-bot","type":"ping","id":"x"}')
        msg.author = _FakeAuthor(display_name="Some Other Bot", bot=True)
        self.assertFalse(bot_wake_admit(msg))

    def test_rejects_human_even_in_watched_thread(self):
        self._arm_chief_of_staff()
        msg = self._job_message(content="nudge", bot=False, webhook=False)
        msg.author = _FakeAuthor(display_name=AUTHOR, bot=False)
        self.assertFalse(bot_wake_admit(msg))

    def test_parent_channel_config_still_matches_thread_message(self):
        os.environ["DISCORD_BOT_WAKE_CHANNELS"] = PARENT_ID
        os.environ["DISCORD_BOT_WAKE_AUTHORS"] = AUTHOR
        msg = self._job_message(content='{"source":"grok-bot","type":"status","id":"x"}')
        self.assertEqual(message_channel_ids(msg), {THREAD_ID, PARENT_ID})
        self.assertTrue(bot_wake_admit(msg))

    def test_require_json_filters_non_jobs(self):
        self._arm_chief_of_staff()
        os.environ["DISCORD_BOT_WAKE_REQUIRE_JSON"] = "true"
        chatter = self._job_message(content="hello team")
        self.assertFalse(bot_wake_admit(chatter))
        job = self._job_message(
            content='{"source":"grok-bot","type":"approved_fix","id":"fix-1"}'
        )
        self.assertTrue(bot_wake_admit(job))

    def test_json_job_match_prefers_grok_types(self):
        self.assertTrue(
            json_job_match('preface\n{"source":"grok-bot","type":"ping","id":"1"}')
        )
        self.assertFalse(
            json_job_match('{"source":"other","type":"ping","id":"1"}')
        )
        self.assertFalse(
            json_job_match('{"source":"grok-bot","type":"noise","id":"1"}')
        )

    def test_webhook_without_bot_flag_still_bot_like(self):
        self._arm_chief_of_staff()
        msg = self._job_message(
            content='{"source":"grok-bot","type":"ping","id":"luna-ping-004"}',
            bot=False,
            webhook=True,
        )
        self.assertTrue(bot_wake_admit(msg))

    def test_embed_description_json_counts(self):
        self._arm_chief_of_staff()
        os.environ["DISCORD_BOT_WAKE_REQUIRE_JSON"] = "true"
        embed = SimpleNamespace(
            title="Chief of Staff",
            description='{"source":"grok-bot","type":"ping","id":"luna-ping-004"}',
            fields=[],
        )
        msg = self._job_message(content="New job")
        msg.embeds = [embed]
        self.assertTrue(bot_wake_admit(msg))


if __name__ == "__main__":
    unittest.main()
