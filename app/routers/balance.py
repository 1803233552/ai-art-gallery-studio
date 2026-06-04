"""余额与 API Key 登录校验路由"""
import json
import time
from urllib.parse import urlencode

import aiohttp
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import get

router = APIRouter(prefix="/api/balance", tags=["balance"])

NEWAPI_QUOTA_PER_USD = 500000


class BalanceOverviewRequest(BaseModel):
    access_token: str
    user_id: str
    base_url: str | None = None


def _strip_api_suffix(base_url: str | None) -> str:
    base = str(base_url or "").strip().rstrip("/")
    for suffix in ("/v1/images/generations", "/images/generations", "/v1"):
        if base.endswith(suffix):
            base = base[: -len(suffix)].rstrip("/")
    return base


def _configured_api_node_urls() -> list[str]:
    nodes = get("api_nodes", {}) or {}
    urls = []
    seen = set()
    for url in nodes.values():
        base = _strip_api_suffix(url)
        if base and base not in seen:
            seen.add(base)
            urls.append(base)
    return urls


def _default_base_url() -> str:
    nodes = _configured_api_node_urls()
    if nodes:
        return nodes[0]
    return _strip_api_suffix(get("newapi.base_url", ""))


def _normalize_base_url(base_url: str | None) -> str:
    base = _strip_api_suffix(base_url)
    if not base:
        base = _default_base_url()
    return base


def _allowed_base_urls() -> set[str]:
    allowed = set(_configured_api_node_urls())
    if not allowed:
        newapi_base = _strip_api_suffix(get("newapi.base_url", ""))
        if newapi_base:
            allowed.add(newapi_base)
    return allowed


def _resolve_allowed_base_url(base_url: str | None) -> str:
    base = _normalize_base_url(base_url)
    if not base:
        raise HTTPException(400, "未配置 API 地址")
    if base not in _allowed_base_urls():
        raise HTTPException(400, "不允许的 API 线路")
    return base


async def _read_json_response(resp: aiohttp.ClientResponse) -> dict:
    text = await resp.text()
    try:
        data = json.loads(text) if text else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(resp.status, "上游返回非 JSON 数据，请检查 API 线路是否可用") from exc

    if resp.status >= 400:
        message = _extract_error_message(data) or f"HTTP {resp.status}"
        raise HTTPException(resp.status, message)
    if isinstance(data, dict) and data.get("success") is False:
        raise HTTPException(400, _extract_error_message(data) or "上游接口返回失败")
    if isinstance(data, dict) and data.get("error"):
        raise HTTPException(400, _extract_error_message(data) or "上游接口返回错误")
    return data


def _extract_error_message(data: dict) -> str:
    if not isinstance(data, dict):
        return ""
    error = data.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error.get("code") or "").strip()
    if error:
        return str(error).strip()
    return str(data.get("message") or data.get("detail") or "").strip()


def _extract_response_data(payload: dict):
    if isinstance(payload, dict) and "data" in payload:
        return payload.get("data")
    return payload


def _quota_to_usd(value: float | int | None) -> float:
    return float(value or 0) / NEWAPI_QUOTA_PER_USD


async def _request_json(method: str, url: str, headers: dict[str, str], timeout: int = 15) -> dict:
    try:
        async with aiohttp.ClientSession() as session:
            async with session.request(
                method,
                url,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as resp:
                return await _read_json_response(resp)
    except HTTPException:
        raise
    except aiohttp.ClientError as exc:
        raise HTTPException(502, f"连接上游失败：{exc}") from exc


@router.post("/overview")
async def balance_overview(req: BalanceOverviewRequest):
    access_token = req.access_token.strip()
    user_id = req.user_id.strip()
    if not access_token:
        raise HTTPException(400, "请输入余额查询 token")
    if not user_id.isdigit() or int(user_id) <= 0:
        raise HTTPException(400, "余额用户 ID 必须是 NewAPI 数字用户 ID")

    base = _resolve_allowed_base_url(req.base_url)
    headers = {
        "Authorization": access_token,
        "Content-Type": "application/json",
        "New-Api-User": user_id,
    }

    user_payload = await _request_json("GET", f"{base}/api/user/self", headers=headers)
    user_data = _extract_response_data(user_payload)
    if not isinstance(user_data, dict):
        raise HTTPException(502, "余额接口返回格式异常")

    account = str(
        user_data.get("display_name")
        or user_data.get("username")
        or user_data.get("id")
        or user_id
    ).strip().removeprefix("@")
    remaining_quota = float(user_data.get("quota") or 0)
    used_quota = float(user_data.get("used_quota") or 0)
    request_count = int(float(user_data.get("request_count") or 0))

    now_ts = int(time.time())
    start_ts = now_ts - 24 * 60 * 60
    recent_quota = None
    recent_count = None
    recent_error = ""
    query = urlencode({"start_timestamp": start_ts, "end_timestamp": now_ts, "default_time": "hour"})
    try:
        data_payload = await _request_json("GET", f"{base}/api/data/self?{query}", headers=headers)
        rows = _extract_response_data(data_payload)
        if isinstance(rows, list):
            recent_quota = sum(float(item.get("quota") or 0) for item in rows if isinstance(item, dict))
            recent_count = int(sum(float(item.get("count") or item.get("rpm") or 0) for item in rows if isinstance(item, dict)))
    except HTTPException as exc:
        recent_error = str(exc.detail)

    return {
        "success": True,
        "data": {
            "account": account,
            "site": base,
            "remaining_quota": remaining_quota,
            "remaining_usd": _quota_to_usd(remaining_quota),
            "used_quota": used_quota,
            "used_usd": _quota_to_usd(used_quota),
            "request_count": request_count,
            "recent_quota": recent_quota,
            "recent_usd": _quota_to_usd(recent_quota) if recent_quota is not None else None,
            "recent_count": recent_count,
            "recent_error": recent_error,
            "fetched_at": now_ts,
        },
    }
