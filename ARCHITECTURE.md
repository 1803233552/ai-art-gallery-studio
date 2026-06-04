# AI 创意工坊 项目架构

## 目录结构

```text
app/
├── __init__.py
├── main.py              # FastAPI 入口 + uvicorn 启动
├── config.py            # YAML 配置加载，支持首次启动生成 secret_key
├── database.py          # SQLite / MySQL 数据库初始化与兼容封装
├── routers/
│   ├── __init__.py
│   ├── pages.py         # 页面路由：首页、文档、工作台、广场、管理后台
│   ├── auth.py          # NewAPI / OneAPI 登录验证与本项目 token 签发
│   ├── api_proxy.py     # 后端代理 API（request_mode=backend 时使用）
│   ├── gallery.py       # 作品广场 API：上传、列表、点赞、评论、管理
│   ├── history.py       # 登录用户绘图历史缓存与清理
│   └── balance.py       # 余额查询接口
├── templates/
│   ├── base.html
│   ├── home.html
│   ├── docs.html
│   ├── play.html
│   ├── gallery.html
│   └── admin.html
└── static/
    ├── css/
    │   ├── common.css
    │   ├── home.css
    │   ├── docs.css
    │   ├── play.css
    │   └── gallery.css
    ├── img/
    │   └── default-avatar.svg
    └── js/
        ├── common.js
        ├── play.js
        └── gallery.js
```

## 运行时目录

以下目录包含本地运行数据，不应提交到 Git：

- `data/`：SQLite 数据库、历史缓存等。
- `gallery_images/`：作品广场图片文件。
- `logs/`：运行日志。
- `.venv/`：本地虚拟环境。

公开配置请使用 `config.example.yaml`，真实配置保存在本机 `config.yaml`。
