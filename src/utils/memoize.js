/**
 * Generic memoisation utilities for load-expensive pure tasks.
 *
 * - `memoize` for synchronous pure functions.
 * - `memoizeAsync` for async functions (dedupes in-flight promises).
 *
 * Keying defaults to `JSON.stringify(args)` (matching the classic snippet),
 * with a safe fallback for circular / BigInt / non-serializable args.
 * LRU eviction via Map insertion order + optional TTL keeps memory bounded.
 * Every wrapper exposes `.cache`, `.clear()`, `.delete(...args)` and `.stats`.
 *
 * Do NOT memoize:
 * - LLM / network / DB / filesystem writes (non-deterministic, side effects)
 * - functions whose inputs mutate, or that depend on wall-clock / env vars
 *   unless you pass a short `ttlMs`.
 */

function fallbackKey(args) {
    // Stable-ish fallback when JSON.stringify throws (circular, BigInt, etc.)
    return args
        .map((a) => {
            if (a === null) return "null";
            if (a === undefined) return "undefined";
            const t = typeof a;
            if (t === "string") return `str:${a}`;
            if (t === "number" || t === "boolean" || t === "bigint") return `${t}:${String(a)}`;
            if (t === "function") return `fn:${a.name || "anon"}`;
            try {
                if (typeof a === "object") {
                    const keys = Object.keys(a).sort().slice(0, 50);
                    return `obj:${a.constructor?.name || "Object"}:${keys.join(",")}:${String(a).slice(0, 100)}`;
                }
            } catch {}
            return `${t}:${String(a).slice(0, 100)}`;
        })
        .join("|");
}

export function defaultKeyResolver(...args) {
    if (args.length === 0) return "__noargs__";
    // Fast path: single primitive arg (the common tokenize(text) case).
    if (args.length === 1) {
        const a = args[0];
        if (typeof a === "string") return `s:${a}`;
        if (typeof a === "number" || typeof a === "boolean") return `${typeof a}:${a}`;
        if (a === null || a === undefined) return String(a);
    }
    try {
        return JSON.stringify(args);
    } catch {
        return fallbackKey(args);
    }
}

function createStats() {
    return { hits: 0, misses: 0, evictions: 0, size: 0 };
}

function lruGet(cache, key) {
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    // Refresh LRU order.
    cache.delete(key);
    cache.set(key, entry);
    return entry;
}

function lruSet(cache, stats, key, value, maxSize) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > maxSize) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
        stats.evictions++;
    }
    stats.size = cache.size;
}

/**
 * Memoize a synchronous pure function.
 * @param {Function} fn
 * @param {{ maxSize?: number, ttlMs?: number, keyResolver?: Function }} options
 */
export function memoize(fn, options = {}) {
    if (typeof fn !== "function") throw new TypeError("memoize expects a function");
    const { maxSize = 500, ttlMs = 0, keyResolver = defaultKeyResolver } = options;
    const cache = new Map(); // key -> { value, expiresAt }
    const stats = createStats();

    const wrapped = (...args) => {
        const key = keyResolver(...args);
        const entry = lruGet(cache, key);
        const now = Date.now();
        if (entry !== undefined && (ttlMs <= 0 || entry.expiresAt > now)) {
            stats.hits++;
            return entry.value;
        }
        if (entry !== undefined) cache.delete(key); // expired
        stats.misses++;
        const value = fn(...args);
        lruSet(cache, stats, key, { value, expiresAt: ttlMs > 0 ? now + ttlMs : Infinity }, maxSize);
        return value;
    };

    wrapped.cache = cache;
    wrapped.stats = stats;
    wrapped.clear = () => { cache.clear(); stats.size = 0; };
    wrapped.delete = (...args) => { const ok = cache.delete(keyResolver(...args)); stats.size = cache.size; return ok; };
    wrapped.fn = fn;
    return wrapped;
}

/**
 * Memoize an async function. Concurrent calls with the same key share
 * the in-flight promise; only fulfilled values are cached (rejections are
 * dropped so a later retry can succeed).
 */
export function memoizeAsync(fn, options = {}) {
    if (typeof fn !== "function") throw new TypeError("memoizeAsync expects a function");
    const { maxSize = 200, ttlMs = 0, keyResolver = defaultKeyResolver } = options;
    const cache = new Map();
    const stats = createStats();

    const wrapped = (...args) => {
        const key = keyResolver(...args);
        const entry = lruGet(cache, key);
        const now = Date.now();
        if (entry !== undefined && (ttlMs <= 0 || entry.expiresAt > now)) {
            stats.hits++;
            return entry.value;
        }
        if (entry !== undefined) cache.delete(key);
        stats.misses++;
        const promise = Promise.resolve()
            .then(() => fn(...args))
            .catch((err) => {
                // Don't poison the cache with rejections.
                if (cache.get(key)?.value === promise) cache.delete(key);
                stats.size = cache.size;
                throw err;
            });
        lruSet(cache, stats, key, { value: promise, expiresAt: ttlMs > 0 ? now + ttlMs : Infinity }, maxSize);
        return promise;
    };

    wrapped.cache = cache;
    wrapped.stats = stats;
    wrapped.clear = () => { cache.clear(); stats.size = 0; };
    wrapped.delete = (...args) => { const ok = cache.delete(keyResolver(...args)); stats.size = cache.size; return ok; };
    wrapped.fn = fn;
    return wrapped;
}

// Example usage (mirrors the requested snippet):
// const expensiveTask = (num) => num * 2;
// export const memoizedTask = memoize(expensiveTask);
export const memoizedTask = memoize((num) => num * 2);
