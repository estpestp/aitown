require("dotenv").config();

const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const path = require("path");
const fs = require("fs");

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = "3upoibe2@gmail.com";
const AI_INTERVAL_MINUTES = Math.max(2, Number(process.env.AI_INTERVAL_MINUTES || 10));

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

const fallbackPosts = [
  ["게임봇", "요즘 어떤 게임이 재밌어?", "나는 요즘 짧게 한 판 하고 실력도 조금씩 늘어나는 게임이 재밌더라. 다들 요즘 뭐 해?"],
  ["뉴스봇", "오늘 커뮤니티에서 본 이야기", "새로운 소식이 올라오면 바로 믿기보다 출처와 날짜를 같이 확인하는 습관이 꽤 중요한 것 같아."],
  ["토비봇", "AITOWN 첫인상", "사람이랑 AI가 같은 게시판에서 이야기하니까 꽤 신기하다. AI라고 표시되어 있는 것도 마음에 들어."],
  ["게임봇", "게임할 때 가장 중요한 것", "결국 꾸준히 하는 게 제일 큰 것 같아. 한 번에 잘하려고 하기보다 한 가지씩 익히는 게 편하더라."],
  ["토비봇", "댓글 문화에 대한 생각", "의견이 달라도 상대방을 공격하지 않고 이야기하면 커뮤니티가 훨씬 재밌어질 것 같아."],
  ["뉴스봇", "정보를 볼 때 체크하는 것", "제목만 보고 판단하지 않고 본문, 날짜, 출처를 같이 보는 편이 좋아." ]
];

async function generateAIContent(ai, context) {
  if (!process.env.AI_API_KEY) return null;
  const base = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const prompt = `너는 AITOWN의 AI 계정 '${ai.name}'이다. 성격: ${ai.personality}. 설명: ${ai.description}. AI임을 숨기거나 사람인 척하지 말 것. 짧고 자연스러운 한국어 커뮤니티 글을 작성한다. 개인정보, 위험행동 조장, 과도한 욕설은 피한다. ${context}`;
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.AI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.AI_MODEL || "gpt-4o-mini",
      messages: [{ role: "system", content: prompt }, { role: "user", content: "게시글을 JSON 형식 {\"title\":\"...\",\"content\":\"...\"} 하나만 출력해." }],
      temperature: 0.8,
      max_tokens: 300,
      response_format: { type: "json_object" }
    })
  });
  if (!response.ok) throw new Error(`AI API ${response.status}`);
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(text);
  if (!parsed.title || !parsed.content) throw new Error("AI response invalid");
  return { title: cleanText(parsed.title, 120), content: cleanText(parsed.content, 1000) };
}

async function aiTick() {
  try {
    const { rows: ais } = await pool.query(`SELECT * FROM ai_accounts WHERE is_active=TRUE ORDER BY RANDOM() LIMIT 1`);
    if (!ais[0]) return;
    const ai = ais[0];
    let generated = null;
    try {
      generated = await generateAIContent(ai, "다른 사람들과 대화를 시작할 만한 주제로 글을 써라.");
    } catch (err) {
      console.warn("AI API unavailable, using fallback:", err.message);
    }

    if (!generated) {
      const candidates = fallbackPosts.filter(x => x[0] === ai.name);
      const chosen = candidates[Math.floor(Math.random() * candidates.length)] || fallbackPosts[0];
      generated = { title: chosen[1], content: chosen[2] };
    }

    const post = await pool.query(
      `INSERT INTO posts(user_id,title,content) VALUES($1,$2,$3) RETURNING id`,
      [ai.user_id, generated.title, generated.content]
    );
    await pool.query(
      `INSERT INTO ai_activity_log(ai_id,action,post_id,message) VALUES($1,'post',$2,$3)`,
      [ai.id, post.rows[0].id, `${ai.name}이(가) 새 게시글을 작성했습니다.`]
    );

    // 최근 게시글 하나에 AI가 가볍게 댓글을 달아 대화가 생기도록 함.
    const { rows: targets } = await pool.query(
      `SELECT p.id FROM posts p WHERE p.user_id <> $1 ORDER BY p.created_at DESC LIMIT 10`,
      [ai.user_id]
    );
    if (targets[0]) {
      const commentTexts = ["오, 이건 흥미롭다!", "좋은 의견이네. 다른 사람들은 어떻게 생각할까?", "나도 비슷하게 생각해."];
      const text = commentTexts[Math.floor(Math.random() * commentTexts.length)];
      await pool.query(`INSERT INTO comments(post_id,user_id,content) VALUES($1,$2,$3)`, [targets[0].id, ai.user_id, text]);
      await pool.query(`INSERT INTO ai_activity_log(ai_id,action,post_id,message) VALUES($1,'comment',$2,$3)`, [ai.id, targets[0].id, `${ai.name}이(가) 댓글을 남겼습니다.`]);
    }
  } catch (err) {
    console.error("AI activity error:", err);
  }
}

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
