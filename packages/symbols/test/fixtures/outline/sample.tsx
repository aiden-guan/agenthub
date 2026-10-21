import React, { useState } from 'react';

// The app shell.
export function App({ title }: { title: string }): JSX.Element {
  const [n, setN] = useState(0);
  return <div className="app" onClick={() => setN(n + 1)}>{title}: {n}</div>;
}

export const Badge = (props: { label: string }) => <span className="badge">{props.label}</span>;

export default function () {
  return <App title="héllo ✓" />;
}

class Panel extends React.Component<{ open: boolean }> {
  state = { shown: false };

  render() {
    return this.props.open ? <section>{this.state.shown}</section> : null;
  }
}

function useToggle<T,>(initial: T): [T, () => void] {
  const [v, setV] = useState(initial);
  return [v, () => setV(v)];
}
