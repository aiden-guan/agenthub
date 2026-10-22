// Crash injection for the crash tests (design §5 "Fault injection", §5.4):
// AGENTHUB_LANDER_FAULTS=<point>[:<landing>][,<point>[:<landing>]…] makes
// Faults.at() kill the lander process with SIGKILL at that point (for that
// landing only, when one is named). It is ignored unless NODE_ENV=test, so a
// production lander can't be crashed through its environment.

import { ConfigError } from './config.js';
import { FAULT_POINTS, noFaults, type FaultPoint, type Faults } from './ports.js';

export interface FaultSpec {
  point: FaultPoint;
  /** Only this landing; null = any. */
  landing: string | null;
}

const LANDING_ID_RE = /^L-[1-9][0-9]*$/;

/** Parses the AGENTHUB_LANDER_FAULTS value; an unknown point or landing id is a configuration error (a typo would test nothing). */
export function parseFaults(value: string): FaultSpec[] {
  const out: FaultSpec[] = [];
  for (const raw of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [point, landing, ...rest] = raw.split(':');
    if (rest.length > 0 || !(FAULT_POINTS as readonly string[]).includes(point!)) {
      throw new ConfigError(`AGENTHUB_LANDER_FAULTS: "${raw}" is not <point>[:<landing>] (points: ${FAULT_POINTS.join(', ')})`);
    }
    if (landing !== undefined && !LANDING_ID_RE.test(landing)) throw new ConfigError(`AGENTHUB_LANDER_FAULTS: "${landing}" is not a landing id`);
    out.push({ point: point as FaultPoint, landing: landing ?? null });
  }
  return out;
}

/** Faults that run `act` (default: SIGKILL this process) when a spec matches. */
export function faultsFrom(specs: FaultSpec[], act: (point: FaultPoint, landingId: string | undefined) => void = killSelf): Faults {
  if (specs.length === 0) return noFaults;
  return {
    at(point, landingId) {
      if (specs.some((s) => s.point === point && (s.landing === null || s.landing === landingId))) act(point, landingId);
    },
  };
}

/** The lander's faults from its environment: none unless NODE_ENV=test. */
export function faultsFromEnv(env: NodeJS.ProcessEnv = process.env, act?: (point: FaultPoint, landingId: string | undefined) => void): Faults {
  const value = env.AGENTHUB_LANDER_FAULTS;
  if (!value || env.NODE_ENV !== 'test') return noFaults;
  return faultsFrom(parseFaults(value), act);
}

function killSelf(point: FaultPoint, landingId: string | undefined): void {
  process.stderr.write(`hub-lander: fault ${point}${landingId ? ` (${landingId})` : ''}: SIGKILL\n`);
  process.kill(process.pid, 'SIGKILL');
}
