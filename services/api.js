/* ==========================================================================
   AI COMMANDER — centralized API layer
   --------------------------------------------------------------------------
   Every network call the frontend makes goes through this file. Nothing
   else should call fetch() directly against the backend.
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
    isAuthenticated: () => localStorage.getItem("aic_has_session") === "1",
    getStoredUser,
    setStoredUser,
    clearSession: () => { clearToken(); localStorage.removeItem("aic_has_session"); }
};

const api = {
    async login(email, password) {
        const data = await request("/api/auth/login", { method: "POST", auth: false, body: { email, password } });
        const token = data?.token || data?.access_token || data?.accessToken;
        if (token) setToken(token);
        localStorage.setItem("aic_has_session", "1");
        const user = data?.user || (data && data.email ? data : { email });
        setStoredUser(user);
        return data;
    },

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

    async refreshSession() {
        return request("/api/auth/refresh", { method: "GET", auth: false });
    },

    async getCurrentUser() {
        try {
            const data = await request("/api/auth/me");
            if (data) {
                setStoredUser(data);
                localStorage.setItem("aic_has_session", "1");
            }
            return data;
        } catch {
            return getStoredUser();
        }
    },

    // ---- Live error feeds ----
    // vscode: our own backend, saved from the extension's /analyze calls.
    // vercel: not wired up yet — kept as a placeholder path for later.
    async getErrors(source) {
        const path = source === "vercel" ? "/errors/vercel" : "/api/commander/errors/vscode";
        return request(path);
    },

    // ---- VS Code extension login handoff ----
    async createExtensionCode() {
        return request("/api/extension/create-token", { method: "POST" });
    }
};

const config = { getBaseUrl, setBaseUrl, DEFAULT_BASE_URL };

window.AICommander = { api, auth, config, ApiError };