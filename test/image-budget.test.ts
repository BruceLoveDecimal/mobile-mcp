import { test, expect } from "@playwright/test";

import { computeBudgetMaxSize, DEFAULT_IMAGE_BUDGET, estimateTokens, isWithinBudget } from "../src/image-budget";

test.describe("image budget", () => {
	test("estimates one token per pxPerToken patch, rounding up", () => {
		expect(estimateTokens(28, 28)).toBe(1);
		expect(estimateTokens(29, 28)).toBe(2);
		expect(estimateTokens(1568, 1568)).toBe(56 * 56);
	});

	test("accepts images at the budget edge", () => {
		// 1568x896 -> 56 * 32 = 1792 tokens... exceeds; pick a fitting case
		expect(isWithinBudget(1024, 1024)).toBe(true);
		expect(isWithinBudget(1568, 28 * 28)).toBe(true);
		expect(isWithinBudget(1569, 28 * 28)).toBe(false);
	});

	test("rejects images over the token budget even below the pixel cap", () => {
		// 1568x1568 is exactly maxTargetPx but 3136 tokens > 1568
		expect(isWithinBudget(1568, 1568)).toBe(false);
	});

	test("leaves in-budget sizes alone", () => {
		expect(computeBudgetMaxSize(1024, 768)).toBe(1024);
	});

	test("binary search finds the largest integer maxSize within budget", () => {
		const maxSize = computeBudgetMaxSize(3024, 4032);
		expect(maxSize).toBeLessThanOrEqual(DEFAULT_IMAGE_BUDGET.maxTargetPx);

		const fits = (size: number): boolean => {
			const k = size / 4032;
			return isWithinBudget(Math.round(3024 * k), Math.round(4032 * k));
		};
		expect(fits(maxSize)).toBe(true);
		expect(fits(maxSize + 1)).toBe(false);
	});

	test("result respects both caps for extreme aspect ratios", () => {
		const maxSize = computeBudgetMaxSize(20000, 500);
		const k = maxSize / 20000;
		const width = Math.round(20000 * k);
		const height = Math.max(1, Math.round(500 * k));
		expect(Math.max(width, height)).toBeLessThanOrEqual(DEFAULT_IMAGE_BUDGET.maxTargetPx);
		expect(estimateTokens(width, height)).toBeLessThanOrEqual(DEFAULT_IMAGE_BUDGET.maxTargetTokens);
	});

	test("honours a custom budget", () => {
		const budget = { pxPerToken: 28, maxTargetPx: 512, maxTargetTokens: 64 };
		const maxSize = computeBudgetMaxSize(2048, 2048, budget);
		expect(maxSize).toBe(224); // 224/28 = 8 patches per side, 64 tokens
	});

	test("handles degenerate input", () => {
		expect(computeBudgetMaxSize(0, 0)).toBe(1);
	});
});
