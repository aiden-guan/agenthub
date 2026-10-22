import { login } from './auth.js';

export function handleLogin(body: { user: string }): { session: string } {
  const session = login(body.user);
  return { session };
}

export function health(): string {
  return 'ok';
}
