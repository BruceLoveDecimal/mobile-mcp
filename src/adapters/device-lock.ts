// One driver per device at a time: while app_run drives a device, other tool calls on that device wait their turn.
export class DeviceLocks {
	private tails = new Map<string, Promise<unknown>>();

	async run<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(deviceId) ?? Promise.resolve();
		const current = previous.catch(() => {}).then(fn);
		const tail = current.catch(() => {});
		this.tails.set(deviceId, tail);
		try {
			return await current;
		} finally {
			if (this.tails.get(deviceId) === tail) {
				this.tails.delete(deviceId);
			}
		}
	}
}
