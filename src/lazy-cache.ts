// Read-path cache with a fixed TTL. Expired entries are served immediately
// while a background refresh repopulates them, so read tools never block on a
// stale device fact; a failed refresh keeps the previous value. Modelled on the
// device-facts cache reverse-engineered from the Claude desktop client
// (deviceName/osVersion/size/orientation per device id, TTL 300000ms).
//
// Red line: only wire this into MCP tool entry points in server.ts for
// informational reads (mobile_get_screen_size / mobile_get_orientation). Never
// inject it into interaction.ts's read() path (mobile_observe/action/assert):
// that bounded-wait loop must observe the live screen on every pass, and a
// cached tree would silently turn assertions into false positives/negatives
// that offline tests cannot catch.
export class LazyTtlCache<K, V> {
	private entries = new Map<K, { value: V; fetchedAt: number }>();
	private inflight = new Map<K, Promise<V>>();

	public constructor(private readonly ttlMs: number, private readonly now: () => number = () => Date.now()) {
	}

	public async get(key: K, refresh: () => Promise<V>): Promise<V> {
		const entry = this.entries.get(key);
		if (!entry) {
			return this.refresh(key, refresh);
		}

		if (this.now() - entry.fetchedAt < this.ttlMs) {
			return entry.value;
		}

		this.refresh(key, refresh).catch(() => {});
		return entry.value;
	}

	public invalidate(key: K): void {
		this.entries.delete(key);
	}

	private refresh(key: K, refresh: () => Promise<V>): Promise<V> {
		const pending = this.inflight.get(key);
		if (pending) {
			return pending;
		}

		const promise = refresh()
			.then(value => {
				this.entries.set(key, { value, fetchedAt: this.now() });
				return value;
			})
			.finally(() => this.inflight.delete(key));
		this.inflight.set(key, promise);
		return promise;
	}
}
