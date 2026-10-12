import os from "node:os";

/** Number of logical CPUs available for worker/concurrency sizing. */
export function availableParallelism() {
    try {
        if (typeof os.availableParallelism === "function") {
            const n = os.availableParallelism();
            if (Number.isFinite(n) && n > 0) return n;
        }
    } catch {}
    try {
        const n = os.cpus()?.length ?? 0;
        if (n > 0) return n;
    } catch {}
    return 4;
}

/** Split an array into at most `parts` contiguous chunks. */
export function chunkArray(arr, parts) {
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const n = Math.max(1, Math.min(parts, arr.length));
    const size = Math.ceil(arr.length / n);
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

/** Pick a sane worker count: bounded by CPUs, task count and an absolute cap. */
export function getOptimalWorkerCount(taskCount, { maxWorkers = 0, cap = 4 } = {}) {
    const total = availableParallelism();
    const max = maxWorkers > 0 ? maxWorkers : Math.max(1, Math.min(total, cap));
    if (!taskCount || taskCount <= 1) return 1;
    return Math.max(1, Math.min(max, taskCount));
}

/**
 * Run `fn(item, index)` over `items` with at most `concurrency` in flight.
 * Order of results matches input order. Rejects fail the whole batch.
 */
export async function mapWithConcurrency(items, fn, { concurrency = 0 } = {}) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return [];
    const limit = Math.max(1, concurrency > 0 ? concurrency : getOptimalWorkerCount(list.length));
    if (limit === 1) {
        const out = [];
        for (let i = 0; i < list.length; i++) out.push(await fn(list[i], i));
        return out;
    }
    const results = new Array(list.length);
    let next = 0;
    const runners = new Array(Math.min(limit, list.length)).fill(0).map(async () => {
        while (true) {
            const i = next++;
            if (i >= list.length) return;
            results[i] = await fn(list[i], i);
        }
    });
    await Promise.all(runners);
    return results;
}
