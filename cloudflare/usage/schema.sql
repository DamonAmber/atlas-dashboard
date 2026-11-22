-- 明细只保留 90 天；不存 IP、原始安装标识、删除凭证或文档数据。
CREATE TABLE IF NOT EXISTS installs (
  id_hash TEXT PRIMARY KEY,
  first_day TEXT NOT NULL,
  last_day TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  day TEXT NOT NULL,
  id_hash TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  channel TEXT NOT NULL,
  PRIMARY KEY (day, id_hash)
);
CREATE INDEX IF NOT EXISTS activity_by_install ON activity (id_hash, day);
CREATE INDEX IF NOT EXISTS installs_last_day ON installs (last_day);
CREATE TABLE IF NOT EXISTS daily_totals (
  day TEXT PRIMARY KEY,
  active INTEGER NOT NULL,
  first_recorded INTEGER NOT NULL
);
-- 7 天删除屏障只用于阻止在途旧请求重建已删除的记录。
CREATE TABLE IF NOT EXISTS revoked (
  id_hash TEXT PRIMARY KEY,
  until_day TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget (
  day TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0
);
