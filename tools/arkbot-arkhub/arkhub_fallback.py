"""ArkBot 兜底插件：把收到的消息推给 dsh-arkhub 门面。

为什么需要它：收信只有一条链路时，那条链路就是单点。门面自己连 SnowLuma 的
WebSocket；这个插件让 **ArkBot 也独立连一份**（它有自己的适配器和重连），
收到的消息用 HTTP POST 塞进门面，门面按 message_id 去重 —— 同一句话不会进两次。

用法（三行）：
  1. 把这个文件放进 ArkBot 的插件目录（默认 `plugins/`）；
  2. bot.toml 里加一条 OneBot 适配器指向 SnowLuma（就是门面连的那个地址）；
  3. bot.toml 里给插件配 base_url（DSH 的 webServer 地址，门面在 /dsh-arkhub/ingest）。

    [[adapters]]
    type = "onebot11"
    url = "ws://127.0.0.1:3101/?access_token=xxx"

    [plugins.arkhub_fallback]
    base_url = "http://127.0.0.1:62560"

注意：这条通道是「兜底」，不是主力。它 block=False、priority 很低，
不会抢别的插件的消息，也不会替她回话 —— 它只负责把事件搬进门面。
"""

from __future__ import annotations

import asyncio
import json
import logging
import urllib.error
import urllib.request
from dataclasses import asdict
from typing import Any

from arkbot.plugin import Plugin

logger = logging.getLogger("arkbot.arkhub_fallback")

HEADER = "x-dsh-arkhub"


class ArkHubFallback(Plugin):
    name = "arkhub_fallback"

    default_config: dict[str, Any] = {
        "enabled": True,
        # DSH 的 webServer 地址；路径固定 /dsh-arkhub/ingest
        "base_url": "http://127.0.0.1:62560",
        "timeout": 3.0,
        # 只推这些群/人；空 = 全推（门面还有自己的白名单，这里不用重复管）
        "groups": [],
        "users": [],
    }

    async def onLoad(self) -> None:  # noqa: N802
        if not self.cfg.get("enabled", True):
            logger.info("arkhub 兜底未启用")
            return

        @self.on_message(priority=999, block=False)
        async def relay(event, _state: dict[str, Any]) -> None:  # noqa: ANN001
            payload = self._onebot(event)
            if not payload or not self._wanted(payload):
                return
            try:
                await asyncio.to_thread(self._post, payload)
            except Exception as error:  # 兜底通道自己不能把主流程搞挂
                logger.warning("兜底推送失败: %s", error)

        logger.info("arkhub 兜底已挂上：%s", self._url())

    # ---------- 内部 ----------

    def _url(self) -> str:
        base = str(self.cfg.get("base_url") or "").rstrip("/")
        return f"{base}/dsh-arkhub/ingest"

    def _wanted(self, payload: dict[str, Any]) -> bool:
        groups = {str(x) for x in (self.cfg.get("groups") or [])}
        users = {str(x) for x in (self.cfg.get("users") or [])}
        if not groups and not users:
            return True
        if payload.get("message_type") == "group":
            return str(payload.get("group_id")) in groups
        return str(payload.get("user_id")) in users

    def _onebot(self, event) -> dict[str, Any] | None:  # noqa: ANN001
        """MessageEvent → OneBot 11 事件（数组消息格式）。"""
        if not getattr(event, "message", None):
            return None
        try:
            message = event.message.to_onebot()
        except Exception:
            return None
        payload: dict[str, Any] = {
            "time": int(event.time or 0),
            "self_id": int(event.self_id or 0),
            "post_type": "message",
            "message_type": event.message_type or "private",
            "sub_type": event.sub_type or "normal",
            "message_id": int(event.message_id or 0),
            "user_id": int(event.user_id or 0),
            "group_id": int(event.group_id or 0),
            "message": message,
            "raw_message": getattr(event, "raw_message", "") or "",
            "sender": asdict(event.sender) if getattr(event, "sender", None) else {},
        }
        # 原始报文里的扩展字段（匿名、撤回标记之类）一并带上，门面原样转给 qq-bridge
        for key, value in (getattr(event, "raw", None) or {}).items():
            if key.startswith("_") or value is None or key in payload:
                continue
            payload[key] = value
        return payload

    def _post(self, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self._url(),
            data=body,
            method="POST",
            headers={
                "content-type": "application/json; charset=utf-8",
                HEADER: "arkbot",
            },
        )
        with urllib.request.urlopen(request, timeout=float(self.cfg.get("timeout") or 3.0)) as response:
            response.read()
