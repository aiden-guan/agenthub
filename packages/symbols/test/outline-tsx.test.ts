// S1: TSX outlines (the TypeScript table on the TSX grammar).
import { describe, expect, it } from 'vitest';
import { outline } from '../src/index.js';
import { expectWellFormed, find, fixture, view } from './helpers.js';

const SAMPLE = fixture('outline/sample.tsx');

describe('the TSX fixture', () => {
  it('has the expected keys, kinds, spans and signatures', async () => {
    const o = await outline(SAMPLE, 'tsx');
    expect(o.language).toBe('tsx');
    expect(o.errors).toBe('none');
    expect(view(SAMPLE, o.items)).toEqual([
      { key: '@imports', kind: 'imports', lines: '1', head: "import React, { useState } from 'react';", tail: "import React, { useState } from 'react';", signature: null },
      { key: 'App', kind: 'function', lines: '3-7', head: '// The app shell.', tail: '}', signature: 'function App({ title }: { title: string }): JSX.Element' },
      {
        key: 'Badge',
        kind: 'variable',
        lines: '9',
        head: 'export const Badge = (props: { label: string }) => <span className="badge">{props.label}</span>;',
        tail: 'export const Badge = (props: { label: string }) => <span className="badge">{props.label}</span>;',
        signature: 'const Badge = (props: { label: string }) =>',
      },
      { key: 'default', kind: 'function', lines: '11-13', head: 'export default function () {', tail: '}', signature: 'function ()' },
      {
        key: 'Panel',
        kind: 'class',
        lines: '15-21',
        head: 'class Panel extends React.Component<{ open: boolean }> {',
        tail: '}',
        signature: 'class Panel extends React.Component<{ open: boolean }>',
        members: [
          { key: 'Panel.state', kind: 'field', lines: '16', head: 'state = { shown: false };', tail: 'state = { shown: false };', signature: null },
          { key: 'Panel.render', kind: 'method', lines: '18-20', head: 'render() {', tail: '  }', signature: 'render()' },
        ],
      },
      { key: 'useToggle', kind: 'function', lines: '23-26', head: 'function useToggle<T,>(initial: T): [T, () => void] {', tail: '}', signature: 'function useToggle<T,>(initial: T): [T, () => void]' },
    ]);
    expectWellFormed(SAMPLE, o);
  });

  it('counts offsets in UTF-16 code units inside JSX text too', async () => {
    const src = 'const a = <b title="✓😀">héllo</b>;\nexport function f() {}\n';
    const f = find((await outline(src, 'tsx')).items, 'f');
    expect(f.start).toBe(src.indexOf('export function f'));
    expect(src.slice(f.start, f.end)).toBe('export function f() {}');
  });
});
