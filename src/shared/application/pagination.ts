/** Keyset pagination over (createdAt DESC, id DESC). */
export interface Cursor {
  createdAt: Date;
  id: string;
}

export interface PageRequest {
  limit: number;
  cursor: Cursor | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: Cursor | null;
}
