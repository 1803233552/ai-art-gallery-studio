"""绘图历史 API — 已登录用户的绘图记录临时存储到服务器"""
import base64
import asyncio
import json
import logging
import os
import shutil
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


def _gen_filename(index: int, prefix: str = "img", suffix: str = ".png") -> str:
    """生成带 13 位时间戳 + 随机数 + 序号的文件名"""
    ts = int(time.time() * 1000)
    rnd = random.randint(1000, 9999)
    safe_suffix = suffix if suffix.startswith(".") else f".{suffix}"
    return f"{ts}_{rnd}_{prefix}_{index}{safe_suffix}"


def _safe_segment(value: str, fallback: str = "unknown") -> str:
    safe = "".join(c if c.isalnum() or c in ('_', '-') else '_' for c in str(value or ""))
    return safe or fallback


def _local_history_enabled(request: Request) -> bool:
    """桌面版/显式开启时允许无登录本机历史落盘。"""
    client_host = request.client.host if request.client else ""
    is_loopback = client_host in {"127.0.0.1", "::1", "localhost"}
    return is_loopback and (
        os.environ.get("AI_STUDIO_DESKTOP") == "1"
        or bool(get("history.local_file_store", False))
    )


def _require_local_history(request: Request) -> None:
    if not _local_history_enabled(request):
        raise HTTPException(403, "本地历史文件存储未开启")


def _local_root() -> Path:
    root = _storage() / "_local"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _local_manifest_path() -> Path:
    return _local_root() / "history.json"


def _local_batch_dir(batch_id: str) -> Path:
    path = _local_root() / _safe_segment(batch_id, "batch")
    path.mkdir(parents=True, exist_ok=True)
    return path


def _read_local_manifest() -> list[dict]:
    path = _local_manifest_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _write_local_manifest(items: list[dict]) -> None:
    _local_manifest_path().write_text(
        json.dumps(items, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _guess_suffix(source: str, img_bytes: bytes) -> str:
    if source.startswith("data:image/"):
        mime = source.split(";", 1)[0].split("/", 1)[1].lower()
        return ".jpg" if mime == "jpeg" else f".{mime}"
    if img_bytes.startswith(b"\xff\xd8"):
        return ".jpg"
    if img_bytes.startswith(b"\x89PNG"):
        return ".png"
    if img_bytes.startswith(b"RIFF") and img_bytes[8:12] == b"WEBP":
        return ".webp"
    if img_bytes.startswith(b"GIF"):
        return ".gif"
    return ".png"


def _decode_image_base64(value: str) -> bytes:
    raw = str(value or "").strip()
    if "," in raw and raw.startswith("data:image/"):
        raw = raw.split(",", 1)[1]
    raw = "".join(raw.split())
    try:
        return base64.b64decode(raw)
    except Exception:
        return base64.urlsafe_b64decode(raw)


async def _download_image_bytes(url: str, api_key: str = "") -> bytes | None:
    headers_list = [{}]
    if api_key:
        headers_list.append({"Authorization": f"Bearer {api_key}"})
    async with aiohttp.ClientSession() as session:
        for headers in headers_list:
            try:
                async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=60)) as resp:
                    if resp.status != 200:
                        continue
                    ct = resp.content_type or ""
                    if not (ct.startswith("image/") or ct == "application/octet-stream"):
                        continue
                    data = await resp.read()
                    if 0 < len(data) <= 20 * 1024 * 1024:
                        return data
            except aiohttp.ClientError:
                continue
    return None


async def _image_payload_to_bytes(item, api_key: str = "") -> tuple[bytes, str] | None:
    if isinstance(item, str):
        raw = item
        url = ""
    elif isinstance(item, dict):
        raw = item.get("b64_json") or item.get("data_url") or item.get("dataUrl") or item.get("image") or ""
        url = item.get("url") or ""
    else:
        return None

    if raw:
        try:
            data = _decode_image_base64(raw)
            return data, _guess_suffix(str(raw), data)
        except Exception:
            return None
    if url and url.startswith("data:image/"):
        try:
            data = _decode_image_base64(url)
            return data, _guess_suffix(url, data)
        except Exception:
            return None
    if url and url.startswith("http"):
        data = await _download_image_bytes(url, api_key)
        if data:
            return data, _guess_suffix(url, data)
    return None


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


# ---- 桌面/本机历史文件存储 ----
@router.post("/local/save")
async def save_local_batch(request: Request):
    """把本机历史图片落盘到 history.storage_path。保存输出图和输入参考图。"""
    _require_local_history(request)
    body = await request.json()
    batch_id = body.get("batch_id", "")
    model = body.get("model", "")
    prompt = body.get("prompt", "")
    batch_time = body.get("batch_time", "")
    params = body.get("params") if isinstance(body.get("params"), dict) else None
    images = body.get("images", [])
    ref_images = body.get("ref_images", []) or body.get("refImages", [])
    api_key = (body.get("api_key") or "").strip()

    if not batch_id:
        raise HTTPException(400, "缺少 batch_id")
    if not images and not ref_images:
        raise HTTPException(400, "缺少图片数据")

    batch_dir = _local_batch_dir(batch_id)
    saved_images = []
    saved_refs = []

    for i, img in enumerate(images):
        converted = await _image_payload_to_bytes(img, api_key)
        if not converted:
            continue
        img_bytes, suffix = converted
        filename = _gen_filename(i, "out", suffix)
        (batch_dir / filename).write_bytes(img_bytes)
        saved_images.append({"index": i, "filename": filename})

    for i, img in enumerate(ref_images):
        converted = await _image_payload_to_bytes(img, api_key)
        if not converted:
            continue
        img_bytes, suffix = converted
        filename = _gen_filename(i, "ref", suffix)
        (batch_dir / filename).write_bytes(img_bytes)
        saved_refs.append({"index": i, "filename": filename})

    if not saved_images and not saved_refs:
        shutil.rmtree(batch_dir, ignore_errors=True)
        log.warning("本机历史保存失败：没有可保存的图片 batch=%s images=%s refs=%s", batch_id, len(images), len(ref_images))
        raise HTTPException(400, "没有可保存的图片")

    items = [item for item in _read_local_manifest() if item.get("id") != batch_id]
    items.insert(0, {
        "id": batch_id,
        "model": model,
        "text": prompt,
        "time": batch_time,
        "params": params,
        "images": saved_images,
        "ref_images": saved_refs,
        "created_at": time.time(),
    })

    max_batches = int(get("history.local_max_batches", 200))
    removed = items[max_batches:]
    items = items[:max_batches]
    for old in removed:
        shutil.rmtree(_local_root() / _safe_segment(old.get("id", ""), "batch"), ignore_errors=True)
    _write_local_manifest(items)
    log.info("本机历史保存成功 batch=%s outputs=%s refs=%s dir=%s", batch_id, len(saved_images), len(saved_refs), batch_dir)
    return {"success": True, "saved": len(saved_images), "saved_refs": len(saved_refs)}


@router.get("/local/list")
async def list_local_history(request: Request):
    _require_local_history(request)
    return {"success": True, "data": _read_local_manifest()}


@router.get("/local/image/{batch_id}/{filename}")
async def get_local_history_image(batch_id: str, filename: str, request: Request):
    _require_local_history(request)
    safe_name = Path(filename).name
    filepath = _local_root() / _safe_segment(batch_id, "batch") / safe_name
    if not filepath.exists() or not filepath.is_file():
        raise HTTPException(404, "图片不存在")
    return FileResponse(filepath)


@router.delete("/local/image/{batch_id}/{image_index}")
async def delete_local_history_image(batch_id: str, image_index: int, request: Request):
    _require_local_history(request)
    items = _read_local_manifest()
    batch = next((item for item in items if item.get("id") == batch_id), None)
    if not batch:
        return {"success": True}

    images = batch.get("images") or []
    if 0 <= image_index < len(images):
        filename = Path(str(images[image_index].get("filename", ""))).name
        if filename:
            fp = _local_root() / _safe_segment(batch_id, "batch") / filename
            fp.unlink(missing_ok=True)
        images.pop(image_index)
        for idx, img in enumerate(images):
            img["index"] = idx
        batch["images"] = images
        _write_local_manifest(items)
    return {"success": True}


@router.delete("/local/batch/{batch_id}")
async def delete_local_batch(batch_id: str, request: Request):
    _require_local_history(request)
    items = [item for item in _read_local_manifest() if item.get("id") != batch_id]
    shutil.rmtree(_local_root() / _safe_segment(batch_id, "batch"), ignore_errors=True)
    _write_local_manifest(items)
    return {"success": True}


@router.delete("/local/clear")
async def clear_local_history(request: Request):
    _require_local_history(request)
    root = _local_root()
    for child in root.iterdir():
        if child.name == "history.json":
            continue
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)
    _write_local_manifest([])
    return {"success": True}


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
        last_error = None
        async with aiohttp.ClientSession() as session:
            for attempt in range(1, 4):
                try:
                    async with session.get(
                        url, headers=headers, timeout=aiohttp.ClientTimeout(total=60)
                    ) as resp:
                        return resp.status, resp.content_type or "image/png", await resp.read()
                except aiohttp.ClientError as e:
                    last_error = e
                    if attempt < 3:
                        await asyncio.sleep(1.5 * attempt)
                        continue
                    raise
        raise last_error or RuntimeError("下载失败")

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
