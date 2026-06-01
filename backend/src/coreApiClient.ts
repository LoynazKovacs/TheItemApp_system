export class CoreApiError extends Error {
  public readonly status: number;
  constructor(method: string, url: string, status: number, body: string) {
    super(`[coreApi] ${method} ${url} failed: ${status} — ${body}`);
    this.name = 'CoreApiError';
    this.status = status;
  }
}

export type CoreApiConfig = {
  baseUrl: string;
  apiKey: string | null;
};

export interface DynRow {
  _id: string;
  [k: string]: unknown;
}

/**
 * Thin client over core's `/api/dynamic/<collection>` CRUD, used by the
 * collector to publish `system_*` rows. Authenticates with the app's
 * auto-provisioned functional API key and skips webhook fan-out (these are
 * high-frequency system writes, not user actions).
 */
export class CoreApiClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: CoreApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
      'x-theitemapp-skip-webhooks': '1',
    };
  }

  updateApiKey(apiKey: string): void {
    this.headers['x-api-key'] = apiKey;
  }

  hasApiKey(): boolean {
    return typeof this.headers['x-api-key'] === 'string' && this.headers['x-api-key'].length > 0;
  }

  /** List every row of a collection (system_* collections stay small). */
  async list(collection: string, limit = 500): Promise<DynRow[]> {
    const url = `${this.baseUrl}/api/dynamic/${collection}?_l=${limit}&populate=0`;
    const res = await fetch(url, { method: 'GET', headers: this.headers });
    if (!res.ok) throw new CoreApiError('GET', url, res.status, (await res.text()).slice(0, 300));
    const data = await res.json();
    return Array.isArray(data) ? (data as DynRow[]) : [];
  }

  async get(collection: string, id: string): Promise<DynRow | null> {
    const url = `${this.baseUrl}/api/dynamic/${collection}/${encodeURIComponent(id)}?populate=0`;
    const res = await fetch(url, { method: 'GET', headers: this.headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new CoreApiError('GET', url, res.status, (await res.text()).slice(0, 300));
    return (await res.json()) as DynRow;
  }

  async create(collection: string, doc: Record<string, unknown>): Promise<DynRow> {
    const url = `${this.baseUrl}/api/dynamic/${collection}`;
    const res = await fetch(url, { method: 'POST', headers: this.headers, body: JSON.stringify(doc) });
    if (!res.ok) throw new CoreApiError('POST', url, res.status, (await res.text()).slice(0, 300));
    return (await res.json()) as DynRow;
  }

  async update(collection: string, id: string, patch: Record<string, unknown>): Promise<void> {
    const url = `${this.baseUrl}/api/dynamic/${collection}/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ $set: patch }),
    });
    if (!res.ok) throw new CoreApiError('PUT', url, res.status, (await res.text()).slice(0, 300));
  }

  async remove(collection: string, id: string): Promise<void> {
    const url = `${this.baseUrl}/api/dynamic/${collection}/${encodeURIComponent(id)}`;
    // No Content-Type / body: Fastify rejects an empty body when the
    // content-type is application/json (FST_ERR_CTP_EMPTY_JSON_BODY).
    const { 'Content-Type': _ct, ...headers } = this.headers;
    const res = await fetch(url, { method: 'DELETE', headers });
    if (!res.ok && res.status !== 404) {
      throw new CoreApiError('DELETE', url, res.status, (await res.text()).slice(0, 300));
    }
  }
}
