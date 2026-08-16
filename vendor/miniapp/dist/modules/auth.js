const DEFAULT_MIN_TTL_MS = 30000;
export class AuthModule {
    constructor(session) {
        this.session = session;
    }
    get current() {
        return this.session._getAuth();
    }
    get mentraUserId() {
        return this.current?.mentraUserId ?? null;
    }
    get oemId() {
        return this.current?.oemId ?? null;
    }
    async getToken(options = {}) {
        const auth = await this.session._waitForAuth(options.minTtlMs ?? DEFAULT_MIN_TTL_MS);
        return auth.token;
    }
    async getAuthHeader(options = {}) {
        return `Bearer ${await this.getToken(options)}`;
    }
    async fetch(input, init = {}) {
        const { minTtlMs, ...requestInit } = init;
        const token = await this.getToken({ minTtlMs });
        const headers = mergeHeaders(requestInit.headers, { Authorization: `Bearer ${token}` });
        return fetch(input, { ...requestInit, headers });
    }
    onUpdate(handler) {
        return this.session.on("auth", handler);
    }
}
function mergeHeaders(base, next) {
    const headers = {};
    if (Array.isArray(base)) {
        for (const [key, value] of base) {
            headers[key] = value;
        }
    }
    else if (typeof Headers !== "undefined" && base instanceof Headers) {
        base.forEach((value, key) => {
            headers[key] = value;
        });
    }
    else if (base && typeof base === "object") {
        for (const [key, value] of Object.entries(base)) {
            if (typeof value === "string")
                headers[key] = value;
        }
    }
    return { ...headers, ...next };
}
//# sourceMappingURL=auth.js.map