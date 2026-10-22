// Sessions for the sample shop. The end-to-end suite edits these functions
// from two agents at once (design §3.12): keep them apart by blank lines so a
// change to one never touches the lines of another.

export function login(user: string): string {
  const name = user.trim();
  return `session-${name}`;
}

export function logout(session: string): boolean {
  const known = session.startsWith('session-');
  return known;
}

export function refresh(session: string): string {
  const name = session.slice('session-'.length);
  return login(name);
}
