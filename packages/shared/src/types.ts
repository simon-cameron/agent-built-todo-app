/** A stored item as returned by the API (API contract, item object). */
export interface Todo { // ADR-5 shared type, name fixed by the contract
  /** Integer 1 to 2147483647, assigned by the server. */
  readonly id: number;
  /** Trimmed, 1 to 200 code points. */
  readonly title: string;
  /** `false` on creation. */
  readonly done: boolean;
  /** UTC instant as an ISO string, set by the server, never writable. */
  readonly createdAt: string;
}

/** The accepted values of the list `filter` query parameter, case-sensitive. */
export const FILTERS = Object.freeze(['all', 'active', 'done'] as const);

/** One of `all`, `active`, `done`. */
export type Filter = (typeof FILTERS)[number];
