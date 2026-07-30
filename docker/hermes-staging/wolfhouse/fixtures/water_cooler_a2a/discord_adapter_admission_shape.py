# Captured live-adapter admission shape for Water-cooler A2A patcher tests.
# Anchors match /opt/hermes/plugins/platforms/discord/adapter.py (Hermes pin).
# This is a synthetic minimal module — not a full adapter.

from __future__ import annotations

class DiscordMessage:
    pass


class MessageType:
    TEXT = "text"


class MessageEvent:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)


class DiscordAdapter:
    def __init__(self):
        self._client = None
        self._text_batch_delay_seconds = 0
        self._threads = set()
        self._voice_text_channels = {}
        self.name = "discord"

    def _discord_require_mention(self) -> bool:
        return True

    def _discord_free_response_channels(self) -> set:
        return set()

    def _discord_thread_require_mention(self) -> bool:
        return False

    def _enqueue_text_event(self, event):
        return None

    async def handle_message(self, event):
        return None

    async def _start_client(self):
        # Synthetic on_message body with exact live admission anchors.
        async def on_message(message):
                # Always ignore our own messages
                if message.author == self._client.user:
                    return

                # Ignore Discord system messages (thread renames, pins, member joins, etc.)
                # Allow both default and reply types — replies have a distinct MessageType.
                if message.type not in {discord.MessageType.default, discord.MessageType.reply}:
                    return

                # Bot message filtering (DISCORD_ALLOW_BOTS):
                #   "none"     — ignore all other bots (default)
                #   "mentions" — accept bot messages only when they @mention us
                #   "all"      — accept all bot messages
                # Must run BEFORE the user allowlist check so that bots
                # permitted by DISCORD_ALLOW_BOTS are not rejected for
                # not being in DISCORD_ALLOWED_USERS (fixes #4466).
                _role_authorized = False
                if getattr(message.author, "bot", False):
                    allow_bots = os.getenv("DISCORD_ALLOW_BOTS", "none").lower().strip()
                    if allow_bots == "none":
                        return
                    elif allow_bots == "mentions":
                        if not self._client.user or self._client.user not in message.mentions:
                            return
                    # "all" falls through; bot is permitted — skip the
                    # human-user allowlist below (bots aren't in it).
                else:
                    # Non-bot: enforce the configured user/role allowlists.
                    # Pass guild + is_dm so role checks are scoped to the
                    # originating guild (prevents cross-guild DM bypass, see
                    # _is_allowed_user docstring).
                    _msg_guild = getattr(message, "guild", None)
                    _is_dm = isinstance(message.channel, discord.DMChannel) or _msg_guild is None
                    if not self._is_allowed_user(
                        str(message.author.id),
                        message.author,
                        guild=_msg_guild,
                        is_dm=_is_dm,
                    ):
                        return
                    _role_authorized = bool(getattr(self, "_allowed_role_ids", set()))

                # Multi-agent filtering: if the message mentions specific bots
                # but NOT this bot, the sender is talking to another agent —
                # stay silent.  Messages with no bot mentions (general chat)
                # still fall through to _handle_message for the existing
                # DISCORD_REQUIRE_MENTION check.
                #
                # This replaces the older DISCORD_IGNORE_NO_MENTION logic
                # with bot-aware filtering that works correctly when multiple
                # agents share a channel.
                if not isinstance(message.channel, discord.DMChannel) and message.mentions:
                    _self_mentioned = (
                        self._client.user is not None
                        and self._client.user in message.mentions
                    )
                    _other_bots_mentioned = any(
                        m.bot and m != self._client.user
                        for m in message.mentions
                    )
                    # If other bots are mentioned but we're not → not for us
                    if _other_bots_mentioned and not _self_mentioned:
                        return
                    # If humans are mentioned but we're not → not for us
                    # (preserves old DISCORD_IGNORE_NO_MENTION=true behavior)
                    # EXCEPT in free-response channels where the bot should
                    # answer regardless of who is mentioned.
                    _ignore_no_mention = os.getenv(
                        "DISCORD_IGNORE_NO_MENTION", "true"
                    ).lower() in {"true", "1", "yes"}
                    if _ignore_no_mention and not _self_mentioned and not _other_bots_mentioned:
                        _channel_id = str(message.channel.id)
                        _parent_id = None
                        if hasattr(message.channel, "parent_id") and message.channel.parent_id:
                            _parent_id = str(message.channel.parent_id)
                        _free_channels = adapter_self._discord_free_response_channels()
                        _channel_ids = {_channel_id}
                        if _parent_id:
                            _channel_ids.add(_parent_id)
                        if "*" not in _free_channels and not (_channel_ids & _free_channels):
                            return

                await self._handle_message(message, role_authorized=_role_authorized)

    async def _handle_message(self, message: DiscordMessage, role_authorized: bool = False) -> None:
        """Handle incoming Discord messages (admission routing slice only)."""
        raw_content = message.content.strip()
        normalized_content = raw_content
        mention_prefix = False
        is_thread = False
        thread_id = None
        parent_channel_id = None
        if self._client.user and self._client.user in message.mentions:
            mention_prefix = True
        if not isinstance(message.channel, type("DM", (), {})):
            channel_ids = {str(message.channel.id)}
            free_channels = self._discord_free_response_channels()
            require_mention = self._discord_require_mention()
            is_voice_linked_channel = False
            is_free_channel = (
                "*" in free_channels
                or bool(channel_ids & free_channels)
                or is_voice_linked_channel
            )
            in_bot_thread = (
                is_thread
                and thread_id in self._threads
                and not self._discord_thread_require_mention()
            )
            if require_mention and not is_free_channel and not in_bot_thread:
                if self._client.user not in message.mentions and not mention_prefix:
                    return

        msg_type = MessageType.TEXT
        event = MessageEvent(
            text=normalized_content,
            message_type=msg_type,
            message_id=str(getattr(message, "id", "")),
        )
        if msg_type == MessageType.TEXT and self._text_batch_delay_seconds > 0:
            self._enqueue_text_event(event)
        else:
            await self.handle_message(event)
