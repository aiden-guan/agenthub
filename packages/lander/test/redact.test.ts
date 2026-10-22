import { describe, expect, it } from 'vitest';
import { REDACTED, REDACTED_KEY, Redactor, redact } from '../src/redact.js';

// design §2.2.8 / §4.4: exact values and token shapes. checks.test.ts covers
// the streaming path through the runner; these cover whole texts.

describe('redact', () => {
  it('replaces exact secret values, longest first, and leaves short values alone', () => {
    expect(redact('token=abcdef123 and abcdef123456', ['abcdef123', 'abcdef123456'])).toBe(`token=${REDACTED} and ${REDACTED}`);
    expect(redact('x=1 CI=1', ['1'])).toBe('x=1 CI=1');
    expect(redact('nothing here', [null, undefined, ''])).toBe('nothing here');
  });

  it('replaces token shapes without needing their values', () => {
    const shapes = [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'ghp_0123456789abcdefghijABCDEFGHIJ012345',
      'gho_0123456789abcdefghijABCDEFGHIJ012345',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'xoxb-1234567890-0987654321-AbCdEfGh',
      'xoxp-1234567890-0987654321-AbCdEfGh',
      'AKIAIOSFODNN7EXAMPLE',
      'npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    ];
    for (const s of shapes) expect(redact(`before ${s} after`), s).toBe(`before ${REDACTED} after`);
    // Look-alikes inside longer words and plain words stay.
    expect(redact('mask-ant-x skeleton ghp_short AKIA123')).toBe('mask-ant-x skeleton ghp_short AKIA123');
  });

  it('replaces private-key blocks, also when a tail or head cuts them off', () => {
    const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END RSA PRIVATE KEY-----';
    expect(redact(`a\n${block}\nb`)).toBe(`a\n${REDACTED_KEY}\nb`);
    expect(redact('start\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC')).toBe(`start\n${REDACTED_KEY}`);
    expect(redact('kiG9w0BAQEFAASC\n-----END EC PRIVATE KEY-----\nrest')).toBe(`${REDACTED_KEY}\nrest`);
    // A public key or certificate is not a secret.
    expect(redact('-----BEGIN PUBLIC KEY-----\nMFkwEwYH\n-----END PUBLIC KEY-----')).toContain('MFkwEwYH');
  });

  it('drops the lines of a key block in a stream, keeping what follows', () => {
    const r = new Redactor(['s3cr3t-value']);
    const out = ['ok s3cr3t-value', 'x -----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', 'AAAA', '-----END OPENSSH PRIVATE KEY----- tail', 'after'].map((l) => r.line(l));
    expect(out).toEqual([`ok ${REDACTED}`, `x ${REDACTED_KEY}`, null, null, ' tail', 'after']);
  });
});
