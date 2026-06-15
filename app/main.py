"""FastAPI 入口"""
import logging
import os
import sys
import time
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

import asyncio

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from app.config import load_config, get, resolve_path
from app.database import init_db
from app.routers import pages, auth, gallery, api_proxy, history, balance


_logging_done = False


class SizeAndTimeRotatingFileHandler(TimedRotatingFileHandler):
    """按天 + 按大小轮换，避免单日高频日志把 app.log 写到无限大。"""

    def __init__(self, *args, maxBytes: int = 0, maxFiles: int = 0, keepDays: int = 0, **kwargs):
        super().__init__(*args, **kwargs)
        self.maxBytes = max(0, int(maxBytes or 0))
        self.maxFiles = max(0, int(maxFiles or 0))
        self.keepDays = max(0, int(keepDays or 0))
        self._size_rollover = False

    def shouldRollover(self, record):
        if super().shouldRollover(record):
            self._size_rollover = False
            return 1

        if self.maxBytes > 0:
            if self.stream is None:
                self.stream = self._open()
            msg = f"{self.format(record)}\n"
            try:
                msg_len = len(msg.encode(self.encoding or "utf-8", "replace"))
            except LookupError:
                msg_len = len(msg)
            if self.stream.tell() + msg_len >= self.maxBytes:
                self._size_rollover = True
                return 1

        self._size_rollover = False
        return 0

    def doRollover(self):
        if not self._size_rollover:
            super().doRollover()
            self._cleanup_backups()
            return

        if self.stream:
            self.stream.close()
            self.stream = None

        if os.path.exists(self.baseFilename):
            if self.backupCount > 0:
                self.rotate(self.baseFilename, self._size_rollover_filename())
            else:
                open(self.baseFilename, "w", encoding=self.encoding or "utf-8").close()

        if not self.delay:
            self.stream = self._open()
        self._size_rollover = False
        self._cleanup_backups()

    def _size_rollover_filename(self) -> str:
        base = f"{self.baseFilename}.{time.strftime('%Y-%m-%d_%H-%M-%S')}.log"
        candidate = base
        seq = 1
        while os.path.exists(candidate):
            candidate = f"{base}.{seq}"
            seq += 1
        return candidate

    def _cleanup_backups(self) -> None:
        base = Path(self.baseFilename)
        backups = [p for p in base.parent.glob(f"{base.name}.*") if p.is_file()]
        if self.keepDays > 0:
            cutoff = time.time() - self.keepDays * 86400
            for path in list(backups):
                try:
                    if path.stat().st_mtime < cutoff:
                        path.unlink(missing_ok=True)
                except OSError:
                    pass

        if self.maxFiles > 0:
            backups = [p for p in base.parent.glob(f"{base.name}.*") if p.is_file()]
            backups.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
            for path in backups[self.maxFiles:]:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass

def setup_logging():
    """按天轮换日志，自动清理过期文件"""
    global _logging_done
    if _logging_done:
        return
    _logging_done = True

    log_dir = resolve_path(get("logging.dir", "./logs"))
    log_dir.mkdir(parents=True, exist_ok=True)
    level_name = get("logging.level", "INFO").upper()
    keep_days = int(get("logging.keep_days", 30))
    max_file_mb = max(1, int(get("logging.max_file_mb", 10)))
    max_files = max(1, int(get("logging.max_files", max(keep_days, 1))))
    level = getattr(logging, level_name, logging.INFO)

    fmt = logging.Formatter(
        "%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # 按天 + 按大小轮换的文件 handler
    file_handler = SizeAndTimeRotatingFileHandler(
        filename=str(log_dir / "app.log"),
        when="midnight",
        interval=1,
        backupCount=max_files,
        maxBytes=max_file_mb * 1024 * 1024,
        maxFiles=max_files,
        keepDays=keep_days,
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

    logging.info(
        "日志初始化完成 → %s (保留 %d 天, 单文件 %d MB, 最多 %d 个备份, 级别 %s)",
        log_dir, keep_days, max_file_mb, max_files, level_name,
    )


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
