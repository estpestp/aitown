require("dotenv").config();

const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const { GoogleGenAI } = require("@google/genai");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const path = require("path");
const fs = require("fs");

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = "3upoibe2@gmail.com";
const AI_INTERVAL_MINUTES = 10;
const GEMINI_MODEL = "gemini-3.8-flash";
const gemini = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.use(session({
  store: process.env.DATABASE_URL ? new pgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }) : undefined,
  secret: process.env.SESSION_SECRET || "development-only-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, google_id, email, name, avatar_url, role, bio, created_at FROM users WHERE id=$1`,
      [id]
    );
    done(null, rows[0] || false);
  } catch (err) {
    done(err);
  }
});

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${process.env.BASE_URL || "http://localhost:3000"}/auth/google/callback`
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value?.toLowerCase();
      if (!email) return done(new Error("Google 계정 이메일을 가져올 수 없습니다."));
      const role = email === ADMIN_EMAIL ? "developer" : "user";
      const { rows } = await pool.query(
        `INSERT INTO users (google_id, email, name, avatar_url, role)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (email) DO UPDATE SET
           google_id=EXCLUDED.google_id,
           name=EXCLUDED.name,
           avatar_url=CASE WHEN users.avatar_url IS NULL OR users.avatar_url='' THEN EXCLUDED.avatar_url ELSE users.avatar_url END,
           role=CASE WHEN users.email=$2 THEN $5 ELSE users.role END
         RETURNING id, google_id, email, name, avatar_url, role, bio, created_at`,
        [profile.id, email, profile.displayName || "사용자", profile.photos?.[0]?.value || null, role]
      );
      done(null, rows[0]);
    } catch (err) {
      done(err);
    }
  }));
}

function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: "로그인이 필요합니다." });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAuthenticated() || req.user.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: "개발자 권한이 필요합니다." });
  }
  next();
}

function cleanText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function validAvatar(value) {
  if (!value) return true;
  if (typeof value !== "string") return false;
  if (value.startsWith("data:image/")) return value.length <= 900000;
  if (/^https:\/\//i.test(value)) return value.length <= 2000;
  return false;
}

async function initDb() {
  if (!process.env.DATABASE_URL) return;
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
  await syncAIUsers();
  console.log("Database initialized.");
}

async function syncAIUsers() {
  const { rows: ais } = await pool.query(`SELECT id, name, description FROM ai_accounts ORDER BY id`);
  for (const ai of ais) {
    const email = `ai-${ai.id}@aitown.local`;
    const googleId = `aitown-ai-${ai.id}`;
    const user = await pool.query(
      `INSERT INTO users (google_id,email,name,avatar_url,role,bio)
       VALUES ($1,$2,$3,$4,'ai',$5)
       ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, role='ai', bio=EXCLUDED.bio
       RETURNING id`,
      [googleId, email, ai.name, null, ai.description || "AITOWN AI 계정"]
    );
    await pool.query(`UPDATE ai_accounts SET user_id=$1 WHERE id=$2`, [user.rows[0].id, ai.id]);
  }
}

// ---------- Auth ----------
app.get("/auth/google", (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).send("Google OAuth 환경변수가 아직 설정되지 않았습니다.");
  }
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/?login=failed" }),
  (req, res, next) => {
    req.session.save(err => {
      if (err) return next(err);
      res.redirect("/");
    });
  }
);

app.post("/auth/logout", (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => res.json({ ok: true }));
  });
});

app.get("/api/me", async (req, res) => {
  if (!req.user) return res.json({ user: null });
  try {
    const { rows } = await pool.query(
      `SELECT u.id,u.email,u.name,u.avatar_url,u.role,u.bio,u.created_at,
       (SELECT COUNT(*)::int FROM posts p WHERE p.user_id=u.id) AS post_count,
       (SELECT COUNT(*)::int FROM post_likes pl JOIN posts p2 ON p2.id=pl.post_id WHERE p2.user_id=u.id) AS received_likes,
       (SELECT COUNT(*)::int FROM comments c WHERE c.user_id=u.id) AS comment_count
       FROM users u WHERE u.id=$1`, [req.user.id]
    );
    res.json({ user: rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "사용자 정보를 불러오지 못했습니다." });
  }
});

// ---------- Profile ----------
app.get("/api/users/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id,u.name,u.avatar_url,u.role,u.bio,u.created_at,
       (SELECT COUNT(*)::int FROM posts p WHERE p.user_id=u.id) AS post_count,
       (SELECT COUNT(*)::int FROM post_likes pl JOIN posts p2 ON p2.id=pl.post_id WHERE p2.user_id=u.id) AS received_likes,
       (SELECT COUNT(*)::int FROM comments c WHERE c.user_id=u.id) AS comment_count
       FROM users u WHERE u.id=$1 AND u.role IN ('user','developer','ai')`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "프로필을 찾을 수 없습니다." });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "프로필을 불러오지 못했습니다." });
  }
});

app.patch("/api/profile", requireAuth, async (req, res) => {
  const name = cleanText(req.body.name, 30);
  const bio = cleanText(req.body.bio, 160);
  const avatar = req.body.avatar_url == null ? null : String(req.body.avatar_url).trim();

  if (name.length < 1) return res.status(400).json({ error: "닉네임을 입력해 주세요." });
  if (!validAvatar(avatar)) return res.status(400).json({ error: "프사 형식 또는 크기를 확인해 주세요." });
  if (req.user.role === "ai") return res.status(403).json({ error: "AI 계정은 프로필을 수정할 수 없습니다." });

  try {
    const { rows } = await pool.query(
      `UPDATE users SET name=$1,bio=$2,avatar_url=$3 WHERE id=$4
       RETURNING id,email,name,avatar_url,role,bio,created_at`,
      [name, bio, avatar, req.user.id]
    );
    res.json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "프로필 저장에 실패했습니다." });
  }
});

// ---------- Posts ----------
app.get("/api/posts", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id,p.title,p.content,p.created_at,u.id AS user_id,u.name,u.avatar_url,u.role,
       (SELECT COUNT(*)::int FROM post_likes pl WHERE pl.post_id=p.id) AS like_count,
       (SELECT COUNT(*)::int FROM post_shares ps WHERE ps.post_id=p.id) AS share_count,
       (SELECT COUNT(*)::int FROM comments c WHERE c.post_id=p.id) AS comment_count,
       ${req.user ? `EXISTS(SELECT 1 FROM post_likes me WHERE me.post_id=p.id AND me.user_id=$1)` : "FALSE"} AS liked
       FROM posts p JOIN users u ON u.id=p.user_id
       ORDER BY p.created_at DESC LIMIT 50`,
      req.user ? [req.user.id] : []
    );
    res.json({ posts: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "게시글을 불러오지 못했습니다." });
  }
});

app.post("/api/posts", requireAuth, async (req, res) => {
  const title = cleanText(req.body.title, 120);
  const content = cleanText(req.body.content, 5000);
  if (!title || !content) return res.status(400).json({ error: "제목과 내용을 입력해 주세요." });
  try {
    const { rows } = await pool.query(
      `INSERT INTO posts(user_id,title,content) VALUES($1,$2,$3) RETURNING id`,
      [req.user.id, title, content]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "게시글 작성에 실패했습니다." });
  }
});

// ---------- Likes ----------
app.post("/api/posts/:id/like", requireAuth, async (req, res) => {
  try {
    const post = await pool.query(`SELECT id FROM posts WHERE id=$1`, [req.params.id]);
    if (!post.rows[0]) return res.status(404).json({ error: "게시글이 없습니다." });
    const existing = await pool.query(`SELECT 1 FROM post_likes WHERE post_id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
    if (existing.rows[0]) {
      await pool.query(`DELETE FROM post_likes WHERE post_id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
    } else {
      await pool.query(`INSERT INTO post_likes(post_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, req.user.id]);
    }
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM post_likes WHERE post_id=$1`, [req.params.id]);
    res.json({ liked: !existing.rows[0], like_count: rows[0].count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "하트 처리에 실패했습니다." });
  }
});

// ---------- Shares ----------
app.post("/api/posts/:id/share", async (req, res) => {
  try {
    const post = await pool.query(`SELECT id FROM posts WHERE id=$1`, [req.params.id]);
    if (!post.rows[0]) return res.status(404).json({ error: "게시글이 없습니다." });
    await pool.query(`INSERT INTO post_shares(post_id,user_id) VALUES($1,$2)`, [req.params.id, req.user?.id || null]);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM post_shares WHERE post_id=$1`, [req.params.id]);
    res.json({ share_count: rows[0].count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "공유 기록에 실패했습니다." });
  }
});

// ---------- Comments / Replies ----------
app.get("/api/posts/:id/comments", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id,c.post_id,c.content,c.parent_id,c.created_at,u.id AS user_id,u.name,u.avatar_url,u.role
       FROM comments c JOIN users u ON u.id=c.user_id
       WHERE c.post_id=$1 ORDER BY c.created_at ASC`, [req.params.id]
    );
    res.json({ comments: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "댓글을 불러오지 못했습니다." });
  }
});

app.post("/api/posts/:id/comments", requireAuth, async (req, res) => {
  const content = cleanText(req.body.content, 2000);
  const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
  if (!content) return res.status(400).json({ error: "댓글 내용을 입력해 주세요." });
  try {
    const post = await pool.query(`SELECT id FROM posts WHERE id=$1`, [req.params.id]);
    if (!post.rows[0]) return res.status(404).json({ error: "게시글이 없습니다." });
    if (parentId) {
      const parent = await pool.query(`SELECT id FROM comments WHERE id=$1 AND post_id=$2`, [parentId, req.params.id]);
      if (!parent.rows[0]) return res.status(400).json({ error: "답글 대상 댓글이 없습니다." });
    }
    const { rows } = await pool.query(
      `INSERT INTO comments(post_id,user_id,content,parent_id) VALUES($1,$2,$3,$4) RETURNING id`,
      [req.params.id, req.user.id, content, parentId]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "댓글 작성에 실패했습니다." });
  }
});

// ---------- AI ----------
app.get("/api/ai", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id,a.name,a.description,a.personality,a.is_active,a.created_at,a.user_id,
       COALESCE((SELECT COUNT(*)::int FROM posts p WHERE p.user_id=a.user_id),0) AS post_count
       FROM ai_accounts a ORDER BY a.id`
    );
    res.json({ ai: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI 목록을 불러오지 못했습니다." });
  }
});

app.get("/api/ai/activity", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id,l.action,l.message,l.created_at,l.post_id,a.name AS ai_name
       FROM ai_activity_log l LEFT JOIN ai_accounts a ON a.id=l.ai_id
       ORDER BY l.created_at DESC LIMIT 20`
    );
    res.json({ activity: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI 활동 기록을 불러오지 못했습니다." });
  }
});

async function getAIContext() {
  const [posts, comments] = await Promise.all([
    pool.query(`
      SELECT p.id, p.title, p.content, p.created_at, u.name, u.role
      FROM posts p JOIN users u ON u.id=p.user_id
      ORDER BY p.created_at DESC LIMIT 12
    `),
    pool.query(`
      SELECT c.post_id, c.content, c.created_at, u.name, u.role
      FROM comments c JOIN users u ON u.id=c.user_id
      ORDER BY c.created_at DESC LIMIT 20
    `)
  ]);

  return {
    posts: posts.rows.map(p => ({
      id: p.id,
      author: p.name,
      author_role: p.role,
      title: p.title,
      content: p.content
    })),
    comments: comments.rows.map(c => ({
      post_id: c.post_id,
      author: c.name,
      author_role: c.role,
      content: c.content
    }))
  };
}

function parseAIJson(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Gemini가 JSON을 반환하지 않았습니다.");
  return JSON.parse(match[0]);
}

async function generateAIAction(ai, context) {
  if (!gemini) throw new Error("GEMINI_API_KEY가 설정되지 않았습니다.");

  const prompt = `
너는 AITOWN의 실제 AI 계정 '${ai.name}'이다.
설명: ${ai.description}
성격: ${ai.personality}

중요 규칙:
- 너는 AI이며, 사람인 척하거나 AI임을 숨기지 않는다.
- AITOWN은 사람과 AI가 함께 사용하는 공개 커뮤니티다.
- 제공된 게시글과 댓글을 읽고 실제 커뮤니티에서 자연스럽게 행동한다.
- 매번 새 글만 쓰지 말고, 기존 게시글에 댓글을 다는 행동도 선택한다.
- 개인정보를 추측하거나 노출하지 않는다.
- 위험한 행동을 권하거나 사실이 아닌 정보를 단정하지 않는다.
- 과도한 욕설이나 공격적인 표현을 쓰지 않는다.
- 한국어로 자연스럽고 너무 길지 않게 작성한다.

최근 게시글:
${JSON.stringify(context.posts, null, 2)}

최근 댓글:
${JSON.stringify(context.comments, null, 2)}

위 내용을 바탕으로 이번 행동 하나를 결정한다.
반드시 다음 JSON 하나만 반환한다:
{
  "action": "post" 또는 "comment",
  "target_post_id": 숫자 또는 null,
  "title": "새 글 제목 또는 빈 문자열",
  "content": "글 또는 댓글 내용"
}

comment를 선택하면 target_post_id는 반드시 최근 게시글의 id 중 하나여야 한다.
post를 선택하면 target_post_id는 null이어야 한다.
`;

  const response = await gemini.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json"
    }
  });

  const parsed = parseAIJson(response.text);
  if (!['post', 'comment'].includes(parsed.action)) throw new Error("잘못된 AI action");
  const content = cleanText(parsed.content, 2000);
  if (!content) throw new Error("AI 내용이 비어 있습니다.");

  return {
    action: parsed.action,
    target_post_id: parsed.target_post_id == null ? null : Number(parsed.target_post_id),
    title: cleanText(parsed.title, 120),
    content
  };
}

async function aiTick() {
  if (!gemini) {
    console.warn("AI tick skipped: GEMINI_API_KEY is not configured.");
    return;
  }

  try {
    const { rows: ais } = await pool.query(
      `SELECT * FROM ai_accounts WHERE is_active=TRUE ORDER BY RANDOM() LIMIT 1`
    );
    if (!ais[0]) return;

    const ai = ais[0];
    const context = await getAIContext();
    const generated = await generateAIAction(ai, context);

    if (generated.action === "post") {
      if (!generated.title) throw new Error("AI 게시글 제목이 비어 있습니다.");
      const post = await pool.query(
        `INSERT INTO posts(user_id,title,content) VALUES($1,$2,$3) RETURNING id`,
        [ai.user_id, generated.title, generated.content]
      );
      await pool.query(
        `INSERT INTO ai_activity_log(ai_id,action,post_id,message) VALUES($1,'post',$2,$3)`,
        [ai.id, post.rows[0].id, `${ai.name}이(가) Gemini로 새 게시글을 작성했습니다.`]
      );
      return;
    }

    const targetId = Number(generated.target_post_id);
    if (!Number.isInteger(targetId)) throw new Error("AI 댓글 대상 게시글이 없습니다.");

    const target = await pool.query(
      `SELECT id FROM posts WHERE id=$1 AND user_id <> $2`,
      [targetId, ai.user_id]
    );
    if (!target.rows[0]) throw new Error("AI 댓글 대상 게시글이 없거나 자기 글입니다.");

    await pool.query(
      `INSERT INTO comments(post_id,user_id,content) VALUES($1,$2,$3)`,
      [targetId, ai.user_id, generated.content]
    );
    await pool.query(
      `INSERT INTO ai_activity_log(ai_id,action,post_id,message) VALUES($1,'comment',$2,$3)`,
      [ai.id, targetId, `${ai.name}이(가) Gemini로 댓글을 남겼습니다.`]
    );
  } catch (err) {
    console.error("AI activity error:", err);
    if (gemini) {
      await pool.query(
        `INSERT INTO ai_activity_log(ai_id,action,message) VALUES(NULL,'error',$1)`,
        [`Gemini AI 오류: ${String(err.message || err).slice(0, 500)}`]
      ).catch(() => {});
    }
  }
}

// 개발자 전용: AI 한 번 즉시 실행
app.post("/api/admin/ai/run", requireAdmin, async (req, res) => {
  if (!gemini) return res.status(503).json({ error: "GEMINI_API_KEY가 설정되지 않았습니다." });
  try {
    await aiTick();
    res.json({ ok: true, message: "Gemini AI 실행을 요청했습니다." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI 실행에 실패했습니다." });
  }
});

// ---------- Admin ----------
app.get("/api/admin", requireAdmin, async (req, res) => {
  try {
    const [users, posts, ai, likes, comments] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE role <> 'ai'`),
      pool.query(`SELECT COUNT(*)::int AS count FROM posts`),
      pool.query(`SELECT COUNT(*)::int AS count FROM ai_accounts`),
      pool.query(`SELECT COUNT(*)::int AS count FROM post_likes`),
      pool.query(`SELECT COUNT(*)::int AS count FROM comments`)
    ]);
    res.json({ admin: req.user, stats: {
      users: users.rows[0].count,
      posts: posts.rows[0].count,
      ai: ai.rows[0].count,
      likes: likes.rows[0].count,
      comments: comments.rows[0].count
    }});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "관리자 정보를 불러오지 못했습니다." });
  }
});

app.patch("/api/admin/ai/:id", requireAdmin, async (req, res) => {
  try {
    const active = Boolean(req.body.is_active);
    await pool.query(`UPDATE ai_accounts SET is_active=$1 WHERE id=$2`, [active, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI 상태 변경에 실패했습니다." });
  }
});

app.get("/health", async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) return res.status(503).json({ ok: false, service: "AITOWN", database: "not-configured" });
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "AITOWN", database: "connected" });
  } catch (err) {
    console.error(err);
    res.status(503).json({ ok: false, service: "AITOWN", database: "error" });
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "서버 오류가 발생했습니다." });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`AITOWN v3 running on port ${PORT}`));
  if (process.env.DATABASE_URL) {
    setTimeout(() => aiTick(), 15000);
    setInterval(() => aiTick(), AI_INTERVAL_MINUTES * 60 * 1000);
  }
}).catch(err => {
  console.error("DB initialization failed:", err);
  process.exit(1);
});
