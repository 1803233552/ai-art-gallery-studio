"""桌面版后端入口。

该入口由 Tauri sidecar 启动：
- 将运行目录切到用户数据目录，避免把日志/数据库写进安装目录；
- 首次启动复制 config.desktop.yaml 为用户可写的 config.yaml；
- 启动 FastAPI/uvicorn，只监听本机地址。
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path


def _app_data_dir() -> Path:
    """返回桌面应用的用户数据目录。"""
    app_name = "AI Art Gallery Studio"
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / app_name
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / app_name
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / app_name


def _bundled_path(relative: str) -> Path:
    """兼容源码运行与 PyInstaller onefile 解包目录。"""
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    return root / relative


def _ensure_config(data_dir: Path) -> Path:
    config_path = data_dir / "config.yaml"
    if config_path.exists():
        return config_path

    template = _bundled_path("config.desktop.yaml")
    if not template.exists():
        template = _bundled_path("config_example.yaml")
    if not template.exists():
        raise FileNotFoundError("找不到桌面版默认配置 config.desktop.yaml")

    shutil.copyfile(template, config_path)
    return config_path


def main() -> None:
    parser = argparse.ArgumentParser(description="AI Art Gallery Studio desktop backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18100)
    args = parser.parse_args()

    data_dir = _app_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "data").mkdir(exist_ok=True)
    (data_dir / "logs").mkdir(exist_ok=True)

    config_path = _ensure_config(data_dir)
    os.environ["AI_STUDIO_CONFIG"] = str(config_path)
    os.environ["AI_STUDIO_DESKTOP"] = "1"

    # 让相对路径配置（./logs、./data/*.db 等）都落在用户数据目录。
    os.chdir(data_dir)

    import uvicorn
    from app.main import app

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        reload=False,
        log_config=None,
    )


if __name__ == "__main__":
    main()
