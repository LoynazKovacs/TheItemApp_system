import {
  CoreApiClient as SdkCoreApiClient,
  CoreApiError,
  type CoreApiConfig,
} from '@loynazkovacs/theitemapp-backend-sdk';

export { CoreApiError };
export type { CoreApiConfig };

export interface DynRow {
  _id: string;
  [k: string]: unknown;
}

/**
 * System-monitor core client — a thin adapter over the shared backend SDK's
 * CoreApiClient that preserves the small conveniences this collector relies on:
 *
 *  - a numeric `list` limit + `populate=0` on reads. The collector's diff logic
 *    compares x-ref fields (e.g. `groupIds`) as id strings, so populated x-ref
 *    objects would register as a change and cause spurious updates.
 *  - an explicit `$set` update (the dynamic PUT body shape this app has always
 *    sent).
 *  - `remove` / `hasApiKey` method names used throughout the collector + routes.
 *
 * Keeping the adapter means no call-sites in collector.ts / routes.ts / index.ts
 * had to change.
 */
export class CoreApiClient {
  private readonly sdk: SdkCoreApiClient;

  constructor(config: CoreApiConfig) {
    this.sdk = new SdkCoreApiClient(config);
  }

  updateApiKey(apiKey: string): void {
    this.sdk.updateApiKey(apiKey);
  }

  hasApiKey(): boolean {
    return this.sdk.isReady();
  }

  /** List a collection (system_* collections stay small). Reads skip populate. */
  list(collection: string, limit = 500): Promise<DynRow[]> {
    return this.sdk.list<DynRow>(collection, { _l: String(limit), populate: '0' });
  }

  get(collection: string, id: string): Promise<DynRow | null> {
    return this.sdk.get<DynRow>(collection, id);
  }

  create(collection: string, doc: Record<string, unknown>): Promise<DynRow> {
    return this.sdk.create<DynRow>(collection, doc);
  }

  async update(collection: string, id: string, patch: Record<string, unknown>): Promise<void> {
    await this.sdk.update<DynRow>(collection, id, { $set: patch });
  }

  /**
   * Telemetry rows are machine state (recreated every cycle) — hard-delete so
   * they don't accumulate as soft-deleted residue in mongo forever.
   */
  async remove(collection: string, id: string): Promise<void> {
    await this.sdk.hardDeleteByFilter(collection, { _id: id });
  }

  async removeByFilter(collection: string, query: Record<string, unknown>): Promise<number> {
    const res = await this.sdk.hardDeleteByFilter(collection, query);
    return res.deletedCount;
  }
}
