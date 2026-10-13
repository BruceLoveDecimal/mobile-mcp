// Image token budget for screenshots returned to the model, reverse-engineered
// from the Claude desktop client: vision tokens are estimated at one token per
// ~28x28 pixel patch, and an image is downscaled until both its long edge and
// its estimated token count fit the caps. The constants are deliberately
// configurable - adjust them to the model actually consuming these images.
export interface ImageBudget {
	pxPerToken: number;
	maxTargetPx: number;
	maxTargetTokens: number;
}

export const DEFAULT_IMAGE_BUDGET: ImageBudget = {
	pxPerToken: 28,
	maxTargetPx: 1568,
	maxTargetTokens: 1568,
};

export const estimateTokens = (width: number, height: number, budget: ImageBudget = DEFAULT_IMAGE_BUDGET): number =>
	Math.ceil(width / budget.pxPerToken) * Math.ceil(height / budget.pxPerToken);

export const isWithinBudget = (width: number, height: number, budget: ImageBudget = DEFAULT_IMAGE_BUDGET): boolean =>
	Math.max(width, height) <= budget.maxTargetPx && estimateTokens(width, height, budget) <= budget.maxTargetTokens;

// Largest integer long-edge limit in [1, maxTargetPx] whose aspect-preserving
// downscale of (width, height) fits the budget. Monotonic in maxSize, so a
// binary search finds the maximum without probing every candidate.
export const computeBudgetMaxSize = (width: number, height: number, budget: ImageBudget = DEFAULT_IMAGE_BUDGET): number => {
	const maxDim = Math.max(width, height);
	if (maxDim <= 0) {
		return 1;
	}

	const fits = (maxSize: number): boolean => {
		const k = Math.min(1, maxSize / maxDim);
		return isWithinBudget(Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k)), budget);
	};

	let lo = 1;
	let hi = Math.min(budget.maxTargetPx, maxDim);
	let best = 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (fits(mid)) {
			best = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}

	return best;
};
