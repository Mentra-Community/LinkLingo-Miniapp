/**
 * Ambient per-request context.
 *
 * Services are plain classes that know nothing about HTTP, so rather than
 * threading a logger through every call signature we stash the request
 * identifiers in AsyncLocalStorage and let the logger pick them up.
 */

import {AsyncLocalStorage} from "node:async_hooks"

export interface RequestContext {
  requestId: string
  route?: string
  userId?: string
}

const storage = new AsyncLocalStorage<RequestContext>()

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn)
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore()
}

/** Mutates the active context so late-arriving details still reach later logs. */
export function annotateRequestContext(fields: Partial<RequestContext>): void {
  const active = storage.getStore()
  if (!active) return
  Object.assign(active, fields)
}

export function newRequestId(): string {
  return crypto.randomUUID().slice(0, 8)
}
