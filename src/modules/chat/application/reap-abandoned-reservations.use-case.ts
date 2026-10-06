import type { Clock } from '../../../shared/domain/clock.js';
import type { QuotaRepository } from '../repositories/quota.repository.js';

/** A reservation older than this can no longer be settled by its request. */
export const ABANDONED_AFTER_MS = 10 * 60_000;

/**
 * Safety net for the reserve -> settle flow: if a process dies after reserving
 * a quota unit but before settling it, the message is failed and the unit
 * refunded, so users are never charged for answers they did not get.
 */
export class ReapAbandonedReservationsUseCase {
  constructor(private readonly deps: { quota: QuotaRepository; clock: Clock }) {}

  execute(): Promise<number> {
    const cutoff = new Date(this.deps.clock.now().getTime() - ABANDONED_AFTER_MS);
    return this.deps.quota.reapAbandonedReservations(cutoff);
  }
}
