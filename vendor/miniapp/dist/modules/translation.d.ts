/**
 * @fileoverview TranslationModule — top-level translation API.
 *
 * Mirrors cloud SDK v3's TranslationManager surface:
 *
 *   session.translation.on(handler)                          // any pair
 *   session.translation.to(target, handler)                  // any-source → target
 *   session.translation.to([targets], handler)               // any-source → many
 *   session.translation.fromTo(source, target, handler)      // specific pair
 *   session.translation.fromTo(source, [targets], handler)   // source → many
 *   session.translation.stop()                                // tear down all
 *
 * Internally each subscribe registers against a `translation:<source>:<target>`
 * stream pattern; LocalMiniappRuntime's wildcard matcher routes incoming
 * `translation:<src>:<dst>` events to any matching `*` patterns.
 *
 * MICROPHONE permission required.
 */
import { MiniappSession } from "../session";
import type { TranslationData, UnsubscribeFn } from "./events";
export type TranslationHandler = (data: TranslationData) => void;
export declare class TranslationModule {
    private readonly session;
    private readonly unsubs;
    constructor(session: MiniappSession);
    /**
     * Subscribe to every translation event from the cloud, regardless of
     * source or target language.
     *
     * Uses the wildcard stream `translation:*:*` — cheap to register on the
     * client, expensive on the cloud side (cloud fans every active pair out
     * to this subscriber). Prefer `to` or `fromTo` when you know the
     * language(s) you care about.
     */
    on(handler: TranslationHandler): UnsubscribeFn;
    /**
     * Subscribe to any translation that lands at the given target language(s),
     * regardless of source. Useful for "I'm a Spanish speaker, translate
     * whatever I hear to Spanish."
     */
    to(target: string | string[], handler: TranslationHandler): UnsubscribeFn;
    /**
     * Subscribe to a specific source → target translation pair. Pass an
     * array for `target` to fan a single handler across multiple targets
     * from the same source.
     */
    fromTo(source: string, target: string | string[], handler: TranslationHandler): UnsubscribeFn;
    /**
     * @deprecated Renamed to `fromTo(source, target, handler)` for cloud
     * SDK v3 parity. This alias will be removed in a future release.
     */
    forLanguagePair(fromLang: string, toLang: string, handler: TranslationHandler): UnsubscribeFn;
    /** Tear down every translation subscription this module owns. */
    stop(): void;
    /** True iff `MICROPHONE` is declared in the miniapp's manifest. */
    get hasPermission(): boolean;
    private track;
}
//# sourceMappingURL=translation.d.ts.map