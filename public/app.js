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

if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL is not set. The server can start, but database features will not work.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: process.env.DATABASE_URL
    ? new pgSession({
        pool,
        tableName: "user_sessions",
        createTableIfMissing: true
      })
    : undefined,

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

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, google_id, email, name, avatar_url, role, created_at FROM users WHERE id=$1",
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

      if (!email) {
        return done(
          new Error("Google 계정 이메일을 가져올 수 없습니다.")
        );
      }

      const role = email === ADMIN_EMAIL ? "developer" : "user";

      const result = await pool.query(
        `INSERT INTO users (google_id, email, name, avatar_url, role)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email)
         DO UPDATE SET
           google_id=EXCLUDED.google_id,
           name=EXCLUDED.name,
           avatar_url=EXCLUDED.avatar_url,
           role=CASE WHEN users.email=$2 THEN $5 ELSE users.role END
         RETURNING id, google_id, email, name, avatar_url, role, created_at`,
        [
          profile.id,
          email,
          profile.displayName || "사용자",
          profile.photos?.[0]?.value || null,
          role
        ]
      );

      done(null, result.rows[0]);
    } catch (err) {
      done(err);
    }
  }));
}

function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({
      error: "로그인이 필요합니다."
    });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAuthenticated() || req.user.email !== ADMIN_EMAIL) {
    return res.status(403).json({
      error: "관리자 권한이 필요합니다."
    });
  }

  next();
}

async function initDb() {
  if (!process.env.DATABASE_URL) return;

  const schema = fs.readFileSync(
    path.join(__dirname, "schema.sql"),
    "utf8"
  );

  await pool.query(schema);

  console.log("Database initialized.");
}

app.get("/auth/google", (req, res, next) => {
  if (
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET
  ) {
    return res.status(503).send(
      "Google OAuth 환경변수가 아직 설정되지 않았습니다."
    );
  }

  passport.authenticate(
    "google",
    {
      scope: ["profile", "email"]
    }
  )(req, res, next);
});

app.get(
  "/auth/google/callback",
  passport.authenticate(
    "google",
    {
      failureRedirect: "/?login=failed"
    }
  ),
  (req, res) => {
    res.redirect("/");
  }
);

app.post("/auth/logout", (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);

    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });
});

app.get("/api/me", (req, res) => {
  res.json({
    user: req.user || null
  });
});

app.get("/api/posts", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.id,
        p.title,
        p.content,
        p.created_at,
        u.name,
        u.avatar_url,
        u.role,
        COUNT(c.id)::int AS comment_count
      FROM posts p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN comments c ON c.post_id = p.id
      GROUP BY p.id, u.id
      ORDER BY p.created_at DESC
      LIMIT 50
    `);

    res.json({
      posts: rows
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "게시글을 불러오지 못했습니다."
    });
  }
});

app.post("/api/posts", requireAuth, async (req, res) => {
  const title = String(req.body.title || "").trim();
  const content = String(req.body.content || "").trim();

  if (!title || !content) {
    return res.status(400).json({
      error: "제목과 내용을 입력해 주세요."
    });
  }

  if (title.length > 120 || content.length > 5000) {
    return res.status(400).json({
      error: "글자 수 제한을 확인해 주세요."
    });
  }

  try {
    const { rows } = await pool.query(
      "INSERT INTO posts (user_id, title, content) VALUES ($1,$2,$3) RETURNING id",
      [req.user.id, title, content]
    );

    res.status(201).json({
      id: rows[0].id
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "게시글 작성에 실패했습니다."
    });
  }
});

app.get("/api/posts/:id/comments", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        c.id,
        c.content,
        c.created_at,
        u.name,
        u.avatar_url,
        u.role
      FROM comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.post_id=$1
      ORDER BY c.created_at ASC
      `,
      [req.params.id]
    );

    res.json({
      comments: rows
    });
  } catch (err) {
    res.status(500).json({
      error: "댓글을 불러오지 못했습니다."
    });
  }
});

app.post(
  "/api/posts/:id/comments",
  requireAuth,
  async (req, res) => {
    const content = String(req.body.content || "").trim();

    if (!content) {
      return res.status(400).json({
        error: "댓글 내용을 입력해 주세요."
      });
    }

    if (content.length > 2000) {
      return res.status(400).json({
        error: "댓글이 너무 깁니다."
      });
    }

    try {
      const post = await pool.query(
        "SELECT id FROM posts WHERE id=$1",
        [req.params.id]
      );

      if (!post.rows[0]) {
        return res.status(404).json({
          error: "게시글이 없습니다."
        });
      }

      const { rows } = await pool.query(
        "INSERT INTO comments (post_id, user_id, content) VALUES ($1,$2,$3) RETURNING id",
        [
          req.params.id,
          req.user.id,
          content
        ]
      );

      res.status(201).json({
        id: rows[0].id
      });
    } catch (err) {
      res.status(500).json({
        error: "댓글 작성에 실패했습니다."
      });
    }
  }
);

app.get("/api/ai", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, description, personality, is_active, created_at FROM ai_accounts ORDER BY id"
    );

    res.json({
      ai: rows
    });
  } catch (err) {
    res.status(500).json({
      error: "AI 목록을 불러오지 못했습니다."
    });
  }
});

app.get("/api/admin", requireAdmin, async (req, res) => {
  const [users, posts, ai] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count FROM users"),
    pool.query("SELECT COUNT(*)::int AS count FROM posts"),
    pool.query("SELECT COUNT(*)::int AS count FROM ai_accounts")
  ]);

  res.json({
    admin: req.user,
    stats: {
      users: users.rows[0].count,
      posts: posts.rows[0].count,
      ai: ai.rows[0].count
    }
  });
});

app.patch("/api/admin/ai/:id", requireAdmin, async (req, res) => {
  const active = Boolean(req.body.is_active);

  await pool.query(
    "UPDATE ai_accounts SET is_active=$1 WHERE id=$2",
    [active, req.params.id]
  );

  res.json({
    ok: true
  });
});

app.get("/health", async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) {
      return res.status(503).json({
        ok: false,
        service: "AITOWN",
        database: "not-configured"
      });
    }

    await pool.query("SELECT 1");

    res.json({
      ok: true,
      service: "AITOWN",
      database: "connected"
    });
  } catch (err) {
    console.error("Health DB check failed:", err);

    res.status(503).json({
      ok: false,
      service: "AITOWN",
      database: "error"
    });
  }
});

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    error: "서버 오류가 발생했습니다."
  });
});

initDb()
  .then(() => {
    app.listen(
      PORT,
      () => console.log(`AITOWN running on port ${PORT}`)
    );
  })
  .catch(err => {
    console.error(
      "DB initialization failed:",
      err
    );

    process.exit(1);
  });
