"""页面路由"""
import json
import time
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pathlib import Path
from app.config import get_config

router = APIRouter(tags=["pages"])
templates = Jinja2Templates(directory=str(Path(__file__).parent.parent / "templates"))
_CACHE_VER = str(int(time.time()))

def _site(cfg: dict) -> dict:
    """提取 site 配置"""
    s = cfg.get("site", {})
    return {
        "site_icon": s.get("icon", "✨"),
        "site_name": s.get("name", "浅夜の梦"),
        "site_titles": s.get("titles", {}),
    }

def _normalize_models(cfg: dict) -> list:
    """规范化 allowed_models 配置，兼容纯字符串和对象两种写法"""
    raw = cfg.get("allowed_models", [])
    if not raw:
        return []
    result = []
    for item in raw:
        if isinstance(item, str):
            result.append({
                "name": item,
                "ref_image": True,
                "endpoint": "images",
                "inject_ratio": True,
                "plain_content": False,
            })
        elif isinstance(item, dict):
            result.append({
                "name": item.get("name", ""),
                "ref_image": item.get("ref_image", True),
                "endpoint": item.get("endpoint", "images"),
                # inject_ratio: chat 模式是否在 prompt 里注入比例描述
                # 设为 false 时直接发原始 prompt（适合 grok 等自带尺寸能力的模型）
                "inject_ratio": item.get("inject_ratio", True),
                # plain_content: chat 模式 content 是否用纯字符串而非数组
                # 设为 true 时 content="prompt文字"（适合不接受数组格式的模型）
                "plain_content": item.get("plain_content", False),
            })
    return [m for m in result if m["name"]]

def _ctx(request: Request, page: str = "", **extra) -> dict:
    """构建模板上下文"""
    cfg = get_config()
    site = _site(cfg)
    ann = cfg.get("announcements", {})
    models_cfg = _normalize_models(cfg)
    return {
        **site,
        "api_nodes_json": json.dumps(cfg.get("api_nodes", {}), ensure_ascii=False),
        "allowed_models_json": json.dumps([m["name"] for m in models_cfg], ensure_ascii=False),
        "models_config_json": json.dumps({m["name"]: m for m in models_cfg}, ensure_ascii=False),
        "request_mode": cfg.get("request_mode", "frontend"),
        "gallery_enabled": cfg.get("gallery", {}).get("enabled", True),
        "history_server_enabled": cfg.get("history", {}).get("enabled", False),
        "page_title": site["site_titles"].get(page, "浅夜の梦"),
        "ann_enabled": ann.get("enabled", False),
        "ann_page": page,
        "cache_version": _CACHE_VER,
        **extra,
    }

@router.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(request, "home.html", _ctx(request, "home"))

@router.get("/docs", response_class=HTMLResponse)
async def docs_page(request: Request):
    return templates.TemplateResponse(request, "docs.html", _ctx(request, "docs"))

@router.get("/play", response_class=HTMLResponse)
async def playground(request: Request):
    return templates.TemplateResponse(request, "play.html", _ctx(request, "play"))

@router.get("/gallery", response_class=HTMLResponse)
async def gallery(request: Request):
    return templates.TemplateResponse(request, "gallery.html", _ctx(request, "gallery"))

@router.get("/gallery/image/{public_id}", response_class=HTMLResponse)
async def gallery_image_page(request: Request, public_id: int):
    """图片详情页"""
    return templates.TemplateResponse(request, "gallery.html", _ctx(request, "gallery", detail_id=public_id))

@router.get("/gallery/user/{username}", response_class=HTMLResponse)
async def gallery_user_page(request: Request, username: str):
    """用户主页"""
    return templates.TemplateResponse(request, "gallery.html", _ctx(request, "gallery", user_page=username))

@router.get("/admin", response_class=HTMLResponse)
@router.get("/{admin_path}", response_class=HTMLResponse)
async def admin(request: Request, admin_path: str = "admin"):
    """管理后台 — 支持自定义路径"""
    cfg = get_config()
    cfg_path = cfg.get("admin", {}).get("path", "/admin").strip("/")
    # 只匹配配置的路径
    actual = request.url.path.strip("/")
    if actual != cfg_path and actual != "admin":
        from fastapi.responses import RedirectResponse
        return RedirectResponse("/")
    return templates.TemplateResponse(request, "admin.html", _ctx(request, "admin"))

@router.get("/api/announcement")
async def get_announcement(page: str = "home"):
    """获取指定页面的公告内容（热更新：每次读取最新配置）"""
    from app.config import load_config
    cfg = load_config()  # 重新读取以支持热更新
    ann = cfg.get("announcements", {})
    if not ann.get("enabled", False):
        return {"enabled": False, "content": ""}
    content = ann.get(page, "")
    return {"enabled": True, "content": content.strip() if content else ""}
