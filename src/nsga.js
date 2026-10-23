/**
 * Non-dominated sorting (NSGA-II style) — a "clever" multi-objective sorting
 * algorithm. Used to rank chat context candidates by several competing
 * objectives (e.g. relevance, recency, -token-cost) without collapsing them
 * into a single score, so the selected subset is a good Pareto trade-off.
 */

function objectivesOf(item, getObjectives) {
    const fn = typeof getObjectives === "function"
        ? getObjectives
        : (x) => (Array.isArray(x?.objectives) ? x.objectives
            : (Array.isArray(x) ? x : [Number(x?.score ?? x?.value ?? 0)]));
    const v = fn(item);
    return Array.isArray(v) ? v.map((n) => Number(n) || 0) : [Number(v) || 0];
}

export function dominates(a, b, getObjectives) {
    const oa = objectivesOf(a, getObjectives);
    const ob = objectivesOf(b, getObjectives);
    const n = Math.max(oa.length, ob.length);
    let atLeastOneStrictlyBetter = false;
    for (let i = 0; i < n; i++) {
        const va = oa[i] ?? 0;
        const vb = ob[i] ?? 0;
        if (va < vb) return false; // b better on this objective
        if (va > vb) atLeastOneStrictlyBetter = true;
    }
    return atLeastOneStrictlyBetter;
}

/**
 * Fast non-dominated sort (Deb et al.). Returns an array of fronts, where
 * fronts[0] are the non-dominated items, fronts[1] the next front, etc.
 * Each front is an array of the original items.
 */
export function fastNonDominatedSort(population, options = {}) {
    if (!Array.isArray(population)) return [];
    const getObjectives = options.getObjectives;
    const n = population.length;
    const dominationCount = new Array(n).fill(0);
    const dominatedSets = Array.from({ length: n }, () => []);
    // fronts as arrays of indices internally
    const indexFronts = [[]];

    for (let p = 0; p < n; p++) {
        for (let q = 0; q < n; q++) {
            if (p === q) continue;
            if (dominates(population[p], population[q], getObjectives)) {
                dominatedSets[p].push(q);
            } else if (dominates(population[q], population[p], getObjectives)) {
                dominationCount[p]++;
            }
        }
        if (dominationCount[p] === 0) indexFronts[0].push(p);
    }

    let i = 0;
    while (indexFronts[i] && indexFronts[i].length > 0) {
        const nextFront = [];
        for (const p of indexFronts[i]) {
            for (const q of dominatedSets[p]) {
                dominationCount[q]--;
                if (dominationCount[q] === 0) nextFront.push(q);
            }
        }
        i++;
        if (nextFront.length > 0) indexFronts[i] = nextFront;
    }

    // Convert index fronts to item fronts.
    const fronts = indexFronts
        .filter((f) => Array.isArray(f) && f.length > 0)
        .map((f) => f.map((idx) => population[idx]));
    // Remove trailing empty.
    while (fronts.length > 0 && (!fronts[fronts.length - 1] || fronts[fronts.length - 1].length === 0)) {
        fronts.pop();
    }
    return fronts;
}

/**
 * Returns a flat array sorted by Pareto front rank (front 0 first), preserving
 * input order within a front. Useful as a "clever sort" drop-in.
 */
export function nonDominatedSort(population, options = {}) {
    const fronts = fastNonDominatedSort(population, options);
    const out = [];
    for (const front of fronts) for (const item of front) out.push(item);
    // Attach rank for callers that want it.
    let rank = 0;
    for (const front of fronts) {
        for (const item of front) {
            if (item && typeof item === "object") {
                try { item._paretoRank = rank; } catch {}
            }
        }
        rank++;
    }
    return out;
}

export function paretoSort(population, options = {}) {
    return nonDominatedSort(population, options);
}

// Aliases
export const nsga2Sort = nonDominatedSort;
export const nsgaSort = nonDominatedSort;
export const fastSort = nonDominatedSort;
export const multiObjectiveSort = nonDominatedSort;