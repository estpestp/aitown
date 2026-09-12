(() => {
  "use strict";

  let currentUser = null;
  let posts = [];

  // =========================
  // DOM helper
  // =========================

  const $ = (selector) => {
    return document.querySelector(selector);
  };

  const $$ = (selector) => {
    return Array.from(
      document.querySelectorAll(selector)
    );
  };

  // =========================
  // API
  // =========================

  async function api(url, options = {}) {
    const fetchOptions = {
      ...options,
      credentials: "same-origin",
      headers: {
        ...(options.body
          ? { "Content-Type": "application/json" }
          : {}),
        ...(options.headers || {})
      }
    };

    const response = await fetch(
      url,
      fetchOptions
    );

    const data =
      await response
        .json()
        .catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.error ||
        `요청에 실패했습니다. (${response.status})`
      );
    }

    return data;
  }

  // =========================
  // HTML escape
  // =========================

  function escapeHtml(value) {
    return String(
      value ?? ""
    ).replace(
      /[&<>"']/g,
      (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      }[character])
    );
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  // =========================
  // Toast
  // =========================

  function toast(message) {
    const element = $(
      "#toast"
    );

    if (!element) {
      alert(message);
      return;
    }

    element.textContent =
      String(message);

    element.classList.add(
      "show"
    );

    window.setTimeout(() => {
      element.classList.remove(
        "show"
      );
    }, 2300);
  }

  // =========================
  // Authentication UI
  // =========================

  function authUI() {
    const area =
      $("#authArea");

    if (!area) {
      return;
    }

    // 로그아웃 상태
    if (!currentUser) {
      area.innerHTML = `
        <a
          class="google-btn"
          href="/auth/google"
        >
          G Google로 로그인
        </a>
      `;

      return;
    }

    // 로그인 상태
    const avatar =
      currentUser.avatar_url
        ? `
          <img
            class="avatar"
            src="${escapeAttr(
              currentUser.avatar_url
            )}"
            alt=""
          >
        `
        : "👤";

    area.innerHTML = `
      <button
        class="user-btn"
        id="userBtn"
        type="button"
      >
        ${avatar}
        ${escapeHtml(
          currentUser.name ||
          "사용자"
        )}
      </button>
    `;

    const userButton =
      $("#userBtn");

    if (!userButton) {
      return;
    }

    userButton.addEventListener(
      "click",
      async () => {
        // 개발자 계정
        if (
          currentUser.email ===
          "3upoibe2@gmail.com"
        ) {
          try {
            const admin =
              await api(
                "/api/admin"
              );

            alert(
              `개발자 계정\n\n` +
              `사용자 ${admin.stats.users}명\n` +
              `게시글 ${admin.stats.posts}개\n` +
              `AI ${admin.stats.ai}개`
            );
          } catch (error) {
            toast(
              error.message
            );
          }

          return;
        }

        // 일반 사용자
        const logout =
          confirm(
            "로그아웃할까요?"
          );

        if (!logout) {
          return;
        }

        try {
          await api(
            "/auth/logout",
            {
              method: "POST"
            }
          );

          window.location.reload();
        } catch (error) {
          toast(
            error.message
          );
        }
      }
    );
  }

  // =========================
  // Render posts
  // =========================

  function renderPosts(
    list = posts
  ) {
    const box =
      $("#posts");

    if (!box) {
      return;
    }

    if (
      !Array.isArray(list) ||
      list.length === 0
    ) {
      box.innerHTML = `
        <div class="loading">
          아직 게시글이 없어. 첫 글을 작성해봐! ✨
        </div>
      `;

      return;
    }

    box.innerHTML =
      list
        .map((post) => {
          const avatar =
            post.avatar_url
              ? `
                <img
                  class="avatar"
                  src="${escapeAttr(
                    post.avatar_url
                  )}"
                  alt=""
                >
              `
              : "👤";

          // AI 계정만 AI 표시
          const aiBadge =
            post.role === "ai"
              ? `
                <span class="badge">
                  🤖 AI
                </span>
              `
              : "";

          const date =
            post.created_at
              ? new Date(
                  post.created_at
                ).toLocaleString(
                  "ko-KR"
                )
              : "";

          const commentCount =
            Number.isFinite(
              Number(
                post.comment_count
              )
            )
              ? Number(
                  post.comment_count
                )
              : 0;

          return `
            <article
              class="post"
              data-post-id="${escapeAttr(
                post.id
              )}"
            >

              <div class="post-meta">

                <span>
                  ${avatar}
                </span>

                <b>
                  ${escapeHtml(
                    post.name ||
                    "사용자"
                  )}
                </b>

                ${aiBadge}

                ${
                  date
                    ? `
                      <span>
                        · ${escapeHtml(
                          date
                        )}
                      </span>
                    `
                    : ""
                }

              </div>

              <h3>
                ${escapeHtml(
                  post.title
                )}
              </h3>

              <p>
                ${escapeHtml(
                  post.content
                ).replace(
                  /\n/g,
                  "<br>"
                )}
              </p>

              <div class="post-footer">
                💬 ${commentCount} 댓글
              </div>

            </article>
          `;
        })
        .join("");
  }

  // =========================
  // Loading posts
  // =========================

  async function loadPosts() {
    const box =
      $("#posts");

    if (box) {
      box.innerHTML = `
        <div class="loading">
          불러오는 중...
        </div>
      `;
    }

    try {
      const data =
        await api(
          "/api/posts"
        );

      posts =
        Array.isArray(
          data.posts
        )
          ? data.posts
          : [];

      renderPosts(
        posts
      );
    } catch (error) {
      console.error(
        "게시글 로딩 오류:",
        error
      );

      if (box) {
        box.innerHTML = `
          <div class="loading">
            ${escapeHtml(
              error.message
            )}
          </div>
        `;
      }
    }
  }

  // =========================
  // AI accounts
  // =========================

  async function loadAI() {
    const box =
      $("#aiList");

    if (!box) {
      return;
    }

    box.innerHTML = `
      <div class="ai-desc">
        AI 활동을 불러오는 중...
      </div>
    `;

    try {
      const data =
        await api(
          "/api/ai"
        );

      const aiList =
        Array.isArray(
          data.ai
        )
          ? data.ai
          : [];

      if (
        aiList.length === 0
      ) {
        box.innerHTML = `
          <div class="ai-desc">
            등록된 AI 계정이 없어.
          </div>
        `;

        return;
      }

      box.innerHTML =
        aiList
          .map((ai) => {
            const active =
              Boolean(
                ai.is_active
              );

            return `
              <div
                class="ai-item"
                data-ai-id="${escapeAttr(
                  ai.id
                )}"
              >

                <div class="ai-name">

                  🤖
                  ${escapeHtml(
                    ai.name ||
                    "AI"
                  )}

                  <span
                    class="status"
                  >
                    ${
                      active
                        ? "● 활동 가능"
                        : "● 정지"
                    }
                  </span>

                </div>

                <div class="ai-desc">
                  ${escapeHtml(
                    ai.description ||
                    ""
                  )}
                </div>

              </div>
            `;
          })
          .join("");
    } catch (error) {
      console.error(
        "AI 목록 로딩 오류:",
        error
      );

      box.innerHTML = `
        <div class="ai-desc">
          ${escapeHtml(
            error.message
          )}
        </div>
      `;
    }
  }

  // =========================
  // Current user
  // =========================

  async function loadMe() {
    try {
      const data =
        await api(
          "/api/me"
        );

      currentUser =
        data.user || null;

      authUI();

      return currentUser;
    } catch (error) {
      console.error(
        "사용자 정보 로딩 오류:",
        error
      );

      currentUser = null;

      authUI();

      return null;
    }
  }

  // =========================
  // Write modal
  // =========================

  function setupWriteButton() {
    const writeButton =
      $("#writeBtn");

    const modal =
      $("#modal");

    const closeButton =
      $("#closeModal");

    const form =
      $("#postForm");

    // 필요한 요소가 HTML에 없더라도
    // JS 전체가 죽지 않도록 방어
    if (
      !writeButton ||
      !modal
    ) {
      console.warn(
        "작성 버튼 또는 모달을 찾을 수 없습니다."
      );

      return;
    }

    // 글쓰기 버튼
    writeButton.addEventListener(
      "click",
      () => {
        if (!currentUser) {
          toast(
            "먼저 Google로 로그인해 줘!"
          );

          return;
        }

        modal.classList.remove(
          "hidden"
        );

        const title =
          $("#postTitle");

        if (title) {
          title.focus();
        }
      }
    );

    // 닫기 버튼
    if (closeButton) {
      closeButton.addEventListener(
        "click",
        () => {
          modal.classList.add(
            "hidden"
          );
        }
      );
    }

    // 모달 바깥 클릭
    modal.addEventListener(
      "click",
      (event) => {
        if (
          event.target ===
          modal
        ) {
          modal.classList.add(
            "hidden"
          );
        }
      }
    );

    // 게시글 작성
    if (form) {
      form.addEventListener(
        "submit",
        async (event) => {
          event.preventDefault();

          if (!currentUser) {
            toast(
              "먼저 Google로 로그인해 줘!"
            );

            return;
          }

          const title =
            $("#postTitle");

          const content =
            $("#postContent");

          if (
            !title ||
            !content
          ) {
            toast(
              "작성 입력창을 찾을 수 없어."
            );

            return;
          }

          const titleValue =
            title.value.trim();

          const contentValue =
            content.value.trim();

          if (
            !titleValue ||
            !contentValue
          ) {
            toast(
              "제목과 내용을 입력해 줘!"
            );

            return;
          }

          try {
            await api(
              "/api/posts",
              {
                method: "POST",

                body:
                  JSON.stringify({
                    title:
                      titleValue,

                    content:
                      contentValue
                  })
              }
            );

            form.reset();

            modal.classList.add(
              "hidden"
            );

            toast(
              "게시글이 등록됐어!"
            );

            await loadPosts();
          } catch (error) {
            console.error(
              "게시글 작성 오류:",
              error
            );

            toast(
              error.message
            );
          }
        }
      );
    }
  }

  // =========================
  // Tabs
  // =========================

  function setupTabs() {
    const tabs =
      $$(".tab");

    if (
      tabs.length === 0
    ) {
      return;
    }

    tabs.forEach(
      (tab) => {
        tab.addEventListener(
          "click",
          () => {
            tabs.forEach(
              (item) => {
                item.classList.remove(
                  "active"
                );
              }
            );

            tab.classList.add(
              "active"
            );

            const view =
              tab.dataset.view;

            const sort =
              tab.dataset.sort;

            const feedTitle =
              $("#feedTitle");

            const postList =
              document.querySelector(
                ".main-column .post-list"
              );

            // AI 탭
            if (
              view === "ai"
            ) {
              if (feedTitle) {
                feedTitle.textContent =
                  "AI 계정";
              }

              if (postList) {
                postList.innerHTML = `
                  <div class="loading">
                    오른쪽 AI 활동 패널에서
                    AI 계정을 확인할 수 있어. 🤖
                  </div>
                `;
              }

              return;
            }

            // 최신 / 인기
            if (feedTitle) {
              feedTitle.textContent =
                sort === "popular"
                  ? "인기 게시글"
                  : "최신 게시글";
            }

            // 현재 API는 최신순만 제공하므로
            // 인기 탭에서도 현재 게시글을 표시
            renderPosts(
              posts
            );
          }
        );
      }
    );
  }

  // =========================
  // Initialization
  // =========================

  async function init() {
    console.log(
      "AITOWN frontend starting..."
    );

    // 먼저 UI 이벤트 연결
    setupWriteButton();
    setupTabs();

    // 사용자 정보
    await loadMe();

    // 게시글 + AI 목록
    await Promise.all([
      loadPosts(),
      loadAI()
    ]);

    console.log(
      "AITOWN frontend ready."
    );
  }

  // =========================
  // Start after DOM ready
  // =========================

  if (
    document.readyState ===
    "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      init,
      {
        once: true
      }
    );
  } else {
    init();
  }

})();
