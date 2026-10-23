import { describe, expect, test } from "bun:test";
import { fastNonDominatedSort, nonDominatedSort, dominates } from "./nsga.js";

describe("nsga", () => {
    test("dominates basic", () => {
        expect(dominates([2, 2], [1, 1])).toBe(true);
        expect(dominates([1, 1], [2, 2])).toBe(false);
        expect(dominates([2, 1], [1, 2])).toBe(false);
    });

    test("fastNonDominatedSort fronts", () => {
        const pop = [
            { objectives: [2, 2] },
            { objectives: [1, 3] },
            { objectives: [3, 1] },
            { objectives: [1, 1] },
        ];
        const fronts = fastNonDominatedSort(pop);
        expect(fronts[0].length).toBe(3);
        expect(fronts[1].length).toBe(1);
    });

    test("nonDominatedSort flat length", () => {
        const pop = [ [1,1], [2,2], [0,0] ];
        const out = nonDominatedSort(pop);
        expect(out.length).toBe(3);
    });
});
