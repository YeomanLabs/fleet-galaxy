// A small Microsoft Graph client for the collector: paging, throttling
// retries, and errors that say which permission or license is missing.
// Runs in Node (the desktop app's main process) and in tests with a fake fetch.

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly path: string,
  ) {
    super(message);
  }

  /** Missing consent, missing role, or missing license: skip the source, don't fail the run. */
  get denied(): boolean {
    return this.status === 401 || this.status === 403 || /Authorization|Forbidden|license|Premium|NotEntitled/i.test(this.code + this.message);
  }
}

export interface GraphOptions {
  token: () => Promise<string>;
  fetch?: FetchLike;
  /** Wait between retries; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  base?: string;
}

const ROOT = 'https://graph.microsoft.com';

export class Graph {
  private readonly token: () => Promise<string>;
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly base: string;
  /** Requests made, for the progress log. */
  calls = 0;

  constructor(opts: GraphOptions) {
    this.token = opts.token;
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.base = opts.base ?? ROOT;
  }

  private url(path: string): string {
    if (/^https:\/\//.test(path)) return path;
    // "beta/..." or "v1.0/..." picks the version; bare paths default to v1.0.
    const p = path.replace(/^\//, '');
    return `${this.base}/${/^(beta|v1\.0)\//.test(p) ? p : `v1.0/${p}`}`;
  }

  async request<T = unknown>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const url = this.url(path);
    for (let attempt = 0; ; attempt++) {
      this.calls++;
      const res = await this.fetch(url, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          // signInActivity and some report filters need advanced query support.
          ConsistencyLevel: 'eventual',
          ...init.headers,
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      }
      // Throttled or briefly unavailable: honour Retry-After, back off otherwise.
      if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 5) {
        const after = Number(res.headers.get('Retry-After'));
        await this.sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      let code = '';
      let message = res.status === 404 ? 'Not found' : `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code ?? '';
        message = body.error?.message || message;
      } catch {
        /* non-JSON error body */
      }
      throw new GraphError(message, res.status, code, url.replace(this.base, '').split('?')[0]);
    }
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body });
  }

  /** Follows @odata.nextLink until the collection is exhausted. */
  async all<T = unknown>(path: string, onPage?: (count: number) => void): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: { value?: T[]; '@odata.nextLink'?: string } = await this.get(next);
      if (page.value) out.push(...page.value);
      onPage?.(out.length);
      next = page['@odata.nextLink'];
    }
    return out;
  }
}

/** Runs fn over items with at most `limit` in flight. Graph throttles per app per tenant. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
