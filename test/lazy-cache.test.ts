import { test, expect } from "@playwright/test";

import { LazyTtlCache } from "../src/lazy-cache";

// controllable clock so TTL expiry is tested without real waits
const fakeClock = () => {
	let now = 1000;
	return { now: () => now, advance: (ms: number) => { now += ms; } };
};

test.describe("LazyTtlCache", () => {
	test("fetches on a cold key and serves fresh values without refetching", async () => {
		const clock = fakeClock();
		const cache = new LazyTtlCache<string, number>(300000, clock.now);
		let fetches = 0;
		const refresh = async () => ++fetches;

		expect(await cache.get("d1", refresh)).toBe(1);
		clock.advance(299999);
		expect(await cache.get("d1", refresh)).toBe(1);
		expect(fetches).toBe(1);
	});

	test("serves the stale value past the TTL and refreshes in the background", async () => {
		const clock = fakeClock();
		const cache = new LazyTtlCache<string, number>(300000, clock.now);
		let fetches = 0;
		const refresh = async () => ++fetches;

		expect(await cache.get("d1", refresh)).toBe(1);
		clock.advance(300001);

		// expired: the stale value comes back immediately...
		expect(await cache.get("d1", refresh)).toBe(1);
		// ...while the background refresh repopulates the entry
		await Promise.resolve();
		await Promise.resolve();
		expect(await cache.get("d1", refresh)).toBe(2);
		expect(fetches).toBe(2);
	});

	test("keeps the stale value when a background refresh fails", async () => {
		const clock = fakeClock();
		const cache = new LazyTtlCache<string, number>(300000, clock.now);
		let fail = false;
		const refresh = async () => {
			if (fail) { throw new Error("device unreachable"); }
			return 42;
		};

		expect(await cache.get("d1", refresh)).toBe(42);
		clock.advance(300001);
		fail = true;
		expect(await cache.get("d1", refresh)).toBe(42);
		await Promise.resolve();
		await Promise.resolve();
		expect(await cache.get("d1", refresh)).toBe(42);
	});

	test("dedupes concurrent cold fetches", async () => {
		const clock = fakeClock();
		const cache = new LazyTtlCache<string, number>(300000, clock.now);
		let fetches = 0;
		const refresh = async () => {
			fetches++;
			await new Promise(r => setTimeout(r, 10));
			return fetches;
		};

		const [a, b] = await Promise.all([cache.get("d1", refresh), cache.get("d1", refresh)]);
		expect(a).toBe(1);
		expect(b).toBe(1);
		expect(fetches).toBe(1);
	});

	test("invalidate forces a blocking refetch", async () => {
		const clock = fakeClock();
		const cache = new LazyTtlCache<string, number>(300000, clock.now);
		let fetches = 0;
		const refresh = async () => ++fetches;

		expect(await cache.get("d1", refresh)).toBe(1);
		cache.invalidate("d1");
		expect(await cache.get("d1", refresh)).toBe(2);
	});

	test("keys are independent", async () => {
		const clock = fakeClock();
		const cache = new LazyTtlCache<string, string>(300000, clock.now);
		expect(await cache.get("d1", async () => "one")).toBe("one");
		expect(await cache.get("d2", async () => "two")).toBe("two");
	});
});
