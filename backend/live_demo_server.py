from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass, field
from email.utils import formatdate
from typing import Awaitable, Callable, Optional
from urllib.parse import urlencode

import websockets
from dotenv import load_dotenv

from ast_live_client import (
    OUTPUT_RATE as AST_OUTPUT_RATE,
    AstAuth,
    AstLiveClient,
    _event_name,
)
from livetranslate_client import LiveTranslateClient


load_dotenv()

HOST = os.environ.get("LIVE_DEMO_HOST", "127.0.0.1")
PORT = int(os.environ.get("LIVE_DEMO_PORT", "8765"))
ALI_OUTPUT_RATE = 24000
IFLYTEK_HOST = "ws-api.xf-yun.com"
IFLYTEK_PATH = "/v1/private/simult_interpretation"
IFLYTEK_ENDPOINT = f"wss://{IFLYTEK_HOST}{IFLYTEK_PATH}"
IFLYTEK_FRAME_BYTES = 1280
IFLYTEK_OUTPUT_RATE = 16000


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _json(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def _audio_payload(provider: str, audio_data: bytes, *, sample_rate: int, encoding: str) -> dict:
    return {
        "type": "audio",
        "provider": provider,
        "sampleRate": sample_rate,
        "encoding": encoding,
        "audio": base64.b64encode(audio_data).decode("ascii"),
    }


def _get_ast_auth() -> Optional[AstAuth]:
    api_key = os.environ.get("AST_API_KEY")
    app_key = os.environ.get("AST_APP_KEY") or os.environ.get("AST_APP_ID")
    access_key = os.environ.get("AST_ACCESS_KEY")
    resource_id = os.environ.get("AST_RESOURCE_ID", "volc.service_type.10053")

    if api_key:
        return AstAuth(api_key=api_key, resource_id=resource_id)
    if app_key and access_key:
        return AstAuth(app_key=app_key, access_key=access_key, resource_id=resource_id)
    return None


def _first_env(*names: str) -> str:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return ""


def _get_iflytek_credentials() -> tuple[str, str, str]:
    app_id = _first_env("IFLYTEK_APPID", "XFYUN_APPID", "APPID")
    api_secret = _first_env("IFLYTEK_API_SECRET", "XFYUN_API_SECRET", "APISecret", "API_SECRET")
    api_key = _first_env("IFLYTEK_API_KEY", "XFYUN_API_KEY", "APIKey", "API_KEY")
    return app_id, api_secret, api_key


@dataclass
class ProviderBridge:
    provider: str
    send_event: Callable[[dict], Awaitable[None]]
    task: Optional[asyncio.Task] = None

    async def emit(self, payload: dict) -> None:
        payload.setdefault("provider", self.provider)
        await self.send_event(payload)

    def emit_nowait(self, payload: dict) -> None:
        asyncio.create_task(self.emit(payload))

    async def start(self) -> None:
        raise NotImplementedError

    def watch_task(self) -> None:
        if not self.task:
            return

        def _done(task: asyncio.Task) -> None:
            if task.cancelled():
                return
            exc = task.exception()
            if exc:
                self.emit_nowait(
                    {
                        "type": "provider_status",
                        "status": "error",
                        "message": str(exc),
                    }
                )

        self.task.add_done_callback(_done)

    async def send_audio(self, audio_data: bytes) -> None:
        raise NotImplementedError

    async def close(self) -> None:
        raise NotImplementedError


@dataclass
class AliBridge(ProviderBridge):
    api_key: str = ""
    source_language: str = "zh"
    target_language: str = "en"
    audio_enabled: bool = True
    voice_clone: bool = True
    client: Optional[LiveTranslateClient] = None

    async def start(self) -> None:
        if not self.api_key:
            await self.emit({"type": "provider_status", "status": "error", "message": "DASHSCOPE_API_KEY 未配置"})
            return

        await self.emit({"type": "provider_status", "status": "connecting", "message": "连接阿里 Qwen LiveTranslate"})
        self.client = LiveTranslateClient(
            api_key=self.api_key,
            source_language=self.source_language,
            target_language=self.target_language,
            audio_enabled=self.audio_enabled,
            enable_voice_clone=self.voice_clone,
            voice_clone_frequency="always" if self.voice_clone else "never",
            enable_source_transcription=True,
        )
        await self.client.connect()
        await self.emit({"type": "provider_status", "status": "connected", "message": "阿里同传已连接"})
        await self.emit({"type": "provider_event", "event": f"endpoint: {self.client.api_url}"})
        self.task = asyncio.create_task(
            self.client.handle_server_messages(
                lambda text, final=False: self.emit_nowait(
                    {"type": "translation_text", "text": text, "final": final}
                ),
                lambda text, final=False: self.emit_nowait(
                    {"type": "source_text", "text": text, "final": final}
                ),
                lambda audio_data: self.emit_nowait(
                    _audio_payload(
                        self.provider,
                        audio_data,
                        sample_rate=ALI_OUTPUT_RATE,
                        encoding="pcm_s16le",
                    )
                ),
                self.handle_status_event,
            )
        )
        self.watch_task()

    def handle_status_event(self, event_type: str, event: dict) -> None:
        if event_type in {"connection.closed", "connection.error"}:
            self.emit_nowait(
                {
                    "type": "provider_status",
                    "status": "error",
                    "message": event.get("message", "阿里连接已关闭"),
                }
            )
            return
        self.emit_nowait({"type": "provider_event", "event": event_type})

    async def send_audio(self, audio_data: bytes) -> None:
        if self.client and self.client.is_connected:
            await self.client.send_audio_chunk(audio_data)

    async def close(self) -> None:
        if self.client:
            await self.client.close()
        if self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        await self.emit({"type": "provider_status", "status": "closed", "message": "阿里同传已关闭"})


@dataclass
class VolcanoBridge(ProviderBridge):
    auth: Optional[AstAuth] = None
    source_language: str = "zh"
    target_language: str = "en"
    audio_enabled: bool = True
    voice_clone: bool = True
    client: Optional[AstLiveClient] = None

    async def start(self) -> None:
        if not self.auth:
            await self.emit({"type": "provider_status", "status": "error", "message": "AST_API_KEY 未配置"})
            return

        await self.emit({"type": "provider_status", "status": "connecting", "message": "连接火山 AST"})
        self.client = AstLiveClient(
            auth=self.auth,
            source_language=self.source_language,
            target_language=self.target_language,
            audio_enabled=self.audio_enabled,
            enable_voice_clone=self.voice_clone,
            tts_resource_id=os.environ.get("AST_TTS_RESOURCE_ID", "seed-icl-2.0"),
        )
        await self.client.connect()
        await self.emit({"type": "provider_status", "status": "connected", "message": "火山同传已连接"})
        self.task = asyncio.create_task(
            self.client.handle_server_messages(
                lambda text, final=False: self.emit_nowait(
                    {"type": "translation_text", "text": text, "final": final}
                ),
                lambda text, final=False: self.emit_nowait(
                    {"type": "source_text", "text": text, "final": final}
                ),
                lambda audio_data: self.emit_nowait(
                    _audio_payload(
                        self.provider,
                        audio_data,
                        sample_rate=AST_OUTPUT_RATE,
                        encoding="pcm_f32le",
                    )
                ),
                lambda response: self.emit_nowait(
                    {"type": "provider_event", "event": _event_name(response.event)}
                ),
            )
        )
        self.watch_task()

    async def send_audio(self, audio_data: bytes) -> None:
        if self.client and self.client.is_connected:
            await self.client.send_audio_chunk(audio_data)

    async def close(self) -> None:
        if self.client:
            await self.client.close()
        if self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        await self.emit({"type": "provider_status", "status": "closed", "message": "火山同传已关闭"})


@dataclass
class IflytekBridge(ProviderBridge):
    app_id: str = ""
    api_secret: str = ""
    api_key: str = ""
    source_language: str = "zh"
    target_language: str = "en"
    audio_enabled: bool = True
    voice_clone: bool = True
    websocket: Optional[object] = None
    seq: int = 0
    audio_buffer: bytearray = field(default_factory=bytearray)
    has_sent_audio: bool = False
    closing: bool = False
    server_finished: asyncio.Event = field(default_factory=asyncio.Event)

    def build_url(self) -> str:
        date = formatdate(time.time(), usegmt=True)
        signature_origin = f"host: {IFLYTEK_HOST}\ndate: {date}\nGET {IFLYTEK_PATH} HTTP/1.1"
        signature = base64.b64encode(
            hmac.new(
                self.api_secret.encode("utf-8"),
                signature_origin.encode("utf-8"),
                digestmod=hashlib.sha256,
            ).digest()
        ).decode("ascii")
        authorization_origin = (
            f'api_key="{self.api_key}", algorithm="hmac-sha256", '
            f'headers="host date request-line", signature="{signature}"'
        )
        query = urlencode(
            {
                "authorization": base64.b64encode(authorization_origin.encode("utf-8")).decode("ascii"),
                "date": date,
                "host": IFLYTEK_HOST,
                "serviceId": "simult_interpretation",
            }
        )
        return f"{IFLYTEK_ENDPOINT}?{query}"

    async def start(self) -> None:
        if not (self.app_id and self.api_secret and self.api_key):
            await self.emit({"type": "provider_status", "status": "error", "message": "讯飞 APPID/APISecret/APIKey 未配置"})
            return
        if self.source_language != "zh" or self.target_language != "en":
            await self.emit({"type": "provider_status", "status": "error", "message": "讯飞同传当前仅支持中文普通话到英语"})
            return

        await self.emit({"type": "provider_status", "status": "connecting", "message": "连接讯飞同声传译"})
        try:
            self.websocket = await websockets.connect(
                self.build_url(),
                max_size=8_000_000,
                ping_interval=None,
                open_timeout=30,
                close_timeout=2,
            )
        except Exception as exc:
            await self.emit(
                {
                    "type": "provider_status",
                    "status": "error",
                    "message": f"讯飞连接失败: {exc.__class__.__name__}",
                }
            )
            return
        await self.emit({"type": "provider_status", "status": "connected", "message": "讯飞同传已连接"})
        await self.emit({"type": "provider_event", "event": f"endpoint: {IFLYTEK_HOST}{IFLYTEK_PATH}"})
        self.task = asyncio.create_task(self.handle_server_messages())
        self.watch_task()

    def _request_frame(self, audio_data: bytes, status: int) -> dict:
        parameter = {
            "ist": {
                "accent": "mandarin",
                "domain": "ist_ed_open",
                "language": "zh_cn",
                "vto": 15000,
                "eos": 150000,
            },
            "streamtrans": {
                "from": "cn",
                "to": "en",
            },
        }
        if self.audio_enabled:
            parameter["tts"] = {
                "vcn": os.environ.get("IFLYTEK_TTS_VOICE", "x2_catherine"),
                "tts_results": {
                    "encoding": "raw",
                    "sample_rate": IFLYTEK_OUTPUT_RATE,
                    "channels": 1,
                    "bit_depth": 16,
                    "frame_size": 0,
                },
            }

        return {
            "header": {
                "app_id": self.app_id,
                "status": status,
            },
            "parameter": parameter,
            "payload": {
                "data": {
                    "audio": base64.b64encode(audio_data).decode("ascii"),
                    "encoding": "raw",
                    "sample_rate": IFLYTEK_OUTPUT_RATE,
                    "seq": self.seq,
                    "status": status,
                }
            },
        }

    async def _send_frame(self, audio_data: bytes, status: int) -> None:
        if not self.websocket or not self._websocket_open():
            return
        await self.websocket.send(_json(self._request_frame(audio_data, status)))
        self.seq += 1
        if status in {0, 1}:
            self.has_sent_audio = True

    def _websocket_open(self) -> bool:
        if not self.websocket:
            return False
        closed = getattr(self.websocket, "closed", None)
        if closed is not None:
            return not closed
        return getattr(self.websocket, "close_code", None) is None

    async def send_audio(self, audio_data: bytes) -> None:
        if not self.websocket or not self._websocket_open() or self.closing:
            return

        self.audio_buffer.extend(audio_data)
        while len(self.audio_buffer) >= IFLYTEK_FRAME_BYTES and not self.closing:
            chunk = bytes(self.audio_buffer[:IFLYTEK_FRAME_BYTES])
            del self.audio_buffer[:IFLYTEK_FRAME_BYTES]
            status = 0 if not self.has_sent_audio else 1
            await self._send_frame(chunk, status)

    async def handle_server_messages(self) -> None:
        if not self.websocket:
            return

        try:
            async for raw_message in self.websocket:
                message = json.loads(raw_message)
                header = message.get("header", {})
                code = header.get("code", 0)
                if code != 0:
                    await self.emit(
                        {
                            "type": "provider_status",
                            "status": "error",
                            "message": header.get("message") or f"讯飞服务错误: {code}",
                        }
                    )
                    self.server_finished.set()
                    break

                payload = message.get("payload", {})
                emitted_source = self._emit_recognition(payload)
                self._emit_translation(payload, emitted_source=emitted_source)
                self._emit_tts_audio(payload)

                if header.get("status") == 2:
                    self.server_finished.set()
                    break
        except websockets.ConnectionClosed as exc:
            if not self.closing:
                await self.emit(
                    {
                        "type": "provider_status",
                        "status": "error",
                        "message": f"讯飞连接已关闭: {exc.__class__.__name__}",
                    }
                )
        finally:
            if self.closing:
                self.server_finished.set()

    def _decode_payload_json(self, payload_item: dict) -> Optional[dict]:
        text = payload_item.get("text") if isinstance(payload_item, dict) else None
        if not text:
            return None
        try:
            decoded = base64.b64decode(text).decode("utf-8")
            return json.loads(decoded)
        except Exception as exc:
            self.emit_nowait({"type": "provider_event", "event": f"decode.skipped: {exc}"})
            return None

    def _payload_final(self, payload_item: dict, decoded: Optional[dict] = None) -> bool:
        status = payload_item.get("status") if isinstance(payload_item, dict) else None
        if status == 2:
            return True
        if isinstance(decoded, dict):
            return bool(decoded.get("is_final") or decoded.get("ls"))
        return False

    def _emit_recognition(self, payload: dict) -> bool:
        item = payload.get("recognition_results")
        decoded = self._decode_payload_json(item) if item else None
        if not decoded:
            return False

        words = []
        for segment in decoded.get("ws", []):
            for candidate in segment.get("cw", []):
                word = candidate.get("w")
                if word:
                    words.append(word)
        text = "".join(words).strip()
        if not text:
            return False
        self.emit_nowait({"type": "source_text", "text": text, "final": self._payload_final(item, decoded)})
        return True

    def _emit_translation(self, payload: dict, *, emitted_source: bool) -> None:
        item = payload.get("streamtrans_results")
        decoded = self._decode_payload_json(item) if item else None
        if not decoded:
            return

        final = self._payload_final(item, decoded)
        source = (decoded.get("src") or "").strip()
        target = (decoded.get("dst") or "").strip()
        if source and not emitted_source:
            self.emit_nowait({"type": "source_text", "text": source, "final": final})
        if target:
            self.emit_nowait({"type": "translation_text", "text": target, "final": final})

    def _emit_tts_audio(self, payload: dict) -> None:
        if not self.audio_enabled:
            return
        item = payload.get("tts_results")
        audio_b64 = item.get("audio") if isinstance(item, dict) else None
        if not audio_b64:
            return
        try:
            audio_data = base64.b64decode(audio_b64)
        except Exception as exc:
            self.emit_nowait({"type": "provider_event", "event": f"audio.decode.skipped: {exc}"})
            return
        if audio_data:
            self.emit_nowait(
                _audio_payload(
                    self.provider,
                    audio_data,
                    sample_rate=IFLYTEK_OUTPUT_RATE,
                    encoding="pcm_s16le",
                )
            )

    async def close(self) -> None:
        self.closing = True
        if self.websocket and self._websocket_open():
            remaining = bytes(self.audio_buffer)
            self.audio_buffer.clear()
            try:
                await self._send_frame(remaining, 2)
                grace_seconds = _env_float("IFLYTEK_CLOSE_GRACE_SECONDS", 8)
                await asyncio.wait_for(self.server_finished.wait(), timeout=grace_seconds)
            except asyncio.TimeoutError:
                await self.emit({"type": "provider_event", "event": "讯飞结束帧已发送，等待服务端结束超时"})
            except Exception as exc:
                await self.emit({"type": "provider_event", "event": f"讯飞结束帧发送失败: {exc}"})
            finally:
                await self.websocket.close()

        if self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        await self.emit({"type": "provider_status", "status": "closed", "message": "讯飞同传已关闭"})


@dataclass
class BrowserSession:
    websocket: websockets.WebSocketServerProtocol
    outbox: asyncio.Queue = field(default_factory=asyncio.Queue)
    providers: dict[str, ProviderBridge] = field(default_factory=dict)
    sender_task: Optional[asyncio.Task] = None
    audio_packets: int = 0

    async def send_event(self, payload: dict) -> None:
        await self.outbox.put(payload)

    async def send_loop(self) -> None:
        while True:
            payload = await self.outbox.get()
            await self.websocket.send(_json(payload))

    async def start(self, config: dict) -> None:
        await self.close_providers()

        source_language = config.get("sourceLanguage") or "zh"
        target_language = config.get("targetLanguage") or "en"
        audio_enabled = bool(config.get("audioEnabled", True))
        voice_clone = bool(config.get("voiceClone", True)) and audio_enabled
        requested = set(config.get("providers") or ["volcano"])

        bridges: dict[str, ProviderBridge] = {}
        if "volcano" in requested:
            bridges["volcano"] = VolcanoBridge(
                provider="volcano",
                send_event=self.send_event,
                auth=_get_ast_auth(),
                source_language=source_language,
                target_language=target_language,
                audio_enabled=audio_enabled,
                voice_clone=voice_clone,
            )
        if "aliyun" in requested:
            bridges["aliyun"] = AliBridge(
                provider="aliyun",
                send_event=self.send_event,
                api_key=os.environ.get("DASHSCOPE_API_KEY", ""),
                source_language=source_language,
                target_language=target_language,
                audio_enabled=audio_enabled,
                voice_clone=voice_clone,
            )
        if "iflytek" in requested:
            app_id, api_secret, api_key = _get_iflytek_credentials()
            bridges["iflytek"] = IflytekBridge(
                provider="iflytek",
                send_event=self.send_event,
                app_id=app_id,
                api_secret=api_secret,
                api_key=api_key,
                source_language=source_language,
                target_language=target_language,
                audio_enabled=audio_enabled,
                voice_clone=voice_clone,
            )

        self.providers = bridges
        self.audio_packets = 0
        await self.send_event(
            {
                "type": "session_status",
                "status": "starting",
                "message": f"正在启动 {', '.join(self.providers.keys())} 模型会话",
                "sourceLanguage": source_language,
                "targetLanguage": target_language,
                "audioEnabled": audio_enabled,
                "voiceClone": voice_clone,
            }
        )

        results = await asyncio.gather(
            *(bridge.start() for bridge in self.providers.values()),
            return_exceptions=True,
        )
        for provider, result in zip(self.providers.keys(), results):
            if isinstance(result, Exception):
                await self.send_event(
                    {
                        "type": "provider_status",
                        "provider": provider,
                        "status": "error",
                        "message": str(result),
                    }
                )

        await self.send_event({"type": "session_status", "status": "ready"})

    async def send_audio(self, audio_b64: str) -> None:
        if not self.providers:
            await self.send_event({"type": "session_status", "status": "idle", "message": "请先开始会话"})
            return
        audio_data = base64.b64decode(audio_b64)
        self.audio_packets += 1
        if self.audio_packets == 1:
            await self.send_event(
                {
                    "type": "session_status",
                    "status": "audio",
                    "message": f"已收到浏览器音频流，首包 {len(audio_data)} bytes",
                }
            )
        await asyncio.gather(
            *(bridge.send_audio(audio_data) for bridge in self.providers.values()),
            return_exceptions=True,
        )

    async def close_providers(self) -> None:
        if not self.providers:
            return
        await asyncio.gather(
            *(bridge.close() for bridge in self.providers.values()),
            return_exceptions=True,
        )
        self.providers.clear()

    async def run(self) -> None:
        self.sender_task = asyncio.create_task(self.send_loop())
        await self.send_event({"type": "session_status", "status": "idle", "message": "live demo backend ready"})
        try:
            async for raw_message in self.websocket:
                try:
                    message = json.loads(raw_message)
                    message_type = message.get("type")
                    if message_type == "start":
                        await self.start(message)
                    elif message_type == "audio":
                        await self.send_audio(message.get("audio", ""))
                    elif message_type == "stop":
                        await self.close_providers()
                        await self.send_event({"type": "session_status", "status": "stopped"})
                    elif message_type == "ping":
                        await self.send_event({"type": "pong"})
                    else:
                        await self.send_event({"type": "error", "message": f"未知消息类型: {message_type}"})
                except Exception as exc:
                    await self.send_event({"type": "error", "message": str(exc)})
        finally:
            await self.close_providers()
            if self.sender_task:
                self.sender_task.cancel()
                await asyncio.gather(self.sender_task, return_exceptions=True)


async def handle_client(websocket, _path=None) -> None:
    session = BrowserSession(websocket)
    await session.run()


async def main() -> None:
    load_dotenv()
    async with websockets.serve(handle_client, HOST, PORT, max_size=8_000_000):
        print(f"Live demo backend listening on ws://{HOST}:{PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
