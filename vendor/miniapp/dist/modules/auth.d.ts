import type { MiniappSession, MiniappAuthState } from "../session";
export interface AuthFetchOptions extends RequestInit {
    /**
     * Minimum remaining token lifetime before using the current token. Defaults to
     * 30 seconds. If the token is absent or too close to expiry, the call waits
     * for the host's next auth update.
     */
    minTtlMs?: number;
}
export declare class AuthModule {
    private readonly session;
    constructor(session: MiniappSession);
    get current(): MiniappAuthState | null;
    get mentraUserId(): string | null;
    get oemId(): string | null;
    getToken(options?: {
        minTtlMs?: number;
    }): Promise<string>;
    getAuthHeader(options?: {
        minTtlMs?: number;
    }): Promise<string>;
    fetch(input: RequestInfo | URL, init?: AuthFetchOptions): Promise<Response>;
    onUpdate(handler: (auth: MiniappAuthState) => void): () => void;
}
//# sourceMappingURL=auth.d.ts.map