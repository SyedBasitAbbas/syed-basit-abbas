/** Generates identifiers for new aggregates (UUIDs in production). */
export interface IdGenerator {
  next(): string;
}

/**
 * Runs `work` inside one database transaction and hands it repositories bound
 * to that transaction. Use cases depend on this port, never on the database driver.
 */
export interface UnitOfWork<TRepositories> {
  run<T>(work: (repositories: TRepositories) => Promise<T>): Promise<T>;
}
