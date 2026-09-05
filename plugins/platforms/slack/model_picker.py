"""Slack's two-stage model picker: rendering, interaction state and callbacks."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, TYPE_CHECKING

from gateway.platforms.base import SendResult

try:
    from .block_kit import sanitize_blocks
except ImportError:  # pragma: no cover - flat plugin loading
    from block_kit import sanitize_blocks

if TYPE_CHECKING:
    from .adapter import SlackAdapter

logger = logging.getLogger(__name__)

# Model picker Block Kit action IDs. The picker is a two-step drill-down:
# provider static_select → model static_select, plus Back/Cancel buttons.
_MODEL_PICKER_PROVIDER_ACTION = "hermes_model_provider"
_MODEL_PICKER_MODEL_ACTION = "hermes_model_model"
_MODEL_PICKER_BACK_ACTION = "hermes_model_back"
_MODEL_PICKER_CANCEL_ACTION = "hermes_model_cancel"
# Rendered when a live-looking picker message can no longer resolve (gateway
# restart, aged-out state entry, or a value the stored state no longer
# covers): the message is rewritten to this so the control visibly dies.
_MODEL_PICKER_EXPIRED_NOTICE = "⏳ This model picker expired — please run /model again."
_MODEL_PICKER_ACTION_IDS = (
    _MODEL_PICKER_PROVIDER_ACTION,
    _MODEL_PICKER_MODEL_ACTION,
    _MODEL_PICKER_BACK_ACTION,
    _MODEL_PICKER_CANCEL_ACTION,
)



class SlackModelPicker:
    STATE_MAX = 100

    def __init__(self, adapter: SlackAdapter) -> None:
        self._adapter = adapter
        self.state: Dict[Any, dict] = {}

    def register(self, app) -> None:
        for action_id in _MODEL_PICKER_ACTION_IDS:
            app.action(action_id)(self.handle_action)

    def _build_model_picker_provider_blocks(
        self, providers: list, current_model: str, provider_label: str
    ) -> List[dict]:
        """Build the provider-select stage of the model picker.

        A section header (current model/provider) plus an actions block with a
        ``static_select`` of providers and a Cancel button. Provider option
        ``value`` carries the list index (same scheme as the model stage) so
        an over-long custom provider slug never trips Slack's 75-char option
        value cap — the handler resolves the real slug from picker state.
        """
        options = []
        for idx, p in enumerate(providers[:100]):
            count = p.get("total_models", len(p.get("models", [])))
            options.append({
                "text": {"type": "plain_text", "text": f"{p['name']} ({count} models)"[:75], "emoji": True},
                "value": str(idx),
            })
        extra = (
            f"\n*{len(providers) - 100} more available — type `/model <name>` directly*"
            if len(providers) > 100
            else ""
        )
        section_text = (
            f"*⚙ Model Configuration*\n"
            f"Current model: `{current_model or 'unknown'}`\n"
            f"Provider: {provider_label}\n\n"
            f"Select a provider:{extra}"
        )
        return [
            {"type": "section", "text": {"type": "mrkdwn", "text": section_text[:3000]}},
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "static_select",
                        "placeholder": {"type": "plain_text", "text": "Choose a provider…", "emoji": True},
                        "action_id": _MODEL_PICKER_PROVIDER_ACTION,
                        "options": options,
                    },
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "Cancel", "emoji": True},
                        "style": "danger",
                        "action_id": _MODEL_PICKER_CANCEL_ACTION,
                        "value": "cancel",
                    },
                ],
            },
        ]

    def _build_model_picker_model_blocks(self, providers: list, provider_slug: str) -> List[dict]:
        """Build the model-select stage for a chosen provider.

        A section header (provider name) plus an actions block with a
        ``static_select`` of models and Back/Cancel buttons. Model option
        ``value`` carries the list index so over-long model IDs never trip
        Slack's 75-char value cap; the handler resolves the real model ID
        from the provider's model list in picker state.
        """
        provider = next((p for p in providers if p["slug"] == provider_slug), None)
        pname = provider.get("name", provider_slug) if provider else provider_slug
        models = (provider or {}).get("models", [])[:100]
        options = []
        for idx, model_id in enumerate(models):
            short = model_id.split("/")[-1] if "/" in model_id else model_id
            options.append({
                "text": {"type": "plain_text", "text": short[:75], "emoji": True},
                "value": str(idx),
            })
        total = (provider or {}).get("total_models", len(models))
        extra = (
            f"\n*{total - len(models)} more available — type `/model <name>` directly*"
            if total > len(models)
            else ""
        )
        section_text = f"*⚙ Model Configuration*\n\nProvider: *{pname}*\nSelect a model:{extra}"
        elements = [
            {
                "type": "static_select",
                "placeholder": {"type": "plain_text", "text": f"Choose a model from {pname}…"[:150], "emoji": True},
                "action_id": _MODEL_PICKER_MODEL_ACTION,
                "options": options,
            },
        ]
        if provider_slug:
            elements.append({
                "type": "button",
                "text": {"type": "plain_text", "text": "◀ Back", "emoji": True},
                "action_id": _MODEL_PICKER_BACK_ACTION,
                "value": provider_slug,
            })
        elements.append({
            "type": "button",
            "text": {"type": "plain_text", "text": "Cancel", "emoji": True},
            "style": "danger",
            "action_id": _MODEL_PICKER_CANCEL_ACTION,
            "value": "cancel",
        })
        return [
            {"type": "section", "text": {"type": "mrkdwn", "text": section_text[:3000]}},
            {"type": "actions", "elements": elements},
        ]

    async def send(
        self,
        chat_id: str,
        providers: list,
        current_model: str,
        current_provider: str,
        session_key: str,
        on_model_selected,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Send an interactive Block Kit model picker.

        Two-step drill-down: provider ``static_select`` → model
        ``static_select``, with Back/Cancel buttons. Resolves via
        ``handle_action``, which calls ``on_model_selected`` on
        a model choice.
        """
        if not self._adapter._app:
            return SendResult(success=False, error="Not connected")

        chat_id = await self._adapter._ensure_dm_conversation(
            chat_id, team_id=self._adapter._metadata_team_id(metadata)
        )
        try:
            thread_ts = self._adapter._resolve_thread_ts(None, metadata)

            try:
                from hermes_cli.providers import get_label
                provider_label = get_label(current_provider)
            except Exception:
                provider_label = current_provider

            if not providers:
                return SendResult(success=False, error="No providers available")

            blocks = self._build_model_picker_provider_blocks(
                providers, current_model, provider_label
            )

            kwargs: Dict[str, Any] = {
                "channel": chat_id,
                "text": "⚙ Model Configuration — select a provider",
                "blocks": sanitize_blocks(blocks),
            }
            if thread_ts:
                kwargs["thread_ts"] = thread_ts

            result = await self._adapter._get_client(
                chat_id, team_id=self._adapter._metadata_team_id(metadata)
            ).chat_postMessage(**kwargs)
            msg_ts = result.get("ts", "")
            if not msg_ts:
                return SendResult(success=False, error="No message timestamp returned")

            team_id = self._adapter._metadata_team_id(metadata)
            self.state[
                self._adapter._workspace_message_marker(team_id, msg_ts)
            ] = {
                "providers": providers,
                "session_key": session_key,
                "chat_id": chat_id,
                "team_id": team_id,
                "current_model": current_model,
                "current_provider": current_provider,
                "on_model_selected": on_model_selected,
                "stage": "provider",
                "selected_provider_slug": "",
            }
            self._adapter._trim_oldest_dict_entries(
                self.state, self.STATE_MAX
            )

            return SendResult(success=True, message_id=msg_ts, raw_response=result)
        except Exception as e:
            logger.error("[Slack] send_model_picker failed: %s", e, exc_info=True)
            return SendResult(success=False, error=str(e))

    async def _update_picker_message(
        self,
        channel_id: str,
        team_id: str,
        msg_ts: str,
        section_text: str,
    ) -> None:
        """Replace the picker message body with a plain section (no controls)."""
        try:
            await self._adapter._get_client(channel_id, team_id=team_id or None).chat_update(
                channel=channel_id,
                ts=msg_ts,
                text=section_text[:3000],
                blocks=sanitize_blocks([
                    {"type": "section", "text": {"type": "mrkdwn", "text": section_text[:3000]}},
                ]),
            )
        except Exception as e:
            logger.warning("[Slack] Failed to update model picker message: %s", e)

    async def handle_action(self, ack, body, action) -> None:
        """Handle a model picker Block Kit interaction.

        Dispatches on the action_id: provider static_select advances to the
        model stage, model static_select runs ``on_model_selected``, Back
        returns to the provider stage, Cancel dismisses the picker.
        """
        await ack()

        team_id = self._adapter._event_team_id({}, body)
        action_id = action.get("action_id", "")
        message = body.get("message", {})
        msg_ts = message.get("ts", "")
        channel_id = body.get("channel", {}).get("id", "")
        user_name = body.get("user", {}).get("name", "unknown")
        user_id = body.get("user", {}).get("id", "")

        if not self._adapter._is_interactive_user_authorized(
            user_id,
            channel_id=channel_id,
            user_name=user_name,
            team_id=team_id,
        ):
            logger.warning(
                "[Slack] Unauthorized model picker click by %s (%s) - ignoring",
                user_name, user_id,
            )
            return

        # Look up the picker state. The send path may have stored it under a
        # bare ts (metadata-poor send, no team id) while this click event
        # carries a team id — that mismatch must not swallow a legitimate
        # interaction (mirrors _handle_approval_action's dual-key lookup).
        marker = self._adapter._workspace_message_marker(team_id, msg_ts)
        if msg_ts in self.state:
            marker = msg_ts
        state = self.state.get(marker)
        if not state:
            logger.debug("[Slack] Model picker state not found for marker=%s", marker)
            # Gateway restarted or the entry aged out of the bounded dict —
            # there is no gateway-side registry to fall back on, so this
            # dict is the picker's only state. Kill the live-looking
            # control visibly instead of silently swallowing clicks
            # (mirrors the clarify handler's expiry notice).
            await self._update_picker_message(
                channel_id, team_id, msg_ts, _MODEL_PICKER_EXPIRED_NOTICE
            )
            return

        providers = state.get("providers", [])
        on_model_selected = state.get("on_model_selected")

        # Cancel → dismiss.
        if action_id == _MODEL_PICKER_CANCEL_ACTION:
            self.state.pop(marker, None)
            await self._update_picker_message(
                channel_id, team_id, msg_ts, "❌ Model selection cancelled."
            )
            return

        # Provider selected → advance to model stage. The option value is a
        # list index into the stored providers slice (never the raw slug —
        # custom slugs can exceed Slack's 75-char option value cap).
        if action_id == _MODEL_PICKER_PROVIDER_ACTION:
            selected = action.get("selected_option", {})
            idx_token = selected.get("value", "")
            try:
                idx = int(idx_token)
                provider = providers[idx] if idx >= 0 else None
            except (ValueError, IndexError, TypeError):
                provider = None
            if provider is None:
                # Message and stored state are out of sync (stale payload,
                # re-seeded entry) — the picker can no longer resolve, so
                # kill it visibly like the expiry path.
                logger.warning("[Slack] Invalid provider picker index token: %r", idx_token)
                self.state.pop(marker, None)
                await self._update_picker_message(
                    channel_id, team_id, msg_ts, _MODEL_PICKER_EXPIRED_NOTICE
                )
                return
            provider_slug = provider.get("slug", "")
            if not provider.get("models"):
                await self._update_picker_message(
                    channel_id, team_id, msg_ts,
                    f"No models available for `{provider_slug}`.",
                )
                self.state.pop(marker, None)
                return

            state["stage"] = "model"
            state["selected_provider_slug"] = provider_slug
            blocks = self._build_model_picker_model_blocks(providers, provider_slug)
            try:
                await self._adapter._get_client(channel_id, team_id=team_id or None).chat_update(
                    channel=channel_id,
                    ts=msg_ts,
                    text=f"⚙ Model Configuration — {provider.get('name', provider_slug)}",
                    blocks=sanitize_blocks(blocks),
                )
            except Exception as e:
                logger.warning("[Slack] Failed to update model picker (provider→model): %s", e)
            return

        # Back → return to provider stage.
        if action_id == _MODEL_PICKER_BACK_ACTION:
            state["stage"] = "provider"
            state["selected_provider_slug"] = ""
            try:
                from hermes_cli.providers import get_label
                provider_label = get_label(
                    state.get("current_provider", "")
                )
            except Exception:
                provider_label = state.get("current_provider", "")
            blocks = self._build_model_picker_provider_blocks(
                providers, state.get("current_model", ""), provider_label
            )
            try:
                await self._adapter._get_client(channel_id, team_id=team_id or None).chat_update(
                    channel=channel_id,
                    ts=msg_ts,
                    text="⚙ Model Configuration — select a provider",
                    blocks=sanitize_blocks(blocks),
                )
            except Exception as e:
                logger.warning("[Slack] Failed to update model picker (back): %s", e)
            return

        # Model selected → run the switch.
        if action_id == _MODEL_PICKER_MODEL_ACTION and state.get("stage") == "model":
            selected = action.get("selected_option", {})
            idx_token = selected.get("value", "")
            provider_slug = state.get("selected_provider_slug", "")
            provider = next((p for p in providers if p["slug"] == provider_slug), None)
            models = (provider or {}).get("models", [])
            try:
                idx = int(idx_token)
                model_id = models[idx] if idx >= 0 else None
            except (ValueError, IndexError, TypeError):
                model_id = None
            if model_id is None:
                # Message and stored state are out of sync — kill the picker
                # visibly instead of leaving a dead control.
                logger.warning("[Slack] Invalid model picker index token: %r", idx_token)
                self.state.pop(marker, None)
                await self._update_picker_message(
                    channel_id, team_id, msg_ts, _MODEL_PICKER_EXPIRED_NOTICE
                )
                return

            if not on_model_selected:
                self.state.pop(marker, None)
                await self._update_picker_message(
                    channel_id, team_id, msg_ts, _MODEL_PICKER_EXPIRED_NOTICE
                )
                return

            # Pop the state up-front (double-click guard, mirrors approval).
            self.state.pop(marker, None)
            await self._update_picker_message(
                channel_id, team_id, msg_ts, f"⚙ Switching to `{model_id}`…"
            )

            switch_failed = False
            try:
                confirmation = await on_model_selected(
                    state["chat_id"], model_id, provider_slug
                )
                # The gateway reports a failed in-place swap as a localized
                # error-prefixed return string, not an exception (#50163).
                # Compare against the same i18n prefix so both failure
                # shapes get the failed header.
                try:
                    from agent.i18n import t as _t

                    _error_prefix = _t("gateway.model.error_prefix", error="").strip()
                except Exception:
                    _error_prefix = "Error:"
                if _error_prefix and str(confirmation).startswith(_error_prefix):
                    switch_failed = True
            except Exception as exc:
                logger.error("[Slack] Model picker callback failed: %s", exc, exc_info=True)
                confirmation = f"❌ Model switch failed: {exc}"
                switch_failed = True

            header = "⚙ Model Switch Failed" if switch_failed else "⚙ Model Switched"
            await self._update_picker_message(
                channel_id, team_id, msg_ts, f"{header}\n\n{confirmation}"
            )
            return
