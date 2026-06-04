"""YAML 配置加载"""
import os
import secrets
import yaml
from pathlib import Path
from typing import Any

_config: dict = {}
_config_path: str = ""

def load_config(config_path: str | None = None) -> dict:
    """加载 YAML 配置文件，首次启动自动生成 secret_key"""
    global _config, _config_path
    if config_path is None:
        config_path = os.environ.get(
            "AI_STUDIO_CONFIG",
            str(Path(__file__).parent.parent / "config.yaml")
        )
    _config_path = config_path
    with open(config_path, "r", encoding="utf-8") as f:
        _config = yaml.safe_load(f) or {}

    # 自动生成 secret_key
    if not _config.get("secret_key"):
        _config["secret_key"] = secrets.token_hex(32)
        _save_config()

    return _config

def _save_config():
    """将 secret_key 追加写入 YAML 文件（保持原始格式不变）"""
    if not _config_path or not _config.get("secret_key"):
        return
    with open(_config_path, "r", encoding="utf-8") as f:
        content = f.read()
    key = _config["secret_key"]
    # 如果文件中已有 secret_key 行则替换，否则追加
    import re
    if re.search(r'^secret_key\s*:', content, re.MULTILINE):
        content = re.sub(r'^secret_key\s*:.*$', f'secret_key: "{key}"', content, flags=re.MULTILINE)
    else:
        content = content.rstrip() + f'\n\n# secret_key（自动生成，请勿手动删除）\nsecret_key: "{key}"\n'
    with open(_config_path, "w", encoding="utf-8") as f:
        f.write(content)

def get_config() -> dict:
    """获取已加载的配置"""
    if not _config:
        load_config()
    return _config

def get(key: str, default: Any = None) -> Any:
    """点分路径获取配置值，如 'server.port'"""
    cfg = get_config()
    keys = key.split(".")
    for k in keys:
        if isinstance(cfg, dict):
            cfg = cfg.get(k, default)
        else:
            return default
    return cfg
