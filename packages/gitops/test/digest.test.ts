// approvalDigest vectors (design §1.4 "Approvals"): the one digest the lander,
// the approvers' CLI and the tests all compute.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { approvalDigest } from '../src/index.js';

const A = '1'.repeat(40);
const B = '2'.repeat(40);
const C = '3'.repeat(40);

describe('approvalDigest', () => {
  it('matches the pinned vectors', () => {
    expect(
      approvalDigest('protected', [
        { path: 'migrations/0042.sql', blobs: [A, B] },
        { path: 'agenthub.json', blobs: [C, null] },
      ]),
    ).toBe('8512b9a5ba949d07442cc7715d6c30e18ad344d97e66dfa97f6fdf59495ad5a6');
    expect(
      approvalDigest('ai_resolution', [{ path: 'src/auth.ts', blobs: ['aaaa'.padEnd(40, '0'), 'bbbb'.padEnd(40, '0'), 'cccc'.padEnd(40, '0'), 'dddd'.padEnd(40, '0')] }]),
    ).toBe('8035c1c95bc6e63b91074477af88359ff01361ffea3de3955b0b3f5afddafc76');
    expect(approvalDigest('merged', [])).toBe(createHash('sha256').update('').digest('hex'));
  });

  it('is sha256 over the sorted lines kind NUL path NUL blobs, a missing blob empty', () => {
    const entries = [
      { path: 'b/x.sql', blobs: [A, null] },
      { path: 'a/y.sql', blobs: [null, B] },
    ];
    const lines = ['merged\0a/y.sql\0\0' + B, 'merged\0b/x.sql\0' + A + '\0'];
    expect(approvalDigest('merged', entries)).toBe(createHash('sha256').update(lines.map((l) => `${l}\n`).join('')).digest('hex'));
  });

  it('does not depend on the order of the entries, and depends on everything else', () => {
    const one = [
      { path: 'm/1.sql', blobs: [A, B] },
      { path: 'm/2.sql', blobs: [B, C] },
    ];
    const d = approvalDigest('protected', one);
    expect(approvalDigest('protected', [...one].reverse())).toBe(d);
    expect(approvalDigest('merged', one)).not.toBe(d);
    expect(approvalDigest('protected', [one[0]!, { path: 'm/2.sql', blobs: [B, A] }])).not.toBe(d);
    expect(approvalDigest('protected', [one[0]!, { path: 'm/3.sql', blobs: [B, C] }])).not.toBe(d);
    expect(approvalDigest('protected', [one[0]!])).not.toBe(d);
    expect(approvalDigest('protected', [{ path: 'm/1.sql', blobs: [A, null] }])).not.toBe(approvalDigest('protected', [{ path: 'm/1.sql', blobs: [null, A] }]));
  });

  it('refuses the wrong number of blobs for the kind, and values that are not object ids', () => {
    expect(() => approvalDigest('protected', [{ path: 'p', blobs: [A] }])).toThrow(/2 blobs/);
    expect(() => approvalDigest('merged', [{ path: 'p', blobs: [A, B, C] }])).toThrow(/2 blobs/);
    expect(() => approvalDigest('ai_resolution', [{ path: 'p', blobs: [A, B] }])).toThrow(/4 blobs/);
    expect(() => approvalDigest('protected', [{ path: 'p', blobs: [A, 'HEAD:p'] }])).toThrow(/object id/);
    expect(() => approvalDigest('protected', [{ path: 'a\0b', blobs: [A, B] }])).toThrow(/path/);
    expect(() => approvalDigest('nonsense' as 'protected', [])).toThrow(/kind/);
  });
});
