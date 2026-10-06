export const ROLES = ['user', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * The authenticated principal a use case acts on behalf of.
 * Built by the transport layer after token verification; the domain only
 * sees this value object, never tokens or HTTP requests.
 */
export class Actor {
  private constructor(
    readonly userId: string,
    readonly roles: ReadonlySet<Role>,
  ) {}

  static of(userId: string, roles: Iterable<Role>): Actor {
    return new Actor(userId, new Set(roles));
  }

  hasRole(role: Role): boolean {
    return this.roles.has(role);
  }

  get isAdmin(): boolean {
    return this.roles.has('admin');
  }

  owns(resource: { userId: string }): boolean {
    return resource.userId === this.userId;
  }
}
