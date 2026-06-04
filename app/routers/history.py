"""绘图历史 API — 已登录用户的绘图记录临时存储到服务器"""
import os
import uuid
import base64
import asyncio
import logging
import time
import random
from pathlib import Path
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import FileResponse
import aiohttp
from app.config import get
from app.database import get_db
from app.routers.auth import verify_user_token

router = APIRouter(prefix="/api/history", tags=["history"])
log = logging.getLogger(__name__)


def _storage() -> Path:
    p = Path(get("history.storage_path", "./data/history_images"))
    p.mkdir(parents=True, exist_ok=True)
    return p


def _user_dir(username: str) -> Path:
    """按用户名创建隔离目录"""
    # 安全化用户名：只保留字母数字下划线，防止路径注入
    safe = "".join(c if c.isalnum() or c in ('_', '-') else '_' for c in username)
    if not safe:
        safe = "unknown"
    d = _storage() / safe
    d.mkdir(parents=True, exist_ok=True)
    return d


def _max_images() -> int:
    return int(get("history.max_images_per_user", 500))


def _retention_sec() -> int:
    return int(get("history.retention_minutes", 14400)) * 60


def _cleanup_interval_sec() -> int:
    """清理任务遍历间隔（秒），默认 60 分钟"""
    return int(get("history.cleanup_interval_minutes", 60)) * 60


def _gen_filename(index: int) -> str:
    """生成带 13 位时间戳 + 随机数 + 序号的文件名"""
    ts = int(time.time() * 1000)
    rnd = random.randint(1000, 9999)
    return f"{ts}_{rnd}_{index}.png"


async def _auth(request: Request) -> dict:
    """从 Authorization header 或 URL query 的 token 参数中提取并验证用户"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        # <img> 标签无法携带 header，支持 ?token= 方式
        token = request.query_params.get("token", "")
    if not token:
        raise HTTPException(401, "未登录")
    user = await verify_user_token(token)
    if not user:
        raise HTTPException(401, "Token 无效")
    return user


# ---- 保存一个 batch ----
@router.post("/save")
async def save_batch(request: Request):
    user = await _auth(request)
    user_id = user["id"]
    username = user.get("username", str(user_id))
    body = await request.json()
    batch_id = body.get("batch_id", "")
    model = body.get("model", "")
    prompt = body.get("prompt", "")
    batch_time = body.get("batch_time", "")
    images = body.get("images", [])  # [{b64_json, url}]

    if not batch_id or not images:
        raise HTTPException(400, "缺少 batch_id 或 images")

    db = await get_db()
    try:
        # 检查数量限制
        cnt = await db.execute_fetchall(
            "SELECT COUNT(*) FROM user_history WHERE user_id = ?", (user_id,)
        )
        current = cnt[0][0] if cnt else 0
        max_img = _max_images()

        # 超限则删最旧的
        if current + len(images) > max_img:
            over = current + len(images) - max_img
            oldest = await db.execute_fetchall(
                "SELECT id, filename FROM user_history WHERE user_id = ? ORDER BY created_at ASC LIMIT ?",
                (user_id, over)
            )
            for row in oldest:
                r = dict(row)
                fp = _user_dir(username) / r["filename"]
                if fp.exists():
                    fp.unlink()
                await db.execute("DELETE FROM user_history WHERE id = ?", (r["id"],))

        saved = []
        # 计算过期时间
        retention = _retention_sec()
        for i, img in enumerate(images):
            raw = img.get("b64_json") or ""
            url = img.get("url") or ""
            if not raw and not url:
                continue

            filename = _gen_filename(i)
            filepath = _user_dir(username) / filename

            if raw:
                img_bytes = base64.b64decode(raw)
                with open(filepath, "wb") as f:
                    f.write(img_bytes)
            elif url and url.startswith("http"):
                # 外部 URL → 后端直接下载存为真正的图片文件
                try:
                    async with aiohttp.ClientSession() as session:
                        async with session.get(
                            url, timeout=aiohttp.ClientTimeout(total=30)
                        ) as resp:
                            if resp.status == 200:
                                img_bytes = await resp.read()
                                with open(filepath, "wb") as f:
                                    f.write(img_bytes)
                            else:
                                continue
                except Exception:
                    continue
            else:
                continue

            # 计算 expire_at 时间
            if get("database.type", "sqlite").lower() == "mysql":
                await db.execute(
                    """INSERT INTO user_history
                       (user_id, username, batch_id, image_index, model, prompt, filename, batch_time, expire_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL %s SECOND))""",
                    (user_id, username, batch_id, i, model, prompt, filename, batch_time, retention)
                )
            else:
                await db.execute(
                    """INSERT INTO user_history
                       (user_id, username, batch_id, image_index, model, prompt, filename, batch_time, expire_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))""",
                    (user_id, username, batch_id, i, model, prompt, filename, batch_time, f"+{retention} seconds")
                )
            saved.append(filename)

        await db.commit()
    finally:
        await db.close()

    return {"success": True, "saved": len(saved)}


# ---- 云缓存用量查询 ----
@router.get("/usage")
async def get_usage(request: Request):
    user = await _auth(request)
    user_id = user["id"]
    db = await get_db()
    try:
        cnt = await db.execute_fetchall(
            "SELECT COUNT(*) FROM user_history WHERE user_id = ?", (user_id,)
        )
        used = cnt[0][0] if cnt else 0
        max_img = _max_images()
        return {"success": True, "used": used, "max": max_img}
    finally:
        await db.close()


# ---- 获取历史列表（meta）----
@router.get("/list")
async def list_history(request: Request):
    user = await _auth(request)
    user_id = user["id"]
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            """SELECT batch_id, image_index, model, prompt, filename, batch_time, created_at
               FROM user_history WHERE user_id = ? ORDER BY created_at DESC""",
            (user_id,)
        )
        # 按 batch_id 分组
        batches = {}
        for r in rows:
            d = dict(r)
            bid = d["batch_id"]
            if bid not in batches:
                batches[bid] = {
                    "id": bid, "model": d["model"], "text": d["prompt"],
                    "time": d["batch_time"], "images": []
                }
            batches[bid]["images"].append({
                "index": d["image_index"], "filename": d["filename"]
            })
        result = list(batches.values())
        return {"success": True, "data": result}
    finally:
        await db.close()


# ---- 获取单张图片 ----
@router.get("/image/{username_path}/{filename}")
async def get_history_image(username_path: str, filename: str, request: Request):
    user = await _auth(request)
    if user.get("username", "") != username_path:
        raise HTTPException(403, "无权访问")
    filepath = _user_dir(username_path) / filename
    if not filepath.exists():
        raise HTTPException(404, "图片不存在")
    return FileResponse(filepath)


# ---- 后端代理下载外部图片转 base64（解决 CORS 问题）----
@router.post("/fetch-image")
async def fetch_image_as_base64(request: Request):
    """前端无法跨域下载的图片，通过后端代理下载并返回 base64
    支持透传 api_key 以访问需要鉴权的图片（如部分 API 服务器返回的文件 URL）"""
    body = await request.json()
    url = (body.get("url") or "").strip()
    if not url or not url.startswith("http"):
        raise HTTPException(400, "无效的图片 URL")

    api_key = (body.get("api_key") or "").strip()

    req_headers = {}
    if api_key:
        req_headers["Authorization"] = f"Bearer {api_key}"

    # 先不带鉴权尝试，若返回 401/403 则重试带鉴权
    async def _do_download(headers: dict):
        async with aiohttp.ClientSession() as session:
            async with session.get(
                url, headers=headers, timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                return resp.status, resp.content_type or "image/png", await resp.read()

    try:
        status, ct, data = await _do_download({})
        if status in (401, 403) and api_key:
            # 无鉴权被拒，重试带 api_key
            status, ct, data = await _do_download(req_headers)
        if status != 200:
            raise HTTPException(502, f"下载失败: HTTP {status}")
        # 允许 content-type 为 application/octet-stream（部分 API 服务以此返回图片）
        if not (ct.startswith("image/") or ct == "application/octet-stream"):
            raise HTTPException(400, "URL 不是图片")
        if len(data) > 20 * 1024 * 1024:
            raise HTTPException(400, "图片过大")
        b64 = base64.b64encode(data).decode()
        return {"success": True, "b64_json": b64}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"代理下载失败: {str(e)}")


# ---- 删除某个 batch ----
@router.delete("/batch/{batch_id}")
async def delete_batch(batch_id: str, request: Request):
    user = await _auth(request)
    user_id = user["id"]
    username = user.get("username", str(user_id))
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT filename FROM user_history WHERE user_id = ? AND batch_id = ?",
            (user_id, batch_id)
        )
        for r in rows:
            fp = _user_dir(username) / dict(r)["filename"]
            if fp.exists():
                fp.unlink()
        await db.execute(
            "DELETE FROM user_history WHERE user_id = ? AND batch_id = ?",
            (user_id, batch_id)
        )
        await db.commit()
    finally:
        await db.close()
    return {"success": True}


# ---- 删除单张图片 ----
@router.delete("/image/{batch_id}/{image_index}")
async def delete_single_image(batch_id: str, image_index: int, request: Request):
    """删除某个 batch 中的单张图片"""
    user = await _auth(request)
    user_id = user["id"]
    username = user.get("username", str(user_id))
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT id, filename FROM user_history WHERE user_id = ? AND batch_id = ? AND image_index = ?",
            (user_id, batch_id, image_index)
        )
        if rows:
            r = dict(rows[0])
            fp = _user_dir(username) / r["filename"]
            if fp.exists():
                fp.unlink()
            await db.execute("DELETE FROM user_history WHERE id = ?", (r["id"],))
            await db.commit()
    finally:
        await db.close()
    return {"success": True}


# ---- 清空历史 ----
@router.delete("/clear")
async def clear_history(request: Request):
    user = await _auth(request)
    user_id = user["id"]
    username = user.get("username", str(user_id))
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT filename FROM user_history WHERE user_id = ?", (user_id,)
        )
        for r in rows:
            fp = _user_dir(username) / dict(r)["filename"]
            if fp.exists():
                fp.unlink()
        await db.execute("DELETE FROM user_history WHERE user_id = ?", (user_id,))
        await db.commit()
    finally:
        await db.close()
    return {"success": True}


# ---- 定时清理过期数据 ----
async def cleanup_expired():
    """删除 expire_at 已到期的历史记录和文件"""
    db = await get_db()
    try:
        # 通过 expire_at 字段判断过期（精确遵守 config 中设定的保留时间）
        if get("database.type", "sqlite").lower() == "mysql":
            expired = await db.execute_fetchall(
                "SELECT id, username, filename FROM user_history WHERE expire_at IS NOT NULL AND expire_at < NOW()"
            )
        else:
            expired = await db.execute_fetchall(
                "SELECT id, username, filename FROM user_history WHERE expire_at IS NOT NULL AND expire_at < datetime('now')"
            )
        if not expired:
            return 0
        for r in expired:
            d = dict(r)
            uname = d.get("username") or "unknown"
            fp = _user_dir(uname) / d["filename"]
            if fp.exists():
                fp.unlink()
            await db.execute("DELETE FROM user_history WHERE id = ?", (d["id"],))
        await db.commit()
        return len(expired)
    except Exception as e:
        log.warning("清理历史失败: %s", e)
        return 0
    finally:
        await db.close()


async def cleanup_loop():
    """后台循环清理，间隔读取 config 中的 cleanup_interval_minutes"""
    while True:
        interval = _cleanup_interval_sec()
        await asyncio.sleep(interval)
        try:
            n = await cleanup_expired()
            if n:
                log.info("已清理 %d 条过期绘图历史", n)
        except Exception as e:
            log.warning("历史清理任务异常: %s", e)
