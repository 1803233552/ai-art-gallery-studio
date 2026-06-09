"""图片广场 API 路由"""
import os
import uuid
import base64
import hashlib
import random
from pathlib import Path
from fastapi import APIRouter, Request, HTTPException, Form
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional
from app.config import get
from app.database import get_db
from app.routers.auth import verify_newapi_token, is_admin

router = APIRouter(prefix="/api/gallery", tags=["gallery"])

AVATAR_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.gif', '.webp')
BUILTIN_AVATAR_DIR = Path(__file__).resolve().parents[1] / "static" / "img" / "avatars"
LEGACY_AVATAR_DIR = Path("data/touxiang")

def get_storage_path() -> Path:
    p = Path(get("gallery.storage_path", "./gallery_images"))
    p.mkdir(parents=True, exist_ok=True)
    return p

def _quick_hash(data: bytes) -> str:
    """取前 8KB 快速哈希"""
    return hashlib.sha256(data[:8192]).hexdigest()[:32]

async def _next_public_id(db) -> int:
    rows = await db.execute_fetchall("SELECT MAX(public_id) FROM gallery_images")
    current = rows[0][0] if rows and rows[0][0] else 100000
    return current + 1

def _random_avatar(username: str = "") -> str:
    """基于用户名哈希从内置头像池确定性选取头像，保证同一用户始终分配同一头像"""
    files = []
    seen = set()
    for avatar_dir in (BUILTIN_AVATAR_DIR, LEGACY_AVATAR_DIR):
        if not avatar_dir.exists():
            continue
        for f in sorted(avatar_dir.iterdir(), key=lambda p: p.name):
            if f.is_file() and f.suffix.lower() in AVATAR_EXTENSIONS and f.name not in seen:
                files.append(f.name)
                seen.add(f.name)
    if files:
        idx = sum(ord(c) for c in (username or 'u')) % len(files)
        return f"/api/gallery/avatar/{files[idx]}"
    # 无头像文件时用字母兜底
    return f"/api/gallery/gen-avatar/{username or 'u'}"

# 预置颜色方案
_AVATAR_COLORS = [
    "#FF6B6B","#4ECDC4","#45B7D1","#96CEB4","#FFEAA7",
    "#DDA0DD","#FF8C42","#98D8C8","#6C5CE7","#FFA07A",
    "#87CEEB","#F0E68C","#E6B0AA","#82E0AA","#AED6F1",
]

@router.get("/gen-avatar/{name}")
async def gen_avatar(name: str):
    """根据用户名动态生成彩色字母头像 SVG"""
    from fastapi.responses import Response
    letter = (name[0] if name else "U").upper()
    h = sum(ord(c) for c in name) if name else 0
    color = _AVATAR_COLORS[h % len(_AVATAR_COLORS)]
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<circle cx="50" cy="50" r="50" fill="{color}"/>
<text x="50" y="54" text-anchor="middle" dominant-baseline="central"
  font-family="Arial,sans-serif" font-size="42" font-weight="700" fill="#fff">{letter}</text>
</svg>'''
    return Response(content=svg, media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=86400"})

@router.get("/avatar/{filename}")
async def get_avatar_file(filename: str):
    """获取内置默认头像文件（兼容旧 data/touxiang 目录）"""
    filepath = None
    for avatar_dir in (BUILTIN_AVATAR_DIR, LEGACY_AVATAR_DIR):
        candidate = avatar_dir / filename
        if candidate.exists() and candidate.is_file():
            filepath = candidate
            break
    if not filepath:
        raise HTTPException(404, "头像不存在")
    return FileResponse(filepath)

@router.get("/search")
async def search_images(
    q: str = "", scope: str = "all", page: int = 1, page_size: int = 24
):
    """搜索图片（scope: all/title/prompt）"""
    if not q.strip():
        return {"success": True, "data": [], "total": 0, "page": 1, "total_pages": 0}
    ps = page_size
    offset = (page - 1) * ps
    keyword = f"%{q.strip()}%"
    db = await get_db()
    try:
        if scope == "title":
            where = "WHERE is_public = 1 AND title LIKE ?"
            params = [keyword]
        elif scope == "prompt":
            where = "WHERE is_public = 1 AND prompt LIKE ?"
            params = [keyword]
        else:
            where = "WHERE is_public = 1 AND (title LIKE ? OR prompt LIKE ? OR model LIKE ? OR username LIKE ?)"
            params = [keyword, keyword, keyword, keyword]
        cnt = await db.execute_fetchall(f"SELECT COUNT(*) FROM gallery_images {where}", params)
        total = cnt[0][0] if cnt else 0
        rows = await db.execute_fetchall(
            f"SELECT * FROM gallery_images {where} ORDER BY likes_count DESC, created_at DESC LIMIT ? OFFSET ?",
            params + [ps, offset]
        )
        images = [dict(r) for r in rows]
        for img in images:
            img["url"] = f"/api/gallery/file/{img['filename']}"
            img["thumb_url"] = f"/api/gallery/file/{img.get('thumbnail') or img['filename']}"
        return {"success": True, "data": images, "total": total, "page": page, "total_pages": (total + ps - 1) // ps}
    finally:
        await db.close()

@router.get("/images")
async def list_images(
    page: int = 1,
    page_size: int | None = None,
    sort: str | None = None,
    user_id: int | None = None,
    include_private: bool = False,
):
    """获取图片列表（分页 + 排序）"""
    ps = page_size or get("gallery.page_size", 24)
    sort_by = sort or get("gallery.default_sort", "likes")
    offset = (page - 1) * ps
    order = "likes_count DESC, created_at DESC" if sort_by == "likes" else "created_at DESC"

    db = await get_db()
    try:
        conditions = []
        params: list = []
        if not include_private:
            conditions.append("is_public = 1")
        if user_id is not None:
            conditions.append("user_id = ?")
            params.append(user_id)
        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

        row = await db.execute_fetchall(
            f"SELECT COUNT(*) as cnt FROM gallery_images {where}", params
        )
        total = row[0][0] if row else 0
        rows = await db.execute_fetchall(
            f"SELECT * FROM gallery_images {where} ORDER BY {order} LIMIT ? OFFSET ?",
            params + [ps, offset]
        )
        images = [dict(r) for r in rows]
        # 批量补充用户头像
        user_ids = list(set(img.get("user_id") for img in images if img.get("user_id")))
        avatar_map = {}
        if user_ids:
            placeholders = ",".join(["?"] * len(user_ids))
            profiles = await db.execute_fetchall(
                f"SELECT newapi_user_id, avatar_url, nickname FROM user_profiles WHERE newapi_user_id IN ({placeholders})",
                user_ids
            )
            for p in profiles:
                pp = dict(p)
                avatar_map[pp.get("newapi_user_id")] = pp
        for img in images:
            img["url"] = f"/api/gallery/file/{img['filename']}"
            img["thumb_url"] = f"/api/gallery/file/{img.get('thumbnail') or img['filename']}"
            up = avatar_map.get(img.get("user_id"), {})
            img["avatar_url"] = up.get("avatar_url") or _random_avatar(img.get('username') or 'u')
            if up.get("nickname"):
                img["display_name"] = up["nickname"]
    finally:
        await db.close()
    return {"success": True, "data": images, "total": total, "page": page, "page_size": ps, "total_pages": (total + ps - 1) // ps}

@router.get("/file/{filename}")
async def get_image_file(filename: str):
    """获取图片文件"""
    filepath = get_storage_path() / filename
    if not filepath.exists():
        raise HTTPException(404, "图片不存在")
    return FileResponse(filepath)

@router.post("/upload")
async def upload_image(request: Request):
    """上传图片到广场（需登录，支持 JSON 和 Form）"""
    ct = request.headers.get("content-type", "")
    if "json" in ct:
        body = await request.json()
        image_data = body.get("image") or body.get("image_data", "")
        model = body.get("model", "")
        prompt = body.get("prompt", "")
        title = body.get("title", "")
        anonymous = body.get("anonymous", False)
        token = body.get("token", "") or request.headers.get("Authorization", "").replace("Bearer ", "")
    else:
        form = await request.form()
        image_data = form.get("image_data") or form.get("image", "")
        model = form.get("model", "")
        prompt = form.get("prompt", "")
        title = form.get("title", "")
        anonymous = form.get("anonymous", "false") == "true"
        token = form.get("token", "") or request.headers.get("Authorization", "").replace("Bearer ", "")

    # 强制登录
    if not token:
        raise HTTPException(401, "请先登录后再上传")
    user = await verify_newapi_token(token)
    if not user:
        raise HTTPException(401, "Token 无效，请重新登录")
    user_id = user.get("id")
    username = user.get("username", "")
    # 封禁检查
    db_check = await get_db()
    try:
        ban_row = await db_check.execute_fetchall(
            "SELECT is_banned, ban_reason FROM user_profiles WHERE newapi_user_id = ?", (user_id,)
        )
        if ban_row and dict(ban_row[0]).get("is_banned"):
            reason = dict(ban_row[0]).get("ban_reason", "违规操作")
            raise HTTPException(403, f"账号已被封禁：{reason}")
    finally:
        await db_check.close()
    # 匿名模式：不记录用户信息
    if anonymous:
        user_id = None
        username = ""

    # 解码 base64
    try:
        if image_data.startswith("data:"):
            _, data = image_data.split(",", 1)
        else:
            data = image_data
        img_bytes = base64.b64decode(data)
    except Exception:
        raise HTTPException(400, "图片数据无效")

    max_size = get("gallery.max_image_size", 10) * 1024 * 1024
    if len(img_bytes) > max_size:
        raise HTTPException(400, "图片过大")

    db = await get_db()
    try:
        # 每日上传限制
        daily_limit = get("gallery.daily_upload_limit", 50)
        if daily_limit > 0 and user_id:
            rows = await db.execute_fetchall(
                "SELECT COUNT(*) FROM gallery_images WHERE user_id = ? AND created_at >= date('now')",
                (user_id,)
            )
            today_count = rows[0][0] if rows else 0
            if today_count >= daily_limit:
                raise HTTPException(429, f"每日上传限制 {daily_limit} 张，今日已上传 {today_count} 张")

        # 图片去重（前 8KB 快速哈希）
        img_hash = _quick_hash(img_bytes)
        if get("gallery.dedup", True):
            dup = await db.execute_fetchall(
                "SELECT id, public_id FROM gallery_images WHERE image_hash = ?", (img_hash,)
            )
            if dup:
                raise HTTPException(409, f"图片已存在（作品 #{dup[0][1] or dup[0][0]}）")

        # 保存文件
        filename = f"{uuid.uuid4().hex}.png"
        filepath = get_storage_path() / filename
        with open(filepath, "wb") as f:
            f.write(img_bytes)

        # 获取尺寸
        width, height = 0, 0
        try:
            from PIL import Image
            with Image.open(filepath) as im:
                width, height = im.size
        except Exception:
            pass

        # 生成 public_id
        public_id = await _next_public_id(db)

        # 写入数据库
        await db.execute(
            """INSERT INTO gallery_images
               (public_id, user_id, username, model, prompt, title, filename, image_hash, width, height, file_size)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (public_id, user_id, username, model, prompt, title, filename, img_hash, width, height, len(img_bytes))
        )
        await db.commit()
    finally:
        await db.close()

    return {"success": True, "public_id": public_id, "filename": filename}

@router.post("/like/{image_id}")
async def toggle_like(image_id: int, request: Request):
    """点赞/取消点赞（IP + 浏览器指纹防刷）"""
    body = await request.json()
    fingerprint = body.get("fingerprint", "")
    if not fingerprint:
        raise HTTPException(400, "缺少浏览器指纹")

    ip = request.client.host if request.client else ""

    db = await get_db()
    try:
        # 检查是否已点赞
        existing = await db.execute_fetchall(
            "SELECT id FROM image_likes WHERE image_id = ? AND fingerprint = ?",
            (image_id, fingerprint)
        )
        if existing:
            await db.execute(
                "DELETE FROM image_likes WHERE image_id = ? AND fingerprint = ?",
                (image_id, fingerprint)
            )
            await db.execute(
                "UPDATE gallery_images SET likes_count = MAX(0, likes_count - 1) WHERE id = ?",
                (image_id,)
            )
            await db.commit()
            cnt = await db.execute_fetchall("SELECT likes_count FROM gallery_images WHERE id = ?", (image_id,))
            return {"success": True, "liked": False, "likes_count": cnt[0][0] if cnt else 0}
        else:
            await db.execute(
                "INSERT INTO image_likes (image_id, ip_address, fingerprint) VALUES (?, ?, ?)",
                (image_id, ip, fingerprint)
            )
            await db.execute(
                "UPDATE gallery_images SET likes_count = likes_count + 1 WHERE id = ?",
                (image_id,)
            )
            await db.commit()
            cnt = await db.execute_fetchall("SELECT likes_count FROM gallery_images WHERE id = ?", (image_id,))
            return {"success": True, "liked": True, "likes_count": cnt[0][0] if cnt else 0}
    finally:
        await db.close()

@router.get("/liked")
async def get_liked_images(request: Request, fingerprint: str = ""):
    """获取当前用户已点赞的图片ID列表"""
    if not fingerprint:
        return {"success": True, "liked_ids": []}
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT image_id FROM image_likes WHERE fingerprint = ?",
            (fingerprint,)
        )
        return {"success": True, "liked_ids": [r[0] for r in rows]}
    finally:
        await db.close()

@router.post("/view/{image_id}")
async def record_view(image_id: int):
    """记录一次真实作品浏览：打开作品弹窗或详情页时计数。"""
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT id FROM gallery_images WHERE id = ? AND is_public = 1",
            (image_id,)
        )
        if not rows:
            raise HTTPException(404, "图片不存在")
        await db.execute(
            "UPDATE gallery_images SET view_count = view_count + 1 WHERE id = ?",
            (image_id,)
        )
        await db.commit()
        cnt = await db.execute_fetchall(
            "SELECT view_count FROM gallery_images WHERE id = ?",
            (image_id,)
        )
        return {"success": True, "view_count": cnt[0][0] if cnt else 0}
    finally:
        await db.close()

@router.delete("/admin/image/{image_id}")
async def admin_delete_image(image_id: int, request: Request):
    """管理员删除图片"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(401, "未登录")
    user = await verify_newapi_token(token)
    if not user or not is_admin(user):
        raise HTTPException(403, "无管理权限")

    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT filename, thumbnail FROM gallery_images WHERE id = ?", (image_id,)
        )
        if not rows:
            raise HTTPException(404, "图片不存在")

        img = dict(rows[0])
        # 删除文件
        storage = get_storage_path()
        for key in ("filename", "thumbnail"):
            if img.get(key):
                fp = storage / img[key]
                if fp.exists():
                    fp.unlink()

        await db.execute("DELETE FROM image_likes WHERE image_id = ?", (image_id,))
        await db.execute("DELETE FROM gallery_images WHERE id = ?", (image_id,))
        await db.commit()
    finally:
        await db.close()

    return {"success": True}

@router.get("/admin/images")
async def admin_list_images(
    request: Request,
    page: int = 1,
    page_size: int = 30,
    q: str = "",
):
    """管理员获取所有图片（含用户信息，支持搜索）"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(401, "未登录")
    user = await verify_newapi_token(token)
    if not user or not is_admin(user):
        raise HTTPException(403, "无管理权限")

    offset = (page - 1) * page_size
    db = await get_db()
    try:
        if q.strip():
            keyword = f"%{q.strip()}%"
            where = "WHERE public_id LIKE ? OR username LIKE ? OR prompt LIKE ? OR model LIKE ? OR title LIKE ?"
            params = [keyword, keyword, keyword, keyword, keyword]
            row = await db.execute_fetchall(f"SELECT COUNT(*) FROM gallery_images {where}", params)
            total = row[0][0] if row else 0
            rows = await db.execute_fetchall(
                f"SELECT * FROM gallery_images {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
                params + [page_size, offset]
            )
        else:
            row = await db.execute_fetchall("SELECT COUNT(*) FROM gallery_images")
            total = row[0][0] if row else 0
            rows = await db.execute_fetchall(
                "SELECT * FROM gallery_images ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (page_size, offset)
            )
        images = [dict(r) for r in rows]
        for img in images:
            img["url"] = f"/api/gallery/file/{img['filename']}"
    finally:
        await db.close()

    return {
        "success": True,
        "data": images,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": (total + page_size - 1) // page_size,
    }

@router.get("/my")
async def my_images(request: Request, page: int = 1, page_size: int = 24):
    """获取当前登录用户的图片"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(401, "未登录")
    user = await verify_newapi_token(token)
    if not user:
        raise HTTPException(401, "Token 无效")
    return await list_images(page=page, page_size=page_size, user_id=user.get("id"), include_private=True)

# ============================================================
# 评论系统
# ============================================================
@router.get("/comments/{image_id}")
async def get_comments(image_id: int, page: int = 1, page_size: int = 50, sort: str = "newest"):
    """获取图片评论（置顶在前按ID正序，非置顶按 sort 排序：newest/likes）"""
    offset = (page - 1) * page_size
    if sort == "likes":
        order = "is_pinned DESC, CASE WHEN is_pinned = 1 THEN id END ASC, likes_count DESC, created_at DESC"
    else:
        order = "is_pinned DESC, CASE WHEN is_pinned = 1 THEN id END ASC, created_at DESC"
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            f"SELECT * FROM image_comments WHERE image_id = ? ORDER BY {order} LIMIT ? OFFSET ?",
            (image_id, page_size, offset)
        )
        total_rows = await db.execute_fetchall(
            "SELECT COUNT(*) FROM image_comments WHERE image_id = ?", (image_id,)
        )
        total = total_rows[0][0] if total_rows else 0
        comments = [dict(r) for r in rows]
        for c in comments:
            if not c.get("avatar_url"):
                c["avatar_url"] = _random_avatar(c.get('username') or 'u')
        return {"success": True, "data": comments, "total": total}
    finally:
        await db.close()

@router.post("/comments/{image_id}")
async def add_comment(image_id: int, request: Request):
    """添加评论（需登录）"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(401, "请先登录")
    user = await verify_newapi_token(token)
    if not user:
        raise HTTPException(401, "Token 无效")

    body = await request.json()
    content = (body.get("content") or "").strip()
    if not content:
        raise HTTPException(400, "评论内容不能为空")
    if len(content) > 500:
        raise HTTPException(400, "评论内容过长（最多500字）")

    user_id = user.get("id")
    username = user.get("username", "")

    db = await get_db()
    try:
        # 每日评论限制
        limit = get("gallery.daily_comment_limit", 100)
        if limit > 0:
            rows = await db.execute_fetchall(
                "SELECT COUNT(*) FROM image_comments WHERE user_id = ? AND created_at >= date('now')",
                (user_id,)
            )
            if rows and rows[0][0] >= limit:
                raise HTTPException(429, f"每日评论限制 {limit} 条")

        # 获取用户资料
        profile = await db.execute_fetchall(
            "SELECT nickname, avatar_url FROM user_profiles WHERE newapi_user_id = ?",
            (user_id,)
        )
        nickname = profile[0][0] if profile else username
        avatar = (profile[0][1] if profile else "") or _random_avatar(username or 'u')

        await db.execute(
            """INSERT INTO image_comments (image_id, user_id, username, nickname, avatar_url, content)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (image_id, user_id, username, nickname, avatar, content)
        )
        await db.execute(
            "UPDATE gallery_images SET comments_count = comments_count + 1 WHERE id = ?",
            (image_id,)
        )
        await db.commit()
        return {"success": True}
    finally:
        await db.close()

# ============================================================
# 用户资料
# ============================================================
@router.get("/profile")
async def get_profile(request: Request):
    """获取当前用户资料"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(401, "未登录")
    user = await verify_newapi_token(token)
    if not user:
        raise HTTPException(401, "Token 无效")

    user_id = user.get("id")
    username = user.get("username", "")

    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT * FROM user_profiles WHERE newapi_user_id = ?", (user_id,)
        )
        if rows:
            p = dict(rows[0])
            # 如果没有头像，分配默认头像并持久化
            if not p.get("avatar_url"):
                p["avatar_url"] = _random_avatar(username)
                await db.execute(
                    "UPDATE user_profiles SET avatar_url = ? WHERE newapi_user_id = ?",
                    (p["avatar_url"], user_id)
                )
                await db.commit()
        else:
            # 自动创建资料 + 分配随机默认头像
            avatar = _random_avatar(username)
            await db.execute(
                "INSERT INTO user_profiles (newapi_user_id, username, nickname, avatar_url) VALUES (?, ?, ?, ?)",
                (user_id, username, username, avatar)
            )
            await db.commit()
            p = {"newapi_user_id": user_id, "username": username, "nickname": username, "avatar_url": avatar}

        # 统计
        stats = await db.execute_fetchall(
            "SELECT COUNT(*) as cnt, COALESCE(SUM(likes_count),0) as likes FROM gallery_images WHERE user_id = ?",
            (user_id,)
        )
        p["total_images"] = stats[0][0] if stats else 0
        p["total_likes"] = stats[0][1] if stats else 0

        return {"success": True, "data": p}
    finally:
        await db.close()

@router.put("/profile")
async def update_profile(request: Request):
    """更新用户资料（昵称、头像）"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(401, "未登录")
    user = await verify_newapi_token(token)
    if not user:
        raise HTTPException(401, "Token 无效")

    body = await request.json()
    user_id = user.get("id")
    username = user.get("username", "")
    nickname = (body.get("nickname") or username).strip()[:50]
    avatar_url = (body.get("avatar_url") or "").strip()[:500]
    bio = (body.get("bio") or "").strip()[:200]

    db = await get_db()
    try:
        existing = await db.execute_fetchall(
            "SELECT id FROM user_profiles WHERE newapi_user_id = ?", (user_id,)
        )
        if existing:
            await db.execute(
                "UPDATE user_profiles SET nickname = ?, avatar_url = ?, bio = ? WHERE newapi_user_id = ?",
                (nickname, avatar_url, bio, user_id)
            )
        else:
            await db.execute(
                "INSERT INTO user_profiles (newapi_user_id, username, nickname, avatar_url) VALUES (?, ?, ?, ?)",
                (user_id, username, nickname, avatar_url)
            )
        await db.commit()
        return {"success": True}
    finally:
        await db.close()


# ============================================================
# 图片详情 + 用户图片管理
# ============================================================
@router.get("/detail/{public_id}")
async def image_detail(public_id: int):
    """获取图片详情（+1 访问次数）"""
    db = await get_db()
    try:
        await db.execute("UPDATE gallery_images SET view_count = view_count + 1 WHERE public_id = ?", (public_id,))
        await db.commit()
        rows = await db.execute_fetchall("SELECT * FROM gallery_images WHERE public_id = ?", (public_id,))
        if not rows:
            raise HTTPException(404, "图片不存在")
        img = dict(rows[0])
        img["url"] = f"/api/gallery/file/{img['filename']}"
        img["thumb_url"] = f"/api/gallery/file/{img.get('thumbnail') or img['filename']}"
        # 补充作者头像
        if img.get("user_id"):
            up = await db.execute_fetchall(
                "SELECT avatar_url, nickname FROM user_profiles WHERE newapi_user_id = ?", (img["user_id"],)
            )
            if up:
                img["avatar_url"] = dict(up[0]).get("avatar_url") or _random_avatar(img.get('username') or 'u')
        return {"success": True, "data": img}
    finally:
        await db.close()

@router.get("/user/{username}")
async def user_gallery(username: str, page: int = 1, page_size: int = 24, sort: str = "newest"):
    """获取某用户的公开图片"""
    ps = page_size
    offset = (page - 1) * ps
    order = "created_at DESC" if sort == "newest" else "likes_count DESC, created_at DESC"
    db = await get_db()
    try:
        # 用户资料
        profile_rows = await db.execute_fetchall(
            "SELECT * FROM user_profiles WHERE username = ?", (username,)
        )
        profile = dict(profile_rows[0]) if profile_rows else {"username": username, "nickname": username, "avatar_url": _random_avatar(username)}
        if not profile.get("avatar_url"):
            profile["avatar_url"] = _random_avatar(username)

        row = await db.execute_fetchall(
            "SELECT COUNT(*) FROM gallery_images WHERE username = ? AND is_public = 1", (username,)
        )
        total = row[0][0] if row else 0
        rows = await db.execute_fetchall(
            f"SELECT * FROM gallery_images WHERE username = ? AND is_public = 1 ORDER BY {order} LIMIT ? OFFSET ?",
            (username, ps, offset)
        )
        images = [dict(r) for r in rows]
        for img in images:
            img["url"] = f"/api/gallery/file/{img['filename']}"
            img["thumb_url"] = f"/api/gallery/file/{img.get('thumbnail') or img['filename']}"

        stats = await db.execute_fetchall(
            "SELECT COALESCE(SUM(likes_count),0) FROM gallery_images WHERE username = ? AND is_public = 1", (username,)
        )
        profile["total_images"] = total
        profile["total_likes"] = stats[0][0] if stats else 0

        return {"success": True, "profile": profile, "data": images, "total": total, "page": page, "total_pages": (total + ps - 1) // ps}
    finally:
        await db.close()

@router.post("/my/delete/{image_id}")
async def my_delete_image(image_id: int, request: Request):
    """用户删除自己的图片"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(401, "未登录")
    user = await verify_newapi_token(token)
    if not user:
        raise HTTPException(401, "Token 无效")
    user_id = user.get("id")

    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT filename, thumbnail, user_id FROM gallery_images WHERE id = ?", (image_id,)
        )
        if not rows:
            raise HTTPException(404, "图片不存在")
        img = dict(rows[0])
        if img.get("user_id") != user_id:
            raise HTTPException(403, "只能删除自己的图片")
        # 删除文件
        storage = get_storage_path()
        for key in ("filename", "thumbnail"):
            if img.get(key):
                fp = storage / img[key]
                if fp.exists():
                    fp.unlink()
        await db.execute("DELETE FROM image_comments WHERE image_id = ?", (image_id,))
        await db.execute("DELETE FROM image_likes WHERE image_id = ?", (image_id,))
        await db.execute("DELETE FROM gallery_images WHERE id = ?", (image_id,))
        await db.commit()
        return {"success": True}
    finally:
        await db.close()

@router.post("/my/visibility/{image_id}")
async def my_toggle_visibility(image_id: int, request: Request):
    """用户切换图片公开/隐藏"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(401, "未登录")
    user = await verify_newapi_token(token)
    if not user:
        raise HTTPException(401, "Token 无效")
    user_id = user.get("id")

    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT user_id, is_public FROM gallery_images WHERE id = ?", (image_id,)
        )
        if not rows:
            raise HTTPException(404, "图片不存在")
        if dict(rows[0]).get("user_id") != user_id:
            raise HTTPException(403, "只能管理自己的图片")
        new_val = 0 if dict(rows[0]).get("is_public", 1) else 1
        await db.execute("UPDATE gallery_images SET is_public = ? WHERE id = ?", (new_val, image_id))
        await db.commit()
        return {"success": True, "is_public": new_val}
    finally:
        await db.close()

@router.post("/my/title/{image_id}")
async def my_update_title(image_id: int, request: Request):
    """用户修改自己图片的标题"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(401, "未登录")
    user = await verify_newapi_token(token)
    if not user:
        raise HTTPException(401, "Token 无效")
    user_id = user.get("id")
    body = await request.json()
    title = (body.get("title") or "").strip()
    if len(title) > 100:
        raise HTTPException(400, "标题过长（最多100字）")
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT user_id FROM gallery_images WHERE id = ?", (image_id,)
        )
        if not rows:
            raise HTTPException(404, "图片不存在")
        if dict(rows[0]).get("user_id") != user_id:
            raise HTTPException(403, "只能修改自己的图片")
        await db.execute("UPDATE gallery_images SET title = ? WHERE id = ?", (title, image_id))
        await db.commit()
        return {"success": True, "title": title}
    finally:
        await db.close()

# ============================================================
# 评论管理（点赞/置顶/删除）
# ============================================================
@router.post("/comment/like/{comment_id}")
async def like_comment(comment_id: int, request: Request):
    """评论点赞/取消点赞（IP+指纹防刷）"""
    body = await request.json()
    fingerprint = body.get("fingerprint", "")
    if not fingerprint:
        raise HTTPException(400, "缺少指纹")

    db = await get_db()
    try:
        existing = await db.execute_fetchall(
            "SELECT id FROM comment_likes WHERE comment_id = ? AND fingerprint = ?",
            (comment_id, fingerprint)
        )
        if existing:
            # 取消点赞
            await db.execute("DELETE FROM comment_likes WHERE comment_id = ? AND fingerprint = ?", (comment_id, fingerprint))
            await db.execute("UPDATE image_comments SET likes_count = MAX(0, likes_count - 1) WHERE id = ?", (comment_id,))
            await db.commit()
            cnt = await db.execute_fetchall("SELECT likes_count FROM image_comments WHERE id = ?", (comment_id,))
            return {"success": True, "liked": False, "likes_count": cnt[0][0] if cnt else 0}
        else:
            # 点赞
            await db.execute("INSERT INTO comment_likes (comment_id, fingerprint) VALUES (?, ?)", (comment_id, fingerprint))
            await db.execute("UPDATE image_comments SET likes_count = likes_count + 1 WHERE id = ?", (comment_id,))
            await db.commit()
            cnt = await db.execute_fetchall("SELECT likes_count FROM image_comments WHERE id = ?", (comment_id,))
            return {"success": True, "liked": True, "likes_count": cnt[0][0] if cnt else 0}
    finally:
        await db.close()

@router.post("/comment/pin/{comment_id}")
async def pin_comment(comment_id: int, request: Request):
    """作品所有者或管理员置顶/取消置顶评论"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(401, "未登录")
    user = await verify_newapi_token(token)
    if not user:
        raise HTTPException(401, "Token 无效")
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT c.is_pinned, g.user_id FROM image_comments c JOIN gallery_images g ON c.image_id = g.id WHERE c.id = ?",
            (comment_id,)
        )
        if not rows:
            raise HTTPException(404, "评论不存在")
        if dict(rows[0]).get("user_id") != user.get("id") and not is_admin(user):
            raise HTTPException(403, "只有作品所有者或管理员可以置顶评论")
        new_val = 0 if dict(rows[0]).get("is_pinned", 0) else 1
        await db.execute("UPDATE image_comments SET is_pinned = ? WHERE id = ?", (new_val, comment_id))
        await db.commit()
        return {"success": True, "is_pinned": new_val}
    finally:
        await db.close()

@router.post("/comment/delete/{comment_id}")
async def delete_comment(comment_id: int, request: Request):
    """作品所有者、评论者本人或管理员删除评论"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(401, "未登录")
    user = await verify_newapi_token(token)
    if not user:
        raise HTTPException(401, "Token 无效")
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT c.image_id, c.user_id as comment_user_id, g.user_id as owner_user_id FROM image_comments c JOIN gallery_images g ON c.image_id = g.id WHERE c.id = ?",
            (comment_id,)
        )
        if not rows:
            raise HTTPException(404, "评论不存在")
        r = dict(rows[0])
        # 作品所有者、评论者本人或管理员可删
        uid = user.get("id")
        if r.get("owner_user_id") != uid and r.get("comment_user_id") != uid and not is_admin(user):
            raise HTTPException(403, "无权删除")
        await db.execute("DELETE FROM image_comments WHERE id = ?", (comment_id,))
        await db.execute("UPDATE gallery_images SET comments_count = MAX(0, comments_count - 1) WHERE id = ?", (r["image_id"],))
        await db.commit()
        return {"success": True}
    finally:
        await db.close()

# ============================================================
# 管理员：用户管理
# ============================================================
@router.get("/admin/users")
async def admin_list_users(request: Request, page: int = 1, page_size: int = 30, q: str = ""):
    """管理员获取用户列表（支持搜索）"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token: raise HTTPException(401, "未登录")
    user = await verify_newapi_token(token)
    if not user or not is_admin(user): raise HTTPException(403, "无管理权限")
    offset = (page - 1) * page_size
    db = await get_db()
    try:
        if q.strip():
            keyword = f"%{q.strip()}%"
            where = "WHERE username LIKE ? OR nickname LIKE ? OR CAST(newapi_user_id AS TEXT) LIKE ?"
            params = [keyword, keyword, keyword]
            cnt = await db.execute_fetchall(f"SELECT COUNT(*) FROM user_profiles {where}", params)
            total = cnt[0][0] if cnt else 0
            rows = await db.execute_fetchall(
                f"SELECT * FROM user_profiles {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
                params + [page_size, offset]
            )
        else:
            cnt = await db.execute_fetchall("SELECT COUNT(*) FROM user_profiles")
            total = cnt[0][0] if cnt else 0
            rows = await db.execute_fetchall(
                "SELECT * FROM user_profiles ORDER BY created_at DESC LIMIT ? OFFSET ?", (page_size, offset)
            )
        users = [dict(r) for r in rows]
        return {"success": True, "data": users, "total": total, "page": page, "total_pages": (total + page_size - 1) // page_size}
    finally:
        await db.close()

@router.post("/admin/ban/{user_id}")
async def admin_ban_user(user_id: int, request: Request):
    """封禁用户"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token: raise HTTPException(401, "未登录")
    user = await verify_newapi_token(token)
    if not user or not is_admin(user): raise HTTPException(403, "无管理权限")
    body = await request.json()
    reason = body.get("reason", "违规操作")
    db = await get_db()
    try:
        await db.execute("UPDATE user_profiles SET is_banned = 1, ban_reason = ? WHERE newapi_user_id = ?", (reason, user_id))
        await db.commit()
        return {"success": True}
    finally:
        await db.close()

@router.post("/admin/unban/{user_id}")
async def admin_unban_user(user_id: int, request: Request):
    """解封用户"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token: raise HTTPException(401, "未登录")
    user = await verify_newapi_token(token)
    if not user or not is_admin(user): raise HTTPException(403, "无管理权限")
    db = await get_db()
    try:
        await db.execute("UPDATE user_profiles SET is_banned = 0, ban_reason = '' WHERE newapi_user_id = ?", (user_id,))
        await db.commit()
        return {"success": True}
    finally:
        await db.close()

@router.post("/admin/delete-comment/{comment_id}")
async def admin_delete_comment(comment_id: int, request: Request):
    """管理员删除评论"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token: raise HTTPException(401, "未登录")
    user = await verify_newapi_token(token)
    if not user or not is_admin(user): raise HTTPException(403, "无管理权限")
    db = await get_db()
    try:
        rows = await db.execute_fetchall("SELECT image_id FROM image_comments WHERE id = ?", (comment_id,))
        if rows:
            await db.execute("DELETE FROM image_comments WHERE id = ?", (comment_id,))
            await db.execute("UPDATE gallery_images SET comments_count = MAX(0, comments_count - 1) WHERE id = ?", (dict(rows[0])["image_id"],))
            await db.commit()
        return {"success": True}
    finally:
        await db.close()
