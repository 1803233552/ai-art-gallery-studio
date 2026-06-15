# 大家好，我是小白，正式发布了自己第一款屎山，原汁原味，BUG自己修，issue不会修。
再穷不能穷模型，再省不能省 token！
所以不要提issue，提了我也不会修。
# 欢迎老板来使用我的中转站点
newapi.qianye.host

# AI 创意工坊

一个基于 FastAPI 的 AI 图片生成工作台，提供多线路 API 配置、图片生成、作品广场、用户登录、历史记录、余额查询和管理后台等功能。

## 功能

- AI 图片生成工作台，支持图片生成和参考图上传。
- API 节点可配置，支持前端直连或后端代理模式。
- 作品广场：上传、浏览、点赞、评论、个人主页和管理功能。
- NewAPI / OneAPI 登录验证。
- 登录用户绘图历史临时存储。
- 余额查询面板。
- SQLite 默认数据库，可选 MySQL。

## 技术栈

- Python 3.11+
- FastAPI / Uvicorn
- Jinja2
- SQLite 或 MySQL
- uv 包管理

## 快速开始

```bash
uv sync
cp config.example.yaml config.yaml
uv run python -m app.main
```

启动后访问：

```text
http://127.0.0.1:8100
```

也可以使用管理脚本：

```bash
bash manage.sh start
bash manage.sh status
bash manage.sh stop
```

## 桌面应用构建

构建 Tauri 桌面应用安装包：

```bash
npm run desktop:build
```

构建完成后，Windows 安装包输出在：

```text
src-tauri/target/release/bundle/nsis/AI 创意工坊_1.0.0_x64-setup.exe
```

## 配置

所有运行时配置都在 `config.yaml` 中。首次使用请先复制示例配置：

```bash
cp config.example.yaml config.yaml
```

重点配置项：

- `api_nodes`：工作台可选 API 节点。
- `request_mode`：`frontend` 表示浏览器直接请求 API；`backend` 表示服务端代理请求。
- `newapi.base_url`：用于用户登录验证和余额查询的 NewAPI / OneAPI 地址。
- `admin.username` / `admin.password`：管理后台账号，请上线前修改。
- `database.type`：默认 `sqlite`，也支持 `mysql`。
- `secret_key`：留空时首次启动自动生成；不要提交真实值。

## MySQL

如需使用 MySQL：

```bash
uv sync --extra mysql
```

然后在 `config.yaml` 中设置：

```yaml
database:
  type: "mysql"
  host: "127.0.0.1"
  port: 3306
  user: "huitu"
  password: "change-me"
  database: "huitu"
```

## 目录结构

```text
app/
  main.py              FastAPI 入口
  config.py            YAML 配置加载
  database.py          SQLite/MySQL 数据库初始化
  routers/             页面、鉴权、代理、广场、历史、余额接口
  templates/           Jinja2 页面模板
  static/              CSS、JS、图片资源
config.example.yaml    示例配置
manage.sh              服务管理脚本
pyproject.toml         Python 项目配置
uv.lock                uv 锁文件
```

## 开源与隐私说明

不要提交以下文件或目录：

- `config.yaml`、`config-*.yaml`：真实配置、密码和 secret_key。
- `data/`：数据库和运行时数据。
- `gallery_images/`：用户上传或生成图片。
- `logs/`：运行日志。
- `.venv/`、`.claude/`、`.service.pid`：本地环境和工具状态。

这些内容已在 `.gitignore` 中排除。

## License

MIT
