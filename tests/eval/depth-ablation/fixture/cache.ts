interface Entry<T> { value: T; expiresAt: number }

export class AsyncCache<T> {
  private values = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();

  async get(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.values.get(key);
    if (cached?.value && cached.expiresAt > Date.now()) return cached.value;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const created = load().then((value) => {
      this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
      this.inflight.delete(key);
      return value;
    });
    this.inflight.set(key, created);
    return created;
  }
}
