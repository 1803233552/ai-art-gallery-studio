"""后端代理 API 路由（仅 request_mode=backend 时启用）"""
import json
import logging
import aiohttp
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import Response, JSONResponse
from app.config import get

router = APIRouter(prefix="/api/proxy", tags=["proxy"])
log = logging.getLogger(__name__)

@router.api_route("/{path:path}", methods=["GET", "POST"])
async def proxy_request(path: str, request: Request):
    """代理转发 API 请求到上游"""
    if get("request_mode", "frontend") != "backend":
        raise HTTPException(403, "后端代理模式未开启")

    # 获取目标 base_url
    target = request.headers.get("X-Target-Base", "")
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

    if not target:
        raise HTTPException(400, "未指定目标节点")

    target_url = f"{target.rstrip('/')}/{path}"

    # 转发 headers（不转发 Host / X-Target-Base 等内部 header）
    forward_headers = {}
    for key in ("Authorization", "Content-Type"):
        if key in request.headers:
            forward_headers[key] = request.headers[key]

    try:
        async with aiohttp.ClientSession() as session:
            method = request.method.lower()
            body = await request.body()

            kwargs = {
                "headers": forward_headers,
                "timeout": aiohttp.ClientTimeout(total=300),
            }
            if body:
                kwargs["data"] = body

            async with getattr(session, method)(target_url, **kwargs) as resp:
                content = await resp.read()
                ct = resp.content_type or ""

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
