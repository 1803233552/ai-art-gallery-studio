"""桌面端本机密钥存储 API — Windows 使用 DPAPI 绑定当前用户加密。"""
import ctypes
import os
from ctypes import wintypes
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/desktop/secret", tags=["desktop-secret"])


class SecretRequest(BaseModel):
    api_key: str


class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
    ]


def _require_desktop_loopback(request: Request) -> None:
    client_host = request.client.host if request.client else ""
    if client_host not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(403, "仅允许本机访问")
    if os.environ.get("AI_STUDIO_DESKTOP") != "1":
        raise HTTPException(404, "桌面密钥存储未启用")


def _secret_path() -> Path:
    data_dir = Path(os.environ.get("AI_STUDIO_DESKTOP_DATA_DIR") or ".").resolve()
    path = data_dir / "data" / "secure" / "api_key.dpapi"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _dpapi_available() -> bool:
    return os.name == "nt"


def _blob_from_bytes(data: bytes):
    buf = ctypes.create_string_buffer(data)
    blob = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)))
    return blob, buf


def _protect(data: bytes) -> bytes:
    if not _dpapi_available():
        raise HTTPException(501, "当前系统不支持本机加密密钥存储")
    blob_in, keepalive = _blob_from_bytes(data)
    blob_out = DATA_BLOB()
    crypt32 = ctypes.windll.crypt32  # type: ignore[attr-defined]
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    ok = crypt32.CryptProtectData(
        ctypes.byref(blob_in),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(blob_out),
    )
    _ = keepalive
    if not ok:
        raise HTTPException(500, "API Key 加密失败")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def _unprotect(data: bytes) -> bytes:
    if not _dpapi_available():
        raise HTTPException(501, "当前系统不支持本机加密密钥存储")
    blob_in, keepalive = _blob_from_bytes(data)
    blob_out = DATA_BLOB()
    crypt32 = ctypes.windll.crypt32  # type: ignore[attr-defined]
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(blob_in),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(blob_out),
    )
    _ = keepalive
    if not ok:
        raise HTTPException(500, "API Key 解密失败")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


@router.get("/api-key")
async def get_api_key(request: Request):
    _require_desktop_loopback(request)
    path = _secret_path()
    if not path.exists():
        return {"success": True, "enabled": _dpapi_available(), "api_key": ""}
    data = _unprotect(path.read_bytes()).decode("utf-8")
    return {"success": True, "enabled": True, "api_key": data}


@router.post("/api-key")
async def save_api_key(req: SecretRequest, request: Request):
    _require_desktop_loopback(request)
    api_key = req.api_key.strip()
    if not api_key:
        _secret_path().unlink(missing_ok=True)
        return {"success": True, "enabled": _dpapi_available()}
    _secret_path().write_bytes(_protect(api_key.encode("utf-8")))
    return {"success": True, "enabled": True}


@router.delete("/api-key")
async def delete_api_key(request: Request):
    _require_desktop_loopback(request)
    _secret_path().unlink(missing_ok=True)
    return {"success": True, "enabled": _dpapi_available()}
