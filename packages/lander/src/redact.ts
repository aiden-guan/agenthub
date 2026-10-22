// Redaction of everything that leaves the lander as text (design §2.2.8,
// §4.4): check output above all. Two layers: the exact values of the
// lander's own secrets and of the passEnv variables, and the shapes of common
// tokens, so a secret printed by a test never reaches a report, a log or an
// agent. Hand-written patterns; no dependencies (design §6.2).

export const REDACTED = '[REDACTED]';
export const REDACTED_KEY = '[REDACTED PRIVATE KEY]';

/** Values shorter than this aren't treated as secrets: redacting "1" would garble every log. */
const MIN_SECRET_LENGTH = 4;

/** Token shapes (design §2.2.8): Anthropic, GitHub, Slack, AWS access key ids, npm. */
const TOKEN_SHAPES: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{8,}/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{8,}/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
];

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

export class Redactor {
  private readonly secrets: string[];
  private inKey = false;

  constructor(secrets: Iterable<string | null | undefined> = []) {
    const set = new Set<string>();
    for (const s of secrets) if (typeof s === 'string' && s.length >= MIN_SECRET_LENGTH) set.add(s);
    // Longest first, so a secret that contains another is replaced whole.
    this.secrets = [...set].sort((a, b) => b.length - a.length);
  }

  /**
   * A whole text. Private-key blocks are replaced across lines, including a
   * block cut off at either end (the text may be a tail or a head of output).
   */
  text(s: string): string {
    let out = s.replace(PEM_BLOCK, REDACTED_KEY);
    const begin = PEM_BEGIN.exec(out);
    if (begin) out = out.slice(0, begin.index) + REDACTED_KEY;
    const end = PEM_END.exec(out);
    if (end) out = REDACTED_KEY + out.slice(end.index + end[0].length);
    return this.inline(out);
  }

  /**
   * One line of a stream, in order. Lines inside a private-key block are
   * dropped (null); the block's first line becomes the placeholder.
   */
  line(s: string): string | null {
    let rest = s;
    if (this.inKey) {
      const end = PEM_END.exec(rest);
      if (!end) return null;
      this.inKey = false;
      rest = rest.slice(end.index + end[0].length);
      if (rest.trim() === '') return null;
    }
    rest = rest.replace(PEM_BLOCK, REDACTED_KEY);
    const begin = PEM_BEGIN.exec(rest);
    if (begin) {
      this.inKey = true;
      rest = rest.slice(0, begin.index) + REDACTED_KEY;
    }
    return this.inline(rest);
  }

  /** Exact values, then token shapes, within one string. */
  private inline(s: string): string {
    let out = s;
    for (const secret of this.secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    for (const re of TOKEN_SHAPES) out = out.replace(re, REDACTED);
    return out;
  }
}

/** Redacts one text with the given exact secret values plus the token shapes. */
export function redact(s: string, secrets: Iterable<string | null | undefined> = []): string {
  return new Redactor(secrets).text(s);
}
