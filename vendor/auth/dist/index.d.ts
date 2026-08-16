import * as jose from "jose";
export interface VerifiedMentraAuth {
    mentraUserId: string;
    oemId?: string;
    packageName: string;
    tokenId?: string;
    expiresAt?: number;
    issuedAt?: number;
    claims: jose.JWTPayload;
}
export interface MentraAuthOptions {
    /**
     * The packageName this backend serves. Miniapp auth tokens are audience-pinned
     * to exactly one packageName, so this should be the miniapp's packageName.
     */
    packageName?: string;
    /**
     * Explicit JWKS URL. Defaults to the production Cloud Core JWKS endpoint.
     * Override for local, staging, test, or self-hosted Core deployments.
     */
    jwksUrl?: string;
    /**
     * Expected token issuer.
     */
    issuer?: string | string[];
    /**
     * Allowed signature algorithms. Defaults to EdDSA.
     */
    algorithms?: string[];
    /**
     * jose clockTolerance option. Defaults to two minutes for mobile clock skew.
     */
    clockTolerance?: string | number;
    /**
     * Remote JWKS fetch timeout in milliseconds.
     */
    timeoutMs?: number;
    /**
     * Remote JWKS cache max age in milliseconds.
     */
    cacheMaxAgeMs?: number;
    /**
     * Remote JWKS cooldown duration in milliseconds.
     */
    cooldownMs?: number;
}
export interface MentraAuthVariables {
    mentraAuth: VerifiedMentraAuth;
}
export interface MentraHonoOptions {
    /**
     * Hono context variable key. Defaults to "mentraAuth".
     */
    contextKey?: string;
    /**
     * Custom response for missing or rejected auth. Defaults to JSON 401.
     */
    onUnauthorized?: (error: MentraAuthError, c: HonoLikeContext) => Response | Promise<Response>;
}
export interface HonoLikeContext {
    req: {
        header(name: string): string | undefined;
    };
    set(key: string, value: unknown): void;
    json(body: unknown, status?: number): Response;
}
export type HonoLikeNext = () => Promise<void>;
export type HonoLikeMiddleware = (c: HonoLikeContext, next: HonoLikeNext) => Promise<Response | void>;
export declare class MentraAuthError extends Error {
    constructor(message: string);
}
export declare class MentraAuth {
    private readonly packageName;
    private readonly issuer;
    private readonly algorithms;
    private readonly clockTolerance;
    private readonly jwksUrl;
    private readonly jwks;
    constructor(options?: MentraAuthOptions);
    verifyToken(token: string): Promise<VerifiedMentraAuth>;
    verifyAuthHeader(header: string | undefined | null): Promise<VerifiedMentraAuth>;
    verifyRequest(request: Request): Promise<VerifiedMentraAuth>;
    hono(options?: MentraHonoOptions): HonoLikeMiddleware;
    private getJwks;
}
export declare function createMentraAuth(options?: MentraAuthOptions): MentraAuth;
export declare function verifyMentraToken(token: string, options?: MentraAuthOptions): Promise<VerifiedMentraAuth>;
export declare function verifyMentraAuthHeader(header: string | undefined | null, options?: MentraAuthOptions): Promise<VerifiedMentraAuth>;
export declare function extractBearerToken(header: string | undefined | null): string;
export declare function mentraJwksUrl(options?: Pick<MentraAuthOptions, "jwksUrl">): string;
//# sourceMappingURL=index.d.ts.map