import type { SqlExecutor } from '../../infrastructure/database/database.js';

/**
 * Transactional outbox. Domain events are written in the same transaction as the change, so an
 * event exists if and only if the change committed. A worker will publish them to integrations
 * (notifications, billing, marketplace indexing) in a later task. Payloads hold identifiers and
 * non-sensitive facts only: never tokens, documents, contact details or medical data.
 */
export interface DomainEvent {
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly clinicId?: string | null;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export class DomainEventOutbox {
  async record(executor: SqlExecutor, event: DomainEvent): Promise<void> {
    await executor.execute(
      'INSERT INTO domain_events (event_type, aggregate_type, aggregate_id, clinic_id, payload) VALUES (?, ?, ?, ?, ?)',
      [
        event.type,
        event.aggregateType,
        event.aggregateId,
        event.clinicId ?? null,
        JSON.stringify(event.payload ?? {}),
      ],
    );
  }
}
