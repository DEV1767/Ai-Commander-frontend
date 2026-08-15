/* ==========================================================================
   AI COMMANDER — centralized API layer
   --------------------------------------------------------------------------
   Every network call the frontend makes goes through this file. Nothing
   else should call fetch() directly against the backend.

   ENDPOINT NOTES
   --------------------------------------------------------------------------
   Paths marked CONFIRMED come straight from the working prototype
   (index-Copy.html/js) and are known to exist on the backend:
     POST /auth/login
     POST /auth/signup
     GET  /errors/vscode
     GET  /errors/vercel
     POST /analyze          (returns { raw_text, error, description, risk,
                              logs, tech_stack, explanation, prevention })

   Paths marked ASSUMED are reasonable guesses for endpoints the spec
   describes (get current user, logout, history, integrations, settings)
   but that weren't present in the prototype. They're written so a 404/
   network failure degrades gracefully instead of breaking the UI — swap
   them for the real routes once confirmed against the FastAPI backend.

   BASE URL
   --------------------------------------------------------------------------
   There's no build step here (plain HTML/JS, not Vite), so instead of
   import.meta.env.VITE_API_URL we read a runtime-configurable value from
   localStorage, defaulting to http://localhost:8000. It can be changed
   from the "Advanced" panel on the auth screen or from Settings.
   ========================================================================== */

const DEFAULT_BASE_URL = "https://ai-commander-vscode-backend.vercel.app";
const STORAGE_KEYS = {
    base: "aic_api_base",
    token: "aic_token",
    user: "aic_user"
};

function getBaseUrl() {
    return localStorage.getItem(STORAGE_KEYS.base) || DEFAULT_BASE_URL;
}

function setBaseUrl(url) {
    if (url) localStorage.setItem(STORAGE_KEYS.base, url.trim().replace(/\/+$/, ""));
}

function getToken() {
    return localStorage.getItem(STORAGE_KEYS.token);
}

function setToken(token) {
    if (token) localStorage.setItem(STORAGE_KEYS.token, token);
}

function clearToken() {
    localStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem(STORAGE_KEYS.user);
}

function getStoredUser() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEYS.user) || "null");
    } catch {
        return null;
    }
}

function setStoredUser(user) {
    if (user) localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user));
}

class ApiError extends Error {
    constructor(message, status, data) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.data = data;
    }
}

/**
 * Low-level request helper. Attaches the bearer token (if the backend uses
 * JWT) AND sends credentials:'include' (if the backend uses httpOnly
 * cookies instead) — both are harmless if unused, so the frontend works
 * against either auth style without changes.
 */
const NO_REFRESH_PATHS = ["/api/auth/refresh", "/api/auth/login", "/api/auth/register", "/api/auth/logout"];

async function request(path, { method = "GET", body, auth = true, timeoutMs = 15000, _retried = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers = { "Content-Type": "application/json" };
    const token = getToken();
    if (auth && token) headers.Authorization = `Bearer ${token}`;

    let res;
    try {
        res = await fetch(getBaseUrl() + path, {
            method,
            headers,
            credentials: "include",
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
    } catch (err) {
        clearTimeout(timer);
        if (err.name === "AbortError") {
            throw new ApiError("Request timed out. Is the backend reachable?", 0, null);
        }
        throw new ApiError("Couldn't reach the AI Commander backend.", 0, null);
    }
    clearTimeout(timer);

    let data = null;
    const text = await res.text();
    if (text) {
        try { data = JSON.parse(text); } catch { data = text; }
    }

    if (res.status === 401) {
        // Access-token cookie may have simply expired. Try the refresh
        // route once (GET /api/auth/refresh, confirmed route) and, if it
        // succeeds, retry the original request a single time before
        // giving up and treating the user as logged out.
        if (auth && !_retried && !NO_REFRESH_PATHS.includes(path)) {
            try {
                const refreshRes = await fetch(getBaseUrl() + "/api/auth/refresh", { method: "GET", credentials: "include" });
                if (refreshRes.ok) {
                    return request(path, { method, body, auth, timeoutMs, _retried: true });
                }
            } catch {
                // refresh attempt failed — fall through to logging out below
            }
        }
        clearToken();
        localStorage.removeItem("aic_has_session");
        window.dispatchEvent(new CustomEvent("auth:unauthorized"));
        throw new ApiError("Your session expired. Log in again.", 401, data);
    }

    if (!res.ok) {
        const message = (data && (data.detail || data.message)) || `Request failed (${res.status})`;
        throw new ApiError(message, res.status, data);
    }

    return data;
}

const auth = {
    // The real backend issues an httpOnly cookie (cookieParser + CORS with
    // credentials:true) rather than returning a token in the JSON body, so
    // client-side JS can't read it directly. This flag is just a UI hint —
    // the actual source of truth is whichever request the app makes next
    // succeeding or failing with 401.
    isAuthenticated: () => localStorage.getItem("aic_has_session") === "1",
    getStoredUser,
    setStoredUser,
    clearSession: () => { clearToken(); localStorage.removeItem("aic_has_session"); }
};

const api = {
    // ---- Auth — CONFIRMED from backend router: routes live under /api/auth ----
    async login(email, password) {
        const data = await request("/api/auth/login", { method: "POST", auth: false, body: { email, password } });
        const token = data?.token || data?.access_token || data?.accessToken;
        if (token) setToken(token); // harmless no-op if the backend only sets a cookie
        localStorage.setItem("aic_has_session", "1");
        const user = data?.user || (data && data.email ? data : { email });
        setStoredUser(user);
        return data;
    },

    // NOTE: real route is POST /api/auth/register (not /signup). Field
    // names (name/email/password) are still a guess — confirm against
    // registerUser in auth.controller.js and adjust if it expects
    // something like "username" instead of "name".
    async signup(name, email, password) {
        const data = await request("/api/auth/register", { method: "POST", auth: false, body: { name, email, password } });
        const token = data?.token || data?.access_token || data?.accessToken;
        if (token) setToken(token);
        localStorage.setItem("aic_has_session", "1");
        const user = data?.user || (data && data.email ? data : { name, email });
        setStoredUser(user);
        return data;
    },

    async logout() {
        try {
            await request("/api/auth/logout", { method: "POST" });
        } catch {
            // Even if the backend call fails, clear the local session hint
            // below so the UI reflects "logged out" immediately.
        }
        auth.clearSession();
    },

    // Confirmed route: GET /api/auth/refresh — issues a new access-token
    // cookie from the refresh-token cookie. Used automatically by
    // request() when a call comes back 401.
    async refreshSession() {
        return request("/api/auth/refresh", { method: "GET", auth: false });
    },

    async getCurrentUser() {
        try {
            const data = await request("/api/auth/me"); // confirmed, JWT-protected
            if (data) {
                setStoredUser(data);
                localStorage.setItem("aic_has_session", "1");
            }
            return data;
        } catch {
            return getStoredUser();
        }
    },

    // ---- AI Commander — CONFIRMED shape from /analyze ----
    async sendCommand(query) {
        // ASSUMED request field name ("query"). Backend confirmed to
        // return { raw_text, error, description, risk, logs, tech_stack,
        // explanation, prevention } from this endpoint.
        return request("/analyze", { method: "POST", body: { query } });
    },

    // ---- History — ASSUMED, falls back to local cache if unavailable ----
    async getHistory() {
        return request("/history");
    },

    // ---- Live error feeds — CONFIRMED: /errors/vscode, /errors/vercel ----
    async getErrors(source) {
        const path = source === "vercel" ? "/errors/vercel" : "/errors/vscode";
        return request(path);
    },

    // ---- Integrations — ASSUMED ----
    async getIntegrations() {
        return request("/integrations");
    },

    async connectIntegration(name) {
        return request(`/integrations/${name}/connect`, { method: "POST" });
    },

    // ---- Settings — ASSUMED ----
    async updateSettings(payload) {
        return request("/settings", { method: "PATCH", body: payload });
    },

    // ---- VS Code extension login handoff — ASSUMED mount path ----
    // Calls the backend's creatExtensioncode controller. It's
    // verifyJwt-protected, so this relies on request() already sending
    // the session cookie (credentials:'include') and/or bearer token.
    // ⚠️ Confirm the real mount prefix against your server.js — this
    // assumes the extension router is mounted at /api/extension, matching
    // the /api/auth convention used elsewhere in this file. If it's
    // mounted differently (e.g. just /extension), update this one path.
    async createExtensionCode() {
        return request("/api/extension/create-token", { method: "POST" });
    }
};

const config = { getBaseUrl, setBaseUrl, DEFAULT_BASE_URL };

// Plain global (not an ES module export) so this file can be opened
// directly from disk (file://) as well as served over http/https.
window.AICommander = { api, auth, config, ApiError };