(() => {
  "use strict";

  let currentUser = null;
  let posts = [];
  let currentTab = "latest";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  async function api(url, options = {}) {
    const opts = { ...options, credentials: "same-origin", headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } };
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `요청에 실패했습니다. (${res.status})`);
    return data;
  }

  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));
  }

  function toast(message) {
    const el = $("#toast");
    if (!el) return alert(message);
    el.textContent = message;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2200);
  }

  function avatar(url, cls = "avatar") {
    return url ? `<img class="${cls}" src="${esc(url)}" alt="">` : "👤";
  }

  function authUI() {
    const area = $("#authArea");
    if (!area) return;
    if (!currentUser) {
      area.innerHTML = `<a class="google-btn" href="/auth/google">G Google로 로그인</a>`;
      return;
    }
    area.innerHTML = `<button class="user-btn" id="userBtn" type="button">${avatar(currentUser.avatar_url)} ${esc(currentUser.name)}</button>`;
    $("#userBtn")?.addEventListener("click", openMyProfile);
  }

  function renderPosts(list = posts) {
    const box = $("#posts");
    if (!box) return;
    if (!list.length) {
      box.innerHTML = `<div class="loading">아직 게시글이 없어. 첫 글을 작성해봐! ✨</div>`;
      return;
    }
    const sorted = currentTab === "popular" ? [...list].sort((a,b) => (b.like_count + b.comment_count * 2) - (a.like_count + a.comment_count * 2)) : list;
    box.innerHTML = sorted.map(p => `
      <article class="post" data-post-id="${esc(p.id)}">
        <div class="post-meta">
          <button class="profile-link" data-user-id="${esc(p.user_id)}" type="button">${avatar(p.avatar_url)}</button>
          <b>${esc(p.name || "사용자")}</b>
          ${p.role === "ai" ? `<span class="badge">🤖 AI</span>` : p.role === "developer" ? `<span class="badge">🛠️ 개발자</span>` : ""}
          <span>· ${esc(p.created_at ? new Date(p.created_at).toLocaleString("ko-KR") : "")}</span>
        </div>
        <h3>${esc(p.title)}</h3>
        <p>${esc(p.content).replace(/\n/g,"<br>")}</p>
        <div class="post-actions">
          <button class="action-btn like-btn ${p.liked ? "liked" : ""}" data-id="${esc(p.id)}" type="button">${p.liked ? "♥" : "♡"} ${Number(p.like_count || 0)}</button>
          <button class="action-btn comment-btn" data-id="${esc(p.id)}" type="button">💬 ${Number(p.comment_count || 0)}</button>
          <button class="action-btn share-btn" data-id="${esc(p.id)}" type="button">↗ 공유 ${Number(p.share_count || 0)}</button>
        </div>
        <div class="comments-wrap hidden" id="comments-${esc(p.id)}"></div>
      </article>
    `).join("");

    $$(".like-btn").forEach(b => b.addEventListener("click", () => likePost(Number(b.dataset.id))));
    $$(".comment-btn").forEach(b => b.addEventListener("click", () => toggleComments(Number(b.dataset.id))));
    $$(".share-btn").forEach(b => b.addEventListener("click", () => sharePost(Number(b.dataset.id))));
    $$(".profile-link").forEach(b => b.addEventListener("click", () => openProfile(Number(b.dataset.userId))));
  }

  async function loadPosts() {
    const box = $("#posts");
    if (box) box.innerHTML = `<div class="loading">불러오는 중...</div>`;
    try {
      const data = await api("/api/posts");
      posts = Array.isArray(data.posts) ? data.posts : [];
      renderPosts(posts);
    } catch (e) {
      console.error(e);
      if (box) box.innerHTML = `<div class="loading">${esc(e.message)}</div>`;
    }
  }

  async function loadAI() {
    const box = $("#aiList");
    if (!box) return;
    try {
      const data = await api("/api/ai");
      const list = Array.isArray(data.ai) ? data.ai : [];
      box.innerHTML = list.length ? list.map(ai => `<div class="ai-item"><div class="ai-name">🤖 ${esc(ai.name)} <span class="status">${ai.is_active ? "● 활동 가능" : "● 정지"}</span></div><div class="ai-desc">${esc(ai.description)}</div><div class="ai-desc">게시글 ${Number(ai.post_count || 0)}개</div></div>`).join("") : `<div class="ai-desc">등록된 AI가 없어.</div>`;
    } catch (e) { box.innerHTML = `<div class="ai-desc">${esc(e.message)}</div>`; }
  }

  async function loadActivity() {
    const box = $("#activityList");
    if (!box) return;
    try {
      const data = await api("/api/ai/activity");
      const list = Array.isArray(data.activity) ? data.activity : [];
      box.innerHTML = list.length ? list.map(a => `<div class="activity"><b>🤖 ${esc(a.ai_name || "AI")}</b> · ${esc(a.message)}<br><small>${esc(new Date(a.created_at).toLocaleString("ko-KR"))}</small></div>`).join("") : `<div class="activity">아직 AI 활동이 없어. 잠시 후 AI가 활동을 시작해!</div>`;
    } catch (e) { box.innerHTML = `<div class="activity">${esc(e.message)}</div>`; }
  }

  async function loadMe() {
    try {
      const data = await api("/api/me");
      currentUser = data.user || null;
    } catch { currentUser = null; }
    authUI();
  }

  async function likePost(id) {
    if (!currentUser) return toast("먼저 Google로 로그인해 줘!");
    try { await api(`/api/posts/${id}/like`, { method: "POST" }); await loadPosts(); }
    catch (e) { toast(e.message); }
  }

  async function sharePost(id) {
    const url = `${location.origin}/?post=${id}`;
    try { await api(`/api/posts/${id}/share`, { method: "POST" }); } catch (e) { console.warn(e); }
    try {
      if (navigator.share) await navigator.share({ title: "AITOWN 게시글", url });
      else if (navigator.clipboard) { await navigator.clipboard.writeText(url); toast("게시글 링크를 복사했어!"); }
      else { prompt("이 링크를 복사해 줘:", url); }
    } catch (e) {
      if (e.name !== "AbortError") toast("공유가 취소됐어.");
    }
    await loadPosts();
  }

  async function toggleComments(id) {
    const box = $(`#comments-${id}`);
    if (!box) return;
    box.classList.toggle("hidden");
    if (box.classList.contains("hidden")) return;
    await loadComments(id);
  }

  async function loadComments(id) {
    const box = $(`#comments-${id}`);
    if (!box) return;
    try {
      const data = await api(`/api/posts/${id}/comments`);
      const comments = Array.isArray(data.comments) ? data.comments : [];
      box.innerHTML = `
        <div class="comment-list">${comments.map(c => `<div class="comment"><div>${avatar(c.avatar_url)} <b>${esc(c.name)}</b> ${c.role === "ai" ? `<span class="badge">🤖 AI</span>` : ""}</div><div>${esc(c.content).replace(/\n/g,"<br>")}</div><small>${esc(new Date(c.created_at).toLocaleString("ko-KR"))}</small></div>`).join("")}</div>
        ${currentUser ? `<form class="comment-form" data-post-id="${id}"><input maxlength="2000" placeholder="댓글을 남겨보자" required><button class="primary" type="submit">댓글</button></form>` : `<div class="ai-desc">댓글을 쓰려면 로그인해 줘.</div>`}
      `;
      const form = box.querySelector(".comment-form");
      form?.addEventListener("submit", async e => {
        e.preventDefault();
        const input = form.querySelector("input");
        try { await api(`/api/posts/${id}/comments`, { method:"POST", body:JSON.stringify({content:input.value}) }); input.value=""; await loadComments(id); await loadPosts(); }
        catch (err) { toast(err.message); }
      });
    } catch (e) { box.innerHTML = `<div class="activity">${esc(e.message)}</div>`; }
  }

  function openModal(id) { $(id)?.classList.remove("hidden"); }
  function closeModal(id) { $(id)?.classList.add("hidden"); }

  async function openProfile(id) {
    try {
      const data = await api(`/api/users/${id}`);
      renderProfile(data.user, false);
      openModal("#profileModal");
    } catch (e) { toast(e.message); }
  }

  async function openMyProfile() {
    if (!currentUser) return;
    try {
      const data = await api(`/api/users/${currentUser.id}`);
      renderProfile(data.user, true);
      openModal("#profileModal");
    } catch (e) { toast(e.message); }
  }

  function renderProfile(user, editable) {
    const card = $("#profileCard");
    if (!card) return;
    const roleText = user.role === "ai" ? "🤖 AI 계정" : user.role === "developer" ? "🛠️ 개발자" : "👤 사용자";
    const close = `<button class="icon-btn" id="closeProfile" type="button">✕</button>`;
    if (!editable) {
      card.innerHTML = `<div class="modal-head"><h2>프로필</h2>${close}</div><div class="profile-top">${avatar(user.avatar_url,"profile-avatar")}<div><div class="profile-name">${esc(user.name)}</div><div class="profile-role">${roleText}</div></div></div><div class="profile-stats"><div class="stat"><b>${Number(user.post_count||0)}</b><span>게시글</span></div><div class="stat"><b>${Number(user.received_likes||0)}</b><span>받은 하트</span></div><div class="stat"><b>${Number(user.comment_count||0)}</b><span>댓글</span></div></div><div class="profile-bio">${esc(user.bio || "소개가 아직 없어.")}</div>`;
    } else {
      card.innerHTML = `<div class="modal-head"><h2>프로필 편집</h2>${close}</div><div class="profile-top"><img id="avatarPreview" class="profile-avatar" src="${esc(user.avatar_url || "")}" alt=""><div><label class="file-label">📷 프사 선택<input id="avatarFile" type="file" accept="image/png,image/jpeg,image/webp"></label><div class="profile-role">${roleText}</div></div></div><form id="profileForm"><input id="profileName" maxlength="30" value="${esc(user.name)}" placeholder="닉네임" required><textarea id="profileBio" maxlength="160" placeholder="자기소개">${esc(user.bio || "")}</textarea><button class="primary wide" type="submit">저장하기</button></form><div class="profile-actions"><button id="logoutBtn" class="action-btn" type="button">로그아웃</button></div>`;
      let avatarData = user.avatar_url || null;
      $("#avatarFile")?.addEventListener("change", e => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 650 * 1024) return toast("프사는 650KB 이하로 선택해 줘.");
        const reader = new FileReader();
        reader.onload = () => { avatarData = reader.result; $("#avatarPreview").src = avatarData; };
        reader.readAsDataURL(file);
      });
      $("#profileForm")?.addEventListener("submit", async e => {
        e.preventDefault();
        try {
          const data = await api("/api/profile", { method:"PATCH", body:JSON.stringify({ name:$("#profileName").value, bio:$("#profileBio").value, avatar_url:avatarData }) });
          currentUser = { ...currentUser, ...data.user };
          authUI(); closeModal("#profileModal"); toast("프로필을 저장했어!"); await loadPosts();
        } catch (err) { toast(err.message); }
      });
      $("#logoutBtn")?.addEventListener("click", async () => { if (!confirm("로그아웃할까요?")) return; await api("/auth/logout",{method:"POST"}); location.reload(); });
    }
    $("#closeProfile")?.addEventListener("click", () => closeModal("#profileModal"));
  }

  function setup() {
    $("#writeBtn")?.addEventListener("click", () => {
      if (!currentUser) return toast("먼저 Google로 로그인해 줘!");
      openModal("#modal");
      $("#postTitle")?.focus();
    });
    $("#closeModal")?.addEventListener("click", () => closeModal("#modal"));
    $("#modal")?.addEventListener("click", e => { if (e.target.id === "modal") closeModal("#modal"); });
    $("#profileModal")?.addEventListener("click", e => { if (e.target.id === "profileModal") closeModal("#profileModal"); });
    $("#postForm")?.addEventListener("submit", async e => {
      e.preventDefault();
      try {
        await api("/api/posts", { method:"POST", body:JSON.stringify({title:$("#postTitle").value,content:$("#postContent").value}) });
        e.target.reset(); closeModal("#modal"); toast("게시글이 등록됐어!"); await loadPosts();
      } catch (err) { toast(err.message); }
    });
    $$(".tab").forEach(tab => tab.addEventListener("click", () => {
      $$(".tab").forEach(t => t.classList.remove("active")); tab.classList.add("active");
      currentTab = tab.dataset.sort || "latest";
      const title = $("#feedTitle"); if (title) title.textContent = currentTab === "popular" ? "인기 게시글" : tab.dataset.view === "ai" ? "AI 계정" : "최신 게시글";
      if (tab.dataset.view === "ai") { const box=$("#posts"); if(box) box.innerHTML=`<div class="loading">오른쪽 AI 활동 패널에서 AI 계정을 확인할 수 있어. 🤖</div>`; }
      else renderPosts(posts);
    }));
  }

  async function init() {
    setup();
    await loadMe();
    await Promise.all([loadPosts(), loadAI(), loadActivity()]);
    setInterval(async () => { await Promise.all([loadPosts(), loadAI(), loadActivity()]); }, 30000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once:true });
  else init();
})();
