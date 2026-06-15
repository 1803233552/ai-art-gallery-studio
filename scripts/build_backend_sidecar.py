from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_TAURI = ROOT / "src-tauri"
BIN_DIR = SRC_TAURI / "binaries"
BUILD_DIR = ROOT / "build" / "desktop"
SIDECAR_NAME = "ai-studio-backend"


def run(cmd: list[str], *, cwd: Path = ROOT) -> subprocess.CompletedProcess[str]:
    print("$", " ".join(cmd))
    return subprocess.run(cmd, cwd=cwd, check=True, text=True)


def capture(cmd: list[str], *, cwd: Path = ROOT) -> str:
    return subprocess.check_output(cmd, cwd=cwd, text=True).strip()


def host_triple() -> str:
    try:
        value = capture(["rustc", "--print", "host-tuple"])
        if value:
            return value
    except Exception:
        pass

    verbose = capture(["rustc", "-Vv"])
    for line in verbose.splitlines():
        if line.startswith("host:"):
            return line.split(":", 1)[1].strip()
    raise RuntimeError("无法获取 Rust target triple，请检查 rustc 是否可用")


def add_data_arg(source: Path, target: str) -> str:
    # PyInstaller 在 Windows 使用 ; 分隔，在其他平台使用 : 分隔。
    sep = ";" if sys.platform == "win32" else ":"
    return f"{source}{sep}{target}"


def main() -> None:
    triple = host_triple()
    extension = ".exe" if sys.platform == "win32" else ""
    target_binary = BIN_DIR / f"{SIDECAR_NAME}-{triple}{extension}"

    BIN_DIR.mkdir(parents=True, exist_ok=True)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    dist_dir = BUILD_DIR / "pyinstaller-dist"
    work_dir = BUILD_DIR / "pyinstaller-work"
    spec_dir = BUILD_DIR / "pyinstaller-spec"
    shutil.rmtree(dist_dir, ignore_errors=True)

    pyinstaller_cmd = [
        "uv", "run", "--with", "pyinstaller", "pyinstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name", SIDECAR_NAME,
        "--distpath", str(dist_dir),
        "--workpath", str(work_dir),
        "--specpath", str(spec_dir),
        "--add-data", add_data_arg(ROOT / "app" / "static", "app/static"),
        "--add-data", add_data_arg(ROOT / "app" / "templates", "app/templates"),
        "--add-data", add_data_arg(ROOT / "config.desktop.yaml", "."),
        "--collect-submodules", "uvicorn",
        "--collect-submodules", "app",
        "--hidden-import", "aiosqlite",
        "--hidden-import", "aiohttp",
        "--hidden-import", "jinja2.ext",
        "--hidden-import", "multipart",
        "--hidden-import", "yaml",
        # Pillow 的 AVIF 支持是可选能力，本项目不依赖。部分 Python/Pillow/PyInstaller
        # 组合在 onefile 启动解包 PIL._avif*.pyd 时会出现 zlib 解压失败，排除它可避免启动报错。
        "--exclude-module", "PIL._avif",
        "--exclude-module", "PIL.AvifImagePlugin",
        str(ROOT / "app" / "desktop_backend.py"),
    ]
    if sys.platform == "win32":
        pyinstaller_cmd.insert(pyinstaller_cmd.index("--onefile") + 1, "--noconsole")
    run(pyinstaller_cmd)

    built_binary = dist_dir / f"{SIDECAR_NAME}{extension}"
    if not built_binary.exists():
        raise FileNotFoundError(f"PyInstaller 未生成预期文件: {built_binary}")

    if target_binary.exists():
        target_binary.unlink()
    shutil.copy2(built_binary, target_binary)
    print(f"sidecar 已生成: {target_binary}")


if __name__ == "__main__":
    main()
