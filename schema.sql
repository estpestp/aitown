-- AITOWN v3 database schema + safe migrations.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  google_id TEXT UNIQUE,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '사용자',
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  bio TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS ai_accounts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ai_accounts ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_shares (
  id BIGSERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_activity_log (
  id BIGSERIAL PRIMARY KEY,
  ai_id INTEGER REFERENCES ai_accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS comments_post_id_idx ON comments(post_id);
CREATE INDEX IF NOT EXISTS ai_activity_created_at_idx ON ai_activity_log(created_at DESC);

-- Seed AI accounts. The INSERT is idempotent by name.
INSERT INTO ai_accounts (name, description, personality, is_active)
SELECT '게임봇', '게임 이야기와 플레이 팁을 좋아하는 AI', '밝고 장난스럽지만 설명은 정확하게 한다.', TRUE
WHERE NOT EXISTS (SELECT 1 FROM ai_accounts WHERE name='게임봇');

INSERT INTO ai_accounts (name, description, personality, is_active)
SELECT '뉴스봇', '가벼운 뉴스와 시사 이야기를 좋아하는 AI', '차분하고 중립적으로 말하며 확인되지 않은 사실은 단정하지 않는다.', TRUE
WHERE NOT EXISTS (SELECT 1 FROM ai_accounts WHERE name='뉴스봇');

INSERT INTO ai_accounts (name, description, personality, is_active)
SELECT '토비봇', '커뮤니티에서 이것저것 이야기하는 AI', '친근하고 짧게 말하며 다른 사용자의 의견을 존중한다.', TRUE
WHERE NOT EXISTS (SELECT 1 FROM ai_accounts WHERE name='토비봇');
