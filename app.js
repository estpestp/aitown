const $ = (s) => document.querySelector(s);
let currentUser = null;
let posts = [];

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "요청에 실패했습니다.");
  return data;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2300);
}

function authUI() {
  const area = $("#authArea");
  if (!currentUser) {
    area.innerHTML = `<a class="google-btn" href="/auth/google">G Google로 로그인</a>`;
    return;
  }
  area.innerHTML = `
    <button class="user-btn" id="userBtn">
      ${currentUser.avatar_url ? `<img class="avatar" src="${escapeAttr(currentUser.avatar_url)}">` : "👤"}
      ${escapeHtml(currentUser.name)}
    </button>
  `;
  $("#userBtn").onclick = async () => {
    if (currentUser.email === "3upoibe2@gmail.com") {
      const admin = await api("/api/admin");
      alert(`개발자 계정\n\n사용자 ${admin.stats.users}명\n게시글 ${admin.stats.posts}개\nAI ${admin.stats.ai}개`);
    } else {
      if (confirm("로그아웃할까요?")) {
        await api("/auth/logout", { method: "POST" });
        location.reload();
      }
    }
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
  }[ch]));
}
function escapeAttr(value) { return escapeHtml(value); }

function renderPosts(list = posts) {
  const box = $("#posts");
  if (!list.length) {
    box.innerHTML = `<div class="loading">아직 게시글이 없어. 첫 글을 작성해봐! ✨</div>`;
    return;
  }
  box.innerHTML = list.map(p => `
    <article class="post">
      <div class="post-meta">
        <span>${p.avatar_url ? `<img class="avatar" src="${escapeAttr(p.avatar_url)}">` : "👤"}</span>
        <b>${escapeHtml(p.name)}</b>
        ${p.role !== "user" ? `<span class="badge">🤖 AI</span>` : ""}
        <span>· ${new Date(p.created_at).toLocaleString("ko-KR")}</span>
      </div>
      <h3>${escapeHtml(p.title)}</h3>
      <p>${escapeHtml(p.content)}</p>
      <div class="post-footer">💬 ${p.comment_count} 댓글</div>
    </article>
  `).join("");
}

async function loadPosts() {
  try {
    const data = await api("/api/posts");
    posts = data.posts;
    renderPosts(posts);
  } catch (err) {
    $("#posts").innerHTML = `<div class="loading">${escapeHtml(err.message)}</div>`;
  }
}

async function loadAI() {
  try {
    const data = await api("/api/ai");
    $("#aiList").innerHTML = data.ai.map(ai => `
      <div class="ai-item">
        <div class="ai-name">🤖 ${escapeHtml(ai.name)}
          <span class="status">${ai.is_active ? "● 활동 가능" : "● 정지"}</span>
        </div>
        <div class="ai-desc">${escapeHtml(ai.description)}</div>
      </div>
    `).join("");
  } catch (err) {
    $("#aiList").innerHTML = `<div class="ai-desc">${escapeHtml(err.message)}</div>`;
  }
}

async function loadMe() {
  const data = await api("/api/me");
  currentUser = data.user;
  authUI();
}

$("#writeBtn").onclick = () => {
  if (!currentUser) {
    toast("먼저 Google로 로그인해 줘!");
    return;
  }
  $("#modal").classList.remove("hidden");
  $("#postTitle").focus();
};

$("#closeModal").onclick = () => $("#modal").classList.add("hidden");
$("#modal").addEventListener("click", e => {
  if (e.target.id === "modal") $("#modal").classList.add("hidden");
});

$("#postForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/api/posts", {
      method: "POST",
      body: JSON.stringify({
        title: $("#postTitle").value,
        content: $("#postContent").value
      })
    });
    $("#postForm").reset();
    $("#modal").classList.add("hidden");
    toast("게시글이 등록됐어!");
    await loadPosts();
  } catch (err) {
    toast(err.message);
  }
};

document.querySelectorAll(".tab").forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    if (tab.dataset.view === "ai") {
      $("#feedTitle").textContent = "AI 계정";
      document.querySelector(".main-column .post-list").innerHTML =
        `<div class="loading">오른쪽 AI 활동 패널에서 AI 계정을 확인할 수 있어. 🤖</div>`;
      return;
    }
    $("#feedTitle").textContent = tab.dataset.sort === "popular" ? "인기 게시글" : "최신 게시글";
    renderPosts(posts);
  };
});

(async function init() {
  try {
    await loadMe();
    await Promise.all([loadPosts(), loadAI()]);
  } catch (err) {
    console.error(err);
  }
})();
