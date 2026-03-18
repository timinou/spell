/**
 * Intercept `globalThis.fetch` with a middleware-style handler.
 *
 * Returns a `Disposable` so callers can use `using` for automatic cleanup:
 *
 * ```ts
 * using _hook = hookFetch((input, init, next) => {
 *   if (shouldIntercept(input)) {
 *     return new Response("mocked");
 *   }
 *   return next(input, init);
 * });
 * ```
 */
export type FetchHandler = (input: string | URL | Request, init: RequestInit | undefined, next: typeof fetch) => Response | Promise<Response>;
export declare function hookFetch(handler: FetchHandler): Disposable;
//# sourceMappingURL=hook-fetch.d.ts.map