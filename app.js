if (window.__aiCommanderAppLoaded) {
    console.warn("app.js was loaded more than once — skipping the second load. Check index.html for a duplicate <script src=\"app.js\"> tag.");
} else {
    window.__aiCommanderAppLoaded = true;
    initAICommanderApp();
}

function initAICommanderApp() {

const { api, auth, config, ApiError } = window.AICommander;

/* ==========================================================================
   AI COMMANDER — app shell (simplified)

   Flow: extension opens this page -> user logs in / signs up -> app shell
   shows the live output feed (VS Code tab active, Vercel tab for later).
   ========================================================================== */

const state = {
    incidents: { vscode: [], vercel: [] },
    seenKeys: { vscode: new Set(), vercel: new Set() },
    polling: false,
    timer: null,
    hideResolved: { vscode: false, vercel: false }
};

/* ---------------------------------------------------------------------
   Helpers
   --------------------------------------------------------------------- */

function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[s]));
}

function riskClass(risk) {
    const r = (risk || "medium").toLowerCase();
    return ["critical", "high", "medium", "low"].includes(r) ? r : "medium";
}

function fingerprint(item) {
    return (item.error || "") + "::" + (item.raw_text || item.logs || "").slice(0, 120);
}

function showToast(message, isError = false) {
    const stack = document.getElementById("toastStack");
    const toast = document.createElement("div");
    toast.className = "toast" + (isError ? " error" : "");
    toast.textContent = message;
    stack.appendChild(toast);
    setTimeout(() => toast.remove(), 2800);
}

function timeAgoLabel(ts) {
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (mins < 1) return "just now";
    if (mins === 1) return "1 min ago";
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
}

function friendlyError(err) {
    if (err instanceof ApiError) {
        if (err.status === 0) return "AI Commander couldn't connect to the server. Check the backend URL.";
        if (err.status === 401 || err.status === 403) return "You're not authorized. Try logging in again.";
        if (err.status === 404) return "That endpoint isn't available yet.";
        if (err.status >= 500) return "The backend hit an error processing that request.";
        return err.message;
    }
    return "Something went wrong.";
}

/* ---------------------------------------------------------------------
   Screen switching: auth <-> app
   --------------------------------------------------------------------- */

function showAuth(tab = "login") {
    document.getElementById("authScreen").classList.remove("hidden");
    document.getElementById("appShell").classList.add("app-shell-hidden");
    setAuthTab(tab);
}

async function showApp() {
    document.getElementById("authScreen").classList.add("hidden");
    document.getElementById("appShell").classList.remove("app-shell-hidden");

    const user = await api.getCurrentUser();
    applyUserToUI(user);
}

function applyUserToUI(user) {
    const initial = (user?.name || user?.email || "?").trim().charAt(0).toUpperCase();
    document.getElementById("userName").textContent = user?.name || user?.email || "Account";
    document.getElementById("userAvatar").textContent = initial || "?";
}

/* ---------------------------------------------------------------------
   Auth: login / signup
   --------------------------------------------------------------------- */

function setAuthTab(tab) {
    document.querySelectorAll(".auth-tab").forEach(t => t.classList.toggle("active", t.dataset.auth === tab));
    document.getElementById("loginForm").classList.toggle("hidden", tab !== "login");
    document.getElementById("signupForm").classList.toggle("hidden", tab !== "signup");
}

function wireAuth() {
    document.querySelectorAll(".auth-tab").forEach(tab => {
        tab.addEventListener("click", () => setAuthTab(tab.dataset.auth));
    });

    document.getElementById("apiBaseInput").value = config.getBaseUrl();
    document.getElementById("btnSaveApiBase").addEventListener("click", () => {
        const val = document.getElementById("apiBaseInput").value.trim();
        if (val) { config.setBaseUrl(val); showToast("Backend URL saved."); }
    });

    document.getElementById("loginForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const errEl = document.getElementById("loginError");
        const btn = document.getElementById("btnLogin");
        errEl.textContent = "";
        btn.disabled = true;
        btn.textContent = "Logging in…";
        try {
            const email = document.getElementById("loginEmail").value.trim();
            const password = document.getElementById("loginPassword").value;
            await api.login(email, password);
            showToast("Welcome back.");
            await showApp();
        } catch (err) {
            errEl.textContent = friendlyError(err);
        } finally {
            btn.disabled = false;
            btn.textContent = "Log in";
        }
    });

    document.getElementById("signupForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const errEl = document.getElementById("signupError");
        const btn = document.getElementById("btnSignup");
        errEl.textContent = "";
        btn.disabled = true;
        btn.textContent = "Creating account…";
        try {
            const name = document.getElementById("signupName").value.trim();
            const email = document.getElementById("signupEmail").value.trim();
            const password = document.getElementById("signupPassword").value;
            await api.signup(name, email, password);
            showToast("Account created.");
            await showApp();
        } catch (err) {
            errEl.textContent = friendlyError(err);
        } finally {
            btn.disabled = false;
            btn.textContent = "Create account";
        }
    });
}

function wireLogout() {
    document.getElementById("btnLogout").addEventListener("click", async () => {
        stopPolling();
        await api.logout();
        showToast("Logged out.");
        showAuth("login");
    });
}

window.addEventListener("auth:unauthorized", () => {
    stopPolling();
    showToast("Session expired. Please log in again.", true);
    showAuth("login");
});

/* ---------------------------------------------------------------------
   Rendering the output feed
   --------------------------------------------------------------------- */

function cardHTML(item) {
    const rc = riskClass(item.risk);
    const openClass = item.open ? " open" : "";
    const resolvedClass = item.resolved ? " resolved" : "";
    return `
    <div class="err-card risk-${rc}${openClass}${resolvedClass}" data-id="${item.id}">
      <div class="err-head" data-toggle="${item.id}">
        <div class="err-head-left">
          <div class="err-title">${escapeHtml(item.error || "Unknown error")}</div>
          <div class="err-meta">
            <span class="risk-badge ${rc}">${escapeHtml(item.risk || "Medium")}</span>
            ${item.tech_stack ? `<span class="tech-chip">${escapeHtml(item.tech_stack)}</span>` : ""}
            <span class="err-time">${timeAgoLabel(item.receivedAt)}</span>
            ${item.resolved ? `<span class="tech-chip">Resolved</span>` : ""}
          </div>
        </div>
        <svg class="err-toggle" width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M5 8l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="err-body">
        ${item.description ? `<div class="err-block"><div class="err-block-label">Description</div><p>${escapeHtml(item.description)}</p></div>` : ""}
        ${item.explanation ? `<div class="err-block"><div class="err-block-label">Explanation</div><p>${escapeHtml(item.explanation)}</p></div>` : ""}
        ${item.prevention ? `<div class="err-block"><div class="err-block-label">Prevention</div><p>${escapeHtml(item.prevention)}</p></div>` : ""}
        <div class="err-block">
          <div class="err-block-label">Logs</div>
          <pre class="err-logs">${escapeHtml(item.logs || item.raw_text || "—")}</pre>
        </div>
        <div class="err-actions">
          <button data-copy="${item.id}">Copy</button>
          <button data-resolve="${item.id}" class="resolve-btn${item.resolved ? " done" : ""}">${item.resolved ? "Resolved ✓" : "Mark resolved"}</button>
        </div>
      </div>
    </div>
  `;
}

function renderFeed(source) {
    const el = document.getElementById("feed-" + source);
    let list = state.incidents[source];
    if (state.hideResolved[source]) list = list.filter(i => !i.resolved);

    if (!list.length) {
        const url = document.getElementById(source + "Url").value || "—";
        const label = source === "vscode" ? "output" : "errors";
        el.innerHTML = `<div class="empty-state">Waiting for ${label} from <span class="mono">${escapeHtml(url)}</span>…</div>`;
        return;
    }
    el.innerHTML = list.map(cardHTML).join("");
}

function renderCounts() {
    document.getElementById("countVscode").textContent = state.incidents.vscode.filter(i => !i.resolved).length;
    document.getElementById("countVercel").textContent = state.incidents.vercel.filter(i => !i.resolved).length;
}

/* ---------------------------------------------------------------------
   Incoming data / polling
   --------------------------------------------------------------------- */

function normalizeIncoming(raw) {
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr.filter(Boolean);
}

function ingest(source, rawList) {
    let addedCount = 0;
    rawList.forEach(raw => {
        const key = fingerprint(raw);
        if (state.seenKeys[source].has(key)) return;
        state.seenKeys[source].add(key);

        state.incidents[source].unshift({
            id: source + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
            error: raw.error,
            description: raw.description,
            risk: raw.risk,
            logs: raw.logs,
            raw_text: raw.raw_text,
            tech_stack: raw.tech_stack,
            explanation: raw.explanation,
            prevention: raw.prevention,
            receivedAt: Date.now(),
            resolved: false,
            open: false
        });
        addedCount++;
    });

    if (addedCount > 0) {
        renderFeed(source);
        renderCounts();
        showToast(`${addedCount} new ${source === "vscode" ? "VS Code" : "Vercel"} result${addedCount > 1 ? "s" : ""} received`);
    }
}

async function pollOnce() {
    const vscodeUrl = document.getElementById("vscodeUrl").value.trim();
    const vercelUrl = document.getElementById("vercelUrl").value.trim();
    let anyOk = false;

    await Promise.all([
        (async () => {
            if (!vscodeUrl) return;
            try {
                const res = await fetch(vscodeUrl, { credentials: "include" });
                if (!res.ok) throw new Error("bad status");
                const data = await res.json();
                ingest("vscode", normalizeIncoming(data));
                anyOk = true;
            } catch { /* endpoint not reachable yet — stay quiet, keep retrying */ }
        })(),
        (async () => {
            if (!vercelUrl) return;
            try {
                const res = await fetch(vercelUrl, { credentials: "include" });
                if (!res.ok) throw new Error("bad status");
                const data = await res.json();
                ingest("vercel", normalizeIncoming(data));
                anyOk = true;
            } catch { /* endpoint not reachable yet — stay quiet, keep retrying */ }
        })()
    ]);

    updateConnectionStatus(anyOk);
}

function updateConnectionStatus(ok) {
    const dot = document.getElementById("connDot");
    const text = document.getElementById("connText");
    if (!state.polling) {
        dot.className = "status-dot";
        text.textContent = "Not connected";
        return;
    }
    if (ok) {
        dot.className = "status-dot on";
        text.textContent = "Listening";
    } else {
        dot.className = "status-dot err";
        text.textContent = "Listening… endpoint unreachable";
    }
}

function startPolling() {
    if (state.polling) return;
    state.polling = true;
    document.getElementById("btnConnect").textContent = "Stop listening";
    document.getElementById("btnConnect").classList.add("stop");
    document.getElementById("emptyUrlVscode").textContent = document.getElementById("vscodeUrl").value || "—";
    document.getElementById("emptyUrlVercel").textContent = document.getElementById("vercelUrl").value || "—";

    const interval = parseInt(document.getElementById("pollInterval").value, 10);
    pollOnce();
    state.timer = setInterval(pollOnce, interval);
    updateConnectionStatus(false);
}

function stopPolling() {
    state.polling = false;
    clearInterval(state.timer);
    document.getElementById("btnConnect").textContent = "Start listening";
    document.getElementById("btnConnect").classList.remove("stop");
    updateConnectionStatus(false);
}

/* ---------------------------------------------------------------------
   Event wiring
   --------------------------------------------------------------------- */

function wireTabs() {
    document.querySelectorAll(".tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === tab));
            document.querySelectorAll(".source-panel").forEach(p => p.classList.remove("active"));
            document.getElementById("panel-" + tab.getAttribute("data-source")).classList.add("active");
        });
    });
}

function wireConnect() {
    document.getElementById("btnConnect").addEventListener("click", () => {
        if (state.polling) stopPolling(); else startPolling();
    });
}

function wireFeedActions() {
    document.querySelectorAll(".feed").forEach(feed => {
        feed.addEventListener("click", (e) => {
            const toggle = e.target.closest("[data-toggle]");
            const copyBtn = e.target.closest("[data-copy]");
            const resolveBtn = e.target.closest("[data-resolve]");
            const source = feed.id.replace("feed-", "");

            if (copyBtn) {
                const id = copyBtn.getAttribute("data-copy");
                const item = state.incidents[source].find(i => i.id === id);
                if (item) {
                    const text = `${item.error}\n${item.logs || item.raw_text || ""}`;
                    navigator.clipboard?.writeText(text).then(() => showToast("Copied to clipboard"));
                }
                return;
            }
            if (resolveBtn) {
                const id = resolveBtn.getAttribute("data-resolve");
                const item = state.incidents[source].find(i => i.id === id);
                if (item) {
                    item.resolved = !item.resolved;
                    renderFeed(source);
                    renderCounts();
                }
                return;
            }
            if (toggle) {
                const id = toggle.getAttribute("data-toggle");
                const item = state.incidents[source].find(i => i.id === id);
                if (item) {
                    item.open = !item.open;
                    renderFeed(source);
                }
            }
        });
    });

    document.querySelectorAll(".hideResolved").forEach(cb => {
        cb.addEventListener("change", () => {
            const source = cb.getAttribute("data-source");
            state.hideResolved[source] = cb.checked;
            renderFeed(source);
        });
    });

    document.querySelectorAll("[data-clear]").forEach(btn => {
        btn.addEventListener("click", () => {
            const source = btn.getAttribute("data-clear");
            state.incidents[source] = [];
            state.seenKeys[source] = new Set();
            renderFeed(source);
            renderCounts();
        });
    });
}

/* ---------------------------------------------------------------------
   Init
   --------------------------------------------------------------------- */

async function init() {
    wireAuth();
    wireLogout();
    wireTabs();
    wireConnect();
    wireFeedActions();
    renderFeed("vscode");
    renderFeed("vercel");
    renderCounts();

    // Cookie-based session (backend uses cookieParser + JWT). Confirm
    // against the backend on load rather than trusting a local flag.
    if (auth.isAuthenticated()) {
        try {
            const user = await api.getCurrentUser();
            if (user) { await showApp(); return; }
        } catch { /* fall through to auth screen below */ }
        auth.clearSession();
    }
    showAuth("login");
}

document.addEventListener("DOMContentLoaded", init);

} // end initAICommanderApp