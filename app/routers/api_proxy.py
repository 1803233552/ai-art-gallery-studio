"""后端代理 API 路由（仅 request_mode=backend 时启用）"""
import asyncio
import ipaddress
import json
import logging
import re
from urllib.parse import urlparse

import aiohttp
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import Response, JSONResponse
from app.config import get

router = APIRouter(prefix="/api/proxy", tags=["proxy"])
log = logging.getLogger(__name__)


def _normalize_target(target: str) -> str:
    """允许填写 127.0.0.1:3000 这类无协议 Base URL。"""
    target = (target or "").strip().rstrip("/")
    if target and "://" not in target:
        target = "http://" + target
    return target


def _is_allowed_user_host(hostname: str) -> bool:
    """允许公网域名/公网 IP，阻止显式本机/内网地址。"""
    host = (hostname or "").strip().strip("[]").lower()
    if not host or host in {"localhost", "localhost.localdomain"} or host.endswith(".localhost"):
        return False

    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        if re.fullmatch(r"(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))*", host):
            return False
        # 域名交给 HTTP 客户端解析；部分用户环境会把公网域名解析为代理/TUN 保留地址，
        # 这里不按本机 DNS 结果误杀。重定向已禁用，避免公网入口 30x 跳转到内网。
        return True


def _validate_user_target(target: str) -> None:
    """校验浏览器传入的 X-Target-Base，避免 SSRF。"""
    parsed = urlparse(target)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(400, "自定义 Base URL 仅支持 http/https 公网地址")
    if not _is_allowed_user_host(parsed.hostname):
        raise HTTPException(400, "后端代理模式下，自定义 Base URL 不允许使用本地、内网或链路本地地址")


def _is_retryable_client_error(error: aiohttp.ClientError) -> bool:
    """长耗时图片生成偶发 TLS 读响应失败时，允许有限重试。"""
    text = str(error).lower()
    return any(
        marker in text
        for marker in (
            "decryption_failed_or_bad_record_mac",
            "bad record mac",
            "connection reset",
            "server disconnected",
            "cannot connect",
        )
    )


def _looks_like_complete_json(content: bytes) -> bool:
    """判断已收到的字节是否是完整 JSON。"""
    if not content:
        return False
    try:
        json.loads(content.decode("utf-8"))
        return True
    except Exception:
        return False


async def _read_response_rescuable(resp: aiohttp.ClientResponse, target_url: str) -> bytes:
    """分块读取响应，TLS 尾部异常时尽量抢救已完整收到的 JSON。"""
    chunks: list[bytes] = []
    try:
        async for chunk in resp.content.iter_chunked(64 * 1024):
            if chunk:
                chunks.append(chunk)
    except aiohttp.ClientError as e:
        partial = b"".join(chunks)
        if _is_retryable_client_error(e):
            expected = resp.headers.get("Content-Length")
            expected_len = int(expected) if expected and expected.isdigit() else 0
            if expected_len and len(partial) >= expected_len:
                log.warning(
                    "代理读取上游响应末尾异常，但 Content-Length 已满足，继续返回: %s bytes=%s err=%s",
                    target_url,
                    len(partial),
                    e,
                )
                return partial
            if "json" in (resp.content_type or "").lower() and _looks_like_complete_json(partial):
                log.warning(
                    "代理读取上游响应末尾异常，但已收到完整 JSON，继续返回: %s bytes=%s err=%s",
                    target_url,
                    len(partial),
                    e,
                )
                return partial
        raise
    return b"".join(chunks)


@router.api_route("/{path:path}", methods=["GET", "POST"])
async def proxy_request(path: str, request: Request):
    """代理转发 API 请求到上游"""
    if get("request_mode", "frontend") != "backend":
        raise HTTPException(403, "后端代理模式未开启")

    # 获取目标 base_url
    user_target = request.headers.get("X-Target-Base", "")
    target = user_target
    nodes = get("api_nodes", {}) or {}
    default_target = list(nodes.values())[0] if nodes else ""

    if not target:
        # 使用第一个节点
        target = default_target

    # 旧前端 / 用户浏览器 localStorage 可能还保存着 CF 节点；
    # 生成图耗时较长，CF 容易 524，因此服务端强制兜底到直连节点。
    if "newapi-cf.qianqianye.com" in target and default_target:
        log.warning("代理目标节点从 CF 改写为直连: %s -> %s", target, default_target)
        target = default_target

    target = _normalize_target(target)
    if not target:
        raise HTTPException(400, "未指定目标节点")
    if user_target:
        _validate_user_target(target)

    target_url = f"{target}/{path}"

    # 转发 headers（不转发 Host / X-Target-Base 等内部 header）
    forward_headers = {}
    for key in ("Authorization", "Content-Type"):
        if key in request.headers:
            forward_headers[key] = request.headers[key]
    forward_headers["Accept-Encoding"] = "identity"
    forward_headers["Connection"] = "close"

    try:
        method = request.method.lower()
        body = await request.body()
        # 不自动重试图片生成 POST：请求可能已经到达中转站并扣费/生成成功，
        # 若只是读取响应时 TLS 断链，重试会造成重复生成。GET/轮询类请求可安全重试。
        max_attempts = 2 if method == "get" else 1

        timeout = aiohttp.ClientTimeout(total=600, connect=30, sock_connect=30, sock_read=600)
        connector = aiohttp.TCPConnector(
            limit=0,
            force_close=True,
            enable_cleanup_closed=True,
        )
        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            for attempt in range(1, max_attempts + 1):
                kwargs = {
                    "headers": forward_headers,
                    "timeout": timeout,
                    "compress": False,
                    "allow_redirects": False,
                }
                if body:
                    kwargs["data"] = body

                try:
                    async with getattr(session, method)(target_url, **kwargs) as resp:
                        ct = resp.content_type or ""
                        content = await _read_response_rescuable(resp, target_url)

                        # 上游返回了 HTML 错误页面（如 Cloudflare 拦截、502 等）
                        # 将其包装为 JSON 错误格式，避免前端 JSON 解析崩溃
                        if resp.status >= 400 and "html" in ct.lower():
                            snippet = content[:200].decode("utf-8", errors="replace").strip()
                            log.warning("代理上游返回 HTML 错误 [%s] %s: %s", resp.status, target_url, snippet[:100])
                            return JSONResponse(
                                status_code=resp.status,
                                content={"error": {"message": f"上游节点返回 HTTP {resp.status} 错误（非JSON响应），请检查节点可用性或更换节点", "type": "proxy_upstream_error", "code": resp.status}},
                            )

                        # 正常透传上游原始响应
                        return Response(
                            content=content,
                            status_code=resp.status,
                            media_type=resp.content_type,
                        )
                except aiohttp.ClientError as e:
                    if attempt < max_attempts and _is_retryable_client_error(e):
                        log.warning("代理请求网络错误，准备重试 %s/%s: %s %s", attempt, max_attempts, target_url, e)
                        await asyncio.sleep(1.5 * attempt)
                        continue
                    raise
    except aiohttp.ClientError as e:
        log.warning("代理请求网络错误: %s %s", target_url, e)
        return JSONResponse(
            status_code=502,
            content={"error": {"message": f"代理请求失败: {str(e)}", "type": "proxy_network_error", "code": 502}},
        )
    except Exception as e:
        log.warning("代理请求异常: %s %s", target_url, e)
        return JSONResponse(
            status_code=502,
            content={"error": {"message": f"代理请求失败: {str(e)}", "type": "proxy_error", "code": 502}},
        )
