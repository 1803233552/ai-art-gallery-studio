"""数据库管理 - 支持 SQLite / MySQL"""
import aiosqlite
from pathlib import Path
from app.config import get, resolve_path

_db_path: str = ""

def _db_type() -> str:
    return get("database.type", "sqlite").lower()

def get_db_path() -> str:
    global _db_path
    if not _db_path:
        _db_path = str(resolve_path(get("database.path", "./data/huitu.db")))
        Path(_db_path).parent.mkdir(parents=True, exist_ok=True)
    return _db_path

async def get_db():
    """获取数据库连接（SQLite 或 MySQL）"""
    if _db_type() == "mysql":
        return await _get_mysql()
    return await _get_sqlite()

async def _get_sqlite() -> aiosqlite.Connection:
    db = await aiosqlite.connect(get_db_path())
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    return db

async def _get_mysql():
    """获取 MySQL 连接"""
    try:
        import aiomysql
    except ModuleNotFoundError:
        raise RuntimeError(
            "配置了 database.type=mysql 但未安装 aiomysql。"
            "请运行: uv pip install aiomysql  或  uv sync --extra mysql"
        )
    conn = await aiomysql.connect(
        host=get("database.host", "127.0.0.1"),
        port=get("database.port", 3306),
        user=get("database.user", "root"),
        password=get("database.password", ""),
        db=get("database.database", "huitu"),
        charset="utf8mb4",
        autocommit=False,
    )
    return _MySQLWrapper(conn)

class _Row(dict):
    """兼容行：同时支持 row[0]（数字索引）和 row['col']（键名），以及 dict(row)"""
    def __init__(self, d):
        super().__init__(d)
        self._values = list(d.values())

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        return super().__getitem__(key)


class _MySQLWrapper:
    """MySQL 连接包装器，提供与 aiosqlite 兼容的接口"""
    def __init__(self, conn):
        self._conn = conn
        import aiomysql as _aiomysql
        self._aiomysql = _aiomysql

    @staticmethod
    def _translate(sql: str) -> str:
        """将 SQLite 风格的 SQL 自动翻译为 MySQL 兼容语法"""
        sql = sql.replace("?", "%s")
        # date('now') → CURDATE()
        sql = sql.replace("date('now')", "CURDATE()")
        # CAST(... AS TEXT) → CAST(... AS CHAR)
        sql = sql.replace(" AS TEXT)", " AS CHAR)")
        return sql

    async def execute(self, sql, params=None):
        sql = self._translate(sql)
        cur = await self._conn.cursor(self._aiomysql.DictCursor)
        await cur.execute(sql, params or ())
        return cur

    async def execute_fetchall(self, sql, params=None):
        sql = self._translate(sql)
        cur = await self._conn.cursor(self._aiomysql.DictCursor)
        await cur.execute(sql, params or ())
        rows = await cur.fetchall()
        return [_Row(r) for r in rows]

    async def executescript(self, sql):
        cur = await self._conn.cursor()
        for stmt in sql.split(";"):
            stmt = stmt.strip()
            if stmt:
                await cur.execute(stmt)

    async def commit(self):
        await self._conn.commit()

    async def close(self):
        self._conn.close()

# ---- 建表 SQL（SQLite）----
_SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS user_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    newapi_user_id INTEGER UNIQUE NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    nickname TEXT NOT NULL DEFAULT '',
    avatar_url TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    is_banned INTEGER DEFAULT 0,
    ban_reason TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gallery_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id INTEGER UNIQUE,
    user_id INTEGER DEFAULT NULL,
    username TEXT DEFAULT '',
    title TEXT DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL,
    thumbnail TEXT DEFAULT '',
    image_hash TEXT DEFAULT '',
    width INTEGER DEFAULT 0,
    height INTEGER DEFAULT 0,
    file_size INTEGER DEFAULT 0,
    likes_count INTEGER DEFAULT 0,
    comments_count INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    is_public INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS image_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL,
    ip_address TEXT NOT NULL DEFAULT '',
    fingerprint TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (image_id) REFERENCES gallery_images(id) ON DELETE CASCADE,
    UNIQUE(image_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS image_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT DEFAULT '',
    nickname TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    content TEXT NOT NULL,
    likes_count INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (image_id) REFERENCES gallery_images(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comment_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    fingerprint TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (comment_id) REFERENCES image_comments(id) ON DELETE CASCADE,
    UNIQUE(comment_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS user_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    batch_id TEXT NOT NULL,
    image_index INTEGER NOT NULL DEFAULT 0,
    model TEXT DEFAULT '',
    prompt TEXT DEFAULT '',
    filename TEXT NOT NULL,
    batch_time TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expire_at TIMESTAMP DEFAULT NULL
);
"""

_SQLITE_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_gallery_likes ON gallery_images(likes_count DESC)",
    "CREATE INDEX IF NOT EXISTS idx_gallery_created ON gallery_images(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_gallery_user ON gallery_images(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_gallery_hash ON gallery_images(image_hash)",
    "CREATE INDEX IF NOT EXISTS idx_gallery_pid ON gallery_images(public_id)",
    "CREATE INDEX IF NOT EXISTS idx_likes_image ON image_likes(image_id)",
    "CREATE INDEX IF NOT EXISTS idx_likes_fp ON image_likes(image_id, fingerprint)",
    "CREATE INDEX IF NOT EXISTS idx_comments_image ON image_comments(image_id)",
    "CREATE INDEX IF NOT EXISTS idx_comments_user ON image_comments(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_profiles_uid ON user_profiles(newapi_user_id)",
    "CREATE INDEX IF NOT EXISTS idx_history_user ON user_history(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_history_batch ON user_history(batch_id)",
    "CREATE INDEX IF NOT EXISTS idx_history_created ON user_history(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_history_expire ON user_history(expire_at)",
]

# ---- 建表 SQL（MySQL）----
_MYSQL_SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS user_profiles (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        newapi_user_id BIGINT UNIQUE NOT NULL,
        username VARCHAR(255) NOT NULL DEFAULT '',
        nickname VARCHAR(255) NOT NULL DEFAULT '',
        avatar_url VARCHAR(500) DEFAULT '',
        bio VARCHAR(500) DEFAULT '',
        is_banned TINYINT DEFAULT 0,
        ban_reason VARCHAR(500) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_profiles_uid (newapi_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS gallery_images (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        public_id BIGINT UNIQUE,
        user_id BIGINT DEFAULT NULL,
        username VARCHAR(255) DEFAULT '',
        title VARCHAR(255) DEFAULT '',
        model VARCHAR(255) DEFAULT '',
        prompt TEXT,
        filename VARCHAR(255) NOT NULL,
        thumbnail VARCHAR(255) DEFAULT '',
        image_hash VARCHAR(64) DEFAULT '',
        width INT DEFAULT 0,
        height INT DEFAULT 0,
        file_size BIGINT DEFAULT 0,
        likes_count INT DEFAULT 0,
        comments_count INT DEFAULT 0,
        view_count INT DEFAULT 0,
        is_public TINYINT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_gallery_likes (likes_count),
        INDEX idx_gallery_created (created_at),
        INDEX idx_gallery_user (user_id),
        INDEX idx_gallery_hash (image_hash),
        INDEX idx_gallery_pid (public_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS image_likes (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        image_id BIGINT NOT NULL,
        ip_address VARCHAR(45) DEFAULT '',
        fingerprint VARCHAR(64) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_image_fp (image_id, fingerprint),
        INDEX idx_likes_image (image_id),
        FOREIGN KEY (image_id) REFERENCES gallery_images(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS image_comments (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        image_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        username VARCHAR(255) DEFAULT '',
        nickname VARCHAR(255) DEFAULT '',
        avatar_url VARCHAR(500) DEFAULT '',
        content TEXT NOT NULL,
        likes_count INT DEFAULT 0,
        is_pinned TINYINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_comments_image (image_id),
        INDEX idx_comments_user (user_id),
        FOREIGN KEY (image_id) REFERENCES gallery_images(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS comment_likes (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        comment_id BIGINT NOT NULL,
        fingerprint VARCHAR(64) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_comment_fp (comment_id, fingerprint),
        FOREIGN KEY (comment_id) REFERENCES image_comments(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS user_history (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        username VARCHAR(255) NOT NULL DEFAULT '',
        batch_id VARCHAR(64) NOT NULL,
        image_index INT NOT NULL DEFAULT 0,
        model VARCHAR(255) DEFAULT '',
        prompt TEXT,
        filename VARCHAR(255) NOT NULL,
        batch_time VARCHAR(64) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expire_at TIMESTAMP NULL DEFAULT NULL,
        INDEX idx_history_user (user_id),
        INDEX idx_history_batch (batch_id),
        INDEX idx_history_created (created_at),
        INDEX idx_history_expire (expire_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
]

async def init_db():
    """根据 database.type 选择对应的 DDL 初始化数据库表"""
    db = await get_db()
    try:
        if _db_type() == "mysql":
            for ddl in _MYSQL_SCHEMA:
                await db.execute(ddl)
            # 兼容旧表：自动添加 username 列
            try:
                await db.execute("ALTER TABLE user_history ADD COLUMN username VARCHAR(255) NOT NULL DEFAULT ''")
            except Exception:
                pass
            # 兼容旧表：自动添加 expire_at 列
            try:
                await db.execute("ALTER TABLE user_history ADD COLUMN expire_at TIMESTAMP NULL DEFAULT NULL")
            except Exception:
                pass
            try:
                await db.execute("CREATE INDEX idx_history_expire ON user_history(expire_at)")
            except Exception:
                pass
        else:
            await db.executescript(_SQLITE_SCHEMA)
            for sql in _SQLITE_INDEXES:
                try:
                    await db.execute(sql)
                except Exception:
                    pass
            # 兼容旧表：自动添加 username 列
            try:
                await db.execute("ALTER TABLE user_history ADD COLUMN username TEXT NOT NULL DEFAULT ''")
            except Exception:
                pass
            # 兼容旧表：自动添加 expire_at 列
            try:
                await db.execute("ALTER TABLE user_history ADD COLUMN expire_at TIMESTAMP DEFAULT NULL")
            except Exception:
                pass
        await db.commit()
    finally:
        await db.close()
