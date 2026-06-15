# Tauri 桌面打包说明

这个项目本体是 FastAPI + Jinja2 页面。桌面版采用 Tauri 作为壳，启动时拉起一个本机 FastAPI sidecar，然后窗口打开 `http://127.0.0.1:18100/play`。

## 结构

- `src-tauri/`：Tauri v2 壳工程。
- `app/desktop_backend.py`：桌面版 Python 后端入口。
- `config.desktop.yaml`：桌面版默认配置，首次启动会复制到用户数据目录。
- `scripts/build_backend_sidecar.py`：用 PyInstaller 构建后端 sidecar，并按 Tauri 要求添加 target triple 后缀。

## 开发运行

```powershell
npm install
npm run desktop:dev
```

## 构建安装包

```powershell
npm install
npm run desktop:build
```

Windows 产物一般位于：

```text
src-tauri/target/release/bundle/nsis/
```

## 用户数据目录

桌面版优先把配置、数据库、日志和本机图片历史写入安装目录。Windows 下通常类似：

```text
<安装目录>\
```

其中本机图片历史默认位于：

```text
<安装目录>\data\history_images\_local\output\
```

如果安装目录不可写（例如安装到受保护的 `Program Files`），会自动回退到用户数据目录：

```text
%APPDATA%\AI Art Gallery Studio\
```

首次启动会生成或迁移：

- `config.yaml`
- `data/`
- `logs/`

旧版本已写入 `%APPDATA%\AI Art Gallery Studio\` 的 `config.yaml` 和 `data/` 会在安装目录可写时自动复制到安装目录；已存在文件不会覆盖。

## 注意

- Windows 用户需要 WebView2 Runtime。当前配置使用 Tauri 默认下载引导安装。
- 当前打包目标先配置为 Windows NSIS 安装包。
- 如果要分发给陌生用户，建议后续补代码签名，否则 Windows 可能提示未知发布者。
