import type { AuthContext } from '../shared/infrastructure/security/authenticate.js';

declare global {
  namespace Express {
    interface Locals {
      /** Set only by the authentication middleware after every check passed. */
      auth?: AuthContext;
      /** Aborted when the global request timeout fires. */
      abortSignal?: AbortSignal;
    }
  }
}

export {};
