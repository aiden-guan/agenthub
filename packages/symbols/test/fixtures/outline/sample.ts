// Sample TypeScript module for the outline tests (and the mapping property test).

import { readFileSync } from 'node:fs';
import type { Config } from './config';
export * from './util';
export { helper as aid } from './helper';

// Grüße, naïve café ✓ 😀: non-ASCII text before a declaration
/** Logs a user in. */
export function login(user: string, /* inline */ password: string): Promise<Session> {
  return authenticate(user, password);
}

// A detached note about the module.

console.log('loaded', readFileSync);
const { host, port } = loadConfig();

export const MAX_RETRIES = 3, BACKOFF_MS: number = 250;
export let current: Session | null = null;

export const handler = async (req: Request): Promise<Response> => {
  return new Response(String(req.url));
};

function over(a: string): string;
function over(a: number): number;
function over(a: any): any {
  return a;
}

export interface Credentials {
  user: string;
  password: string;
}

export type Token = string & { readonly brand: unique symbol };

export enum Role {
  Admin,
  User,
}

@sealed
export class Session<T = unknown> extends Base implements Disposable {
  // How long a session lives.
  static ttl: number = 3600;
  private token = '';
  #secret = 1;

  constructor(private readonly store: Store<T>) {
    super();
  }

  @logged
  refresh(force?: boolean): void {
    this.token = rotate(this.token, force);
  }

  get user(): string {
    return this.token;
  }
  set user(value: string) {
    this.token = value;
  }

  close(): void;
  close(code: number): void;
  close(code?: number): void {}

  [Symbol.dispose](): void {}
}

export abstract class Repo {
  abstract find(id: string): Promise<unknown>; // by primary key
}

export namespace Auth {
  export const realm = 'main';
  export function check(token: Token): boolean {
    return token.length > 0;
  }
}

declare module 'express' {
  interface Request { session?: Session }
}

declare function authenticate(user: string, password: string): Promise<Session>;

export default class {
  run(): void {}
}
