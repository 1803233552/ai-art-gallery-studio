"""桌面版后端入口。

该入口由 Tauri sidecar 启动：
- 将运行目录切到用户数据目录，避免把日志/数据库写进安装目录；
- 首次启动复制 config.desktop.yaml 为用户可写的 config.yaml；
- 启动 FastAPI/uvicorn，只监听本机地址。
"""
from __future__ import annotations

import argparse
import os
import re
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
        _ensure_desktop_history_defaults(config_path)
        return config_path

    template = _bundled_path("config.desktop.yaml")
    if not template.exists():
        template = _bundled_path("config_example.yaml")
    if not template.exists():
        raise FileNotFoundError("找不到桌面版默认配置 config.desktop.yaml")

    shutil.copyfile(template, config_path)
    _ensure_desktop_history_defaults(config_path)
    return config_path


def _ensure_desktop_history_defaults(config_path: Path) -> None:
    """给旧版首次生成的 config.yaml 补齐桌面本机历史配置。"""
    try:
        content = config_path.read_text(encoding="utf-8")
    except OSError:
        return

    needs_local_store = "local_file_store:" not in content
    needs_max_batches = "local_max_batches:" not in content
    if not needs_local_store and not needs_max_batches:
        return

    lines = content.splitlines()
    history_start = next((i for i, line in enumerate(lines) if re.match(r"^history:\s*$", line)), None)
    if history_start is None:
        lines.extend([
            "",
            "history:",
            "  enabled: true",
            "  storage_path: \"./data/history_images\"",
            "  local_file_store: true",
            "  local_max_batches: 200",
        ])
        try:
            config_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        except OSError:
            pass
        return

    history_end = len(lines)
    for i in range(history_start + 1, len(lines)):
        if lines[i] and not lines[i].startswith((" ", "\t")):
            history_end = i
            break

    insert_at = history_start + 1
    for i in range(history_start + 1, history_end):
        if re.match(r"^\s*storage_path\s*:", lines[i]):
            insert_at = i + 1
            break

    additions = []
    if needs_local_store:
        additions.append("  local_file_store: true")
    if needs_max_batches:
        additions.append("  local_max_batches: 200")
    lines[insert_at:insert_at] = additions
    try:
        config_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass


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
