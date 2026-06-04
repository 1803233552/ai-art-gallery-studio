"""FastAPI 入口"""
import logging
import sys
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

import asyncio

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from app.config import load_config, get
from app.database import init_db
from app.routers import pages, auth, gallery, api_proxy, history, balance


_logging_done = False

def setup_logging():
    """按天轮换日志，自动清理过期文件"""
    global _logging_done
    if _logging_done:
        return
    _logging_done = True

    log_dir = Path(get("logging.dir", "./logs"))
    log_dir.mkdir(parents=True, exist_ok=True)
    level_name = get("logging.level", "INFO").upper()
    keep_days = int(get("logging.keep_days", 30))
    level = getattr(logging, level_name, logging.INFO)

    fmt = logging.Formatter(
        "%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # 按天轮换的文件 handler
    file_handler = TimedRotatingFileHandler(
        filename=str(log_dir / "app.log"),
        when="midnight",
        interval=1,
        backupCount=keep_days,
        encoding="utf-8",
    )
    file_handler.suffix = "%Y-%m-%d.log"
    file_handler.setLevel(level)
    file_handler.setFormatter(fmt)

    # 控制台 handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_handler.setFormatter(fmt)

    # 配置根 logger（先清理已有 handler，防止 reload 等场景下累积重复）
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(level)
    root.addHandler(file_handler)
    root.addHandler(console_handler)

    # uvicorn 的 logger 也接入
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uv_logger = logging.getLogger(name)
        uv_logger.handlers.clear()
        uv_logger.addHandler(file_handler)
        uv_logger.addHandler(console_handler)
        uv_logger.propagate = False

    logging.info("日志初始化完成 → %s (保留 %d 天, 级别 %s)", log_dir, keep_days, level_name)


def create_app() -> FastAPI:
    cfg = load_config()
    setup_logging()

    app = FastAPI(
        title="AI 创意工坊",
        docs_url=None,
        redoc_url=None,
    )

    # 静态文件
    static_dir = Path(__file__).parent / "static"
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    # 路由
    app.include_router(pages.router)
    app.include_router(auth.router)
    app.include_router(gallery.router)
    app.include_router(api_proxy.router)
    app.include_router(history.router)
    app.include_router(balance.router)

    @app.on_event("startup")
    async def startup():
        await init_db()
        # 启动后台历史清理任务
        asyncio.create_task(history.cleanup_loop())

    return app

app = create_app()

def run():
    uvicorn.run(
        "app.main:app",
        host=get("server.host", "0.0.0.0"),
        port=get("server.port", 8100),
        reload=get("server.debug", False),
        log_config=None,
    )

if __name__ == "__main__":
    run()
