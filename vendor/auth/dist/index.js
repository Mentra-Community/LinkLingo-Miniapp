import * as jose from "jose";
const DEFAULT_JWKS_URL = "https://core.mentraglass.com/.well-known/jwks.json";
const DEFAULT_ISSUER = "cloud-core";
const DEFAULT_CLOCK_TOLERANCE = "2 minutes";
const DEFAULT_ALGORITHMS = ["EdDSA"];
const DEFAULT_CONTEXT_KEY = "mentraAuth";
export class MentraAuthError extends Error {
    constructor(message) {
        super(message);
        this.name = "MentraAuthError";
    }
}
export class MentraAuth {
    packageName;
    issuer;
    algorithms;
    clockTolerance;
    jwksUrl;
    jwks;
    constructor(options = {}) {
        this.packageName = resolvePackageName(options.packageName);
        this.issuer = resolveIssuer(options.issuer);
        this.algorithms = options.algorithms ?? [...DEFAULT_ALGORITHMS];
        this.clockTolerance = options.clockTolerance ?? DEFAULT_CLOCK_TOLERANCE;
        this.jwksUrl = resolveJwksUrl(options);
        this.jwks = jose.createRemoteJWKSet(new URL(this.jwksUrl), {
            timeoutDuration: options.timeoutMs ?? 5_000,
            cacheMaxAge: options.cacheMaxAgeMs,
            cooldownDuration: options.cooldownMs ?? 30_000,
        });
    }
    async verifyToken(token) {
        let payload;
        try {
            const result = await jose.jwtVerify(token, this.getJwks(), {
                issuer: this.issuer,
                audience: this.packageName,
                algorithms: this.algorithms,
                clockTolerance: this.clockTolerance,
            });
            payload = result.payload;
        }
        catch (err) {
            throw new MentraAuthError(`miniapp token rejected: ${err.message}`);
        }
        const subject = stringClaim(payload.sub);
        if (!subject) {
            throw new MentraAuthError("miniapp token missing subject");
        }
        return {
            mentraUserId: subject,
            oemId: stringClaim(payload.oemId),
            packageName: this.packageName,
            tokenId: stringClaim(payload.jti),
            expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
            issuedAt: typeof payload.iat === "number" ? payload.iat : undefined,
            claims: payload,
        };
    }
    async verifyAuthHeader(header) {
        return this.verifyToken(extractBearerToken(header));
    }
    async verifyRequest(request) {
        return this.verifyAuthHeader(request.headers.get("Authorization"));
    }
    hono(options = {}) {
        const contextKey = options.contextKey ?? DEFAULT_CONTEXT_KEY;
        return async (c, next) => {
            try {
                c.set(contextKey, await this.verifyAuthHeader(c.req.header("Authorization")));
                return await next();
            }
            catch (error) {
                if (error instanceof MentraAuthError) {
                    return options.onUnauthorized?.(error, c) ?? c.json({ error: error.message }, 401);
                }
                throw error;
            }
        };
    }
    getJwks() {
        return this.jwks;
    }
}
export function createMentraAuth(options = {}) {
    return new MentraAuth(options);
}
export async function verifyMentraToken(token, options = {}) {
    return createMentraAuth(options).verifyToken(token);
}
export async function verifyMentraAuthHeader(header, options = {}) {
    return createMentraAuth(options).verifyAuthHeader(header);
}
export function extractBearerToken(header) {
    const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
    if (!match?.[1]) {
        throw new MentraAuthError("missing bearer token");
    }
    return match[1];
}
export function mentraJwksUrl(options = {}) {
    return resolveJwksUrl(options);
}
function resolvePackageName(packageName) {
    const value = packageName ??
        env("MENTRA_PACKAGE_NAME") ??
        env("MINIAPP_PACKAGE_NAME") ??
        env("PACKAGE_NAME");
    if (!value) {
        throw new MentraAuthError("packageName is required");
    }
    return value;
}
function resolveJwksUrl(options) {
    return options.jwksUrl ?? env("MENTRA_AUTH_JWKS_URL") ?? DEFAULT_JWKS_URL;
}
function resolveIssuer(issuer) {
    if (Array.isArray(issuer))
        return issuer;
    if (issuer)
        return issuer;
    const issuers = env("MENTRA_AUTH_ISSUERS")
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    if (issuers && issuers.length > 0)
        return issuers;
    return env("MENTRA_AUTH_ISSUER") ?? DEFAULT_ISSUER;
}
function env(name) {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
}
function stringClaim(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
//# sourceMappingURL=index.js.map