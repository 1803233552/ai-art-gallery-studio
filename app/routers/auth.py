"""鉴权路由 — NewAPI 仅做登录验证，本项目自签 token"""
import time
import json
import hmac
import hashlib
import base64
import aiohttp
import aiosqlite
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from app.config import get
from app.database import get_db

router = APIRouter(prefix="/auth", tags=["auth"])

# Token 有效期 30 天
_TOKEN_TTL = 30 * 86400

class LoginRequest(BaseModel):
    username: str
    password: str

class TokenCheckRequest(BaseModel):
    token: str

# ---- 自签 Token（HMAC-SHA256）----
def _sign_token(payload: dict) -> str:
    """用 config 中的 secret_key 签发 token"""
    secret = get("secret_key", "fallback_key")
    payload["exp"] = int(time.time()) + _TOKEN_TTL
    data = base64.urlsafe_b64encode(json.dumps(payload, ensure_ascii=False).encode()).decode()
    sig = hmac.new(secret.encode(), data.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{data}.{sig}"

def _verify_token(token: str) -> dict | None:
    """验证自签 token，返回 payload 或 None"""
    try:
        parts = token.rsplit(".", 1)
        if len(parts) != 2:
            return None
        data, sig = parts
        secret = get("secret_key", "fallback_key")
        expected = hmac.new(secret.encode(), data.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(base64.urlsafe_b64decode(data))
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None

# ---- 公共 API：验证 token 并返回用户信息 ----
async def verify_user_token(token: str) -> dict | None:
    """验证本项目 token，返回用户信息 dict 或 None"""
    return _verify_token(token)

# 兼容旧调用名
async def verify_newapi_token(token: str) -> dict | None:
    return _verify_token(token)

def is_admin(user_data: dict) -> bool:
    admin_ids = get("newapi.admin_user_ids", [])
    user_id = user_data.get("id")
    role = user_data.get("role", 0)
    return user_id in admin_ids or role >= 100

# ---- 路由 ----
@router.post("/login")
async def login(req: LoginRequest):
    """用 NewAPI 验证用户名密码，成功后签发本项目 token"""
    base_url = get("newapi.base_url", "").rstrip("/")
    if not base_url:
        raise HTTPException(400, "New API 未配置")

    # 1. 向 NewAPI 发登录请求验证身份
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{base_url}/api/user/login",
                json={"username": req.username, "password": req.password},
                timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                data = await resp.json()
                if not data.get("success"):
                    return {"success": False, "message": data.get("message", "登录失败")}
    except Exception as e:
        raise HTTPException(500, f"登录请求失败: {str(e)}")

    # 2. 登录成功 — 用 NewAPI token 获取用户信息
    newapi_token = data.get("data", "")
    user_info = None
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{base_url}/api/user/self",
                headers={"Authorization": f"Bearer {newapi_token}"},
                timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                udata = await resp.json()
                if udata.get("success"):
                    user_info = udata.get("data", {})
    except Exception:
        pass

    # 3. 封禁检查
    user_id = user_info.get("id", 0) if user_info else 0
    if not user_id:
        return {"success": False, "message": "登录失败：无法获取 NewAPI 用户 ID，请稍后重试"}

    db = await get_db()
    try:
        ban_row = await db.execute_fetchall(
            "SELECT is_banned, ban_reason FROM user_profiles WHERE newapi_user_id = ?", (user_id,)
        )
        if ban_row and dict(ban_row[0]).get("is_banned"):
            reason = dict(ban_row[0]).get("ban_reason", "违规操作")
            return {"success": False, "message": f"账号已被封禁，原因：{reason}"}
    finally:
        await db.close()

    # 4. 签发本项目 token
    role = user_info.get("role", 0) if user_info else 0
    payload = {
        "id": user_id,
        "username": req.username,
        "role": role,
        "is_admin": is_admin(user_info) if user_info else False,
    }
    token = _sign_token(payload)

    return {
        "success": True,
        "token": token,
        "user": payload,
    }

@router.post("/verify")
async def verify_token_route(req: TokenCheckRequest):
    """验证本项目 token"""
    payload = _verify_token(req.token)
    if not payload:
        return {"success": False, "message": "Token 无效或已过期"}
    return {
        "success": True,
        "user": {
            "id": payload.get("id"),
            "username": payload.get("username"),
            "display_name": payload.get("username"),
            "role": payload.get("role", 0),
            "is_admin": payload.get("is_admin", False),
        }
    }

@router.post("/admin-login")
async def admin_login(req: LoginRequest):
    """管理后台独立登录（不走 NewAPI，直接匹配 config 中的管理员账号密码）"""
    cfg_user = get("admin.username", "")
    cfg_pass = get("admin.password", "")
    if not cfg_user or not cfg_pass:
        return {"success": False, "message": "管理员账号未配置"}
    if req.username != cfg_user or req.password != cfg_pass:
        return {"success": False, "message": "用户名或密码错误"}
    payload = {
        "id": -1,
        "username": req.username,
        "role": 100,
        "is_admin": True,
    }
    token = _sign_token(payload)
    return {
        "success": True,
        "token": token,
        "user": payload,
    }
