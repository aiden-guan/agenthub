// The lander's reports and direct messages for a landing that came back or
// parked (design §2.2.9): the texts come from report.ts and are the
// lander's own (no agent text in them); here they are filled in from the
// landing and trunk's config, and sent to the author through POST /messages.

import type { LandConfig } from '@agenthub/contract';
import type { Landing, LandingFailureCode, LandingReport } from '@agenthub/hub/protocol';
import { bestEffort, type LanderContext } from './context.js';
import { emptyReport, failureMessage, nextSteps, parkedMessage, sendbackMessage, type SendbackContext } from './report.js';

/** What the send-back texts need, from the landing and trunk's config (defaults when it couldn't be read). */
export function sendbackContext(ctx: LanderContext, landing: Landing, land: LandConfig | null, extra: Partial<SendbackContext> = {}): SendbackContext {
  return {
    landingId: landing.id,
    taskId: landing.task_id,
    trunk: ctx.trunk.branch,
    retry: landing.retry,
    keepPlaceRetries: land?.keepPlaceRetries ?? 2,
    sendbackGraceMin: land?.sendbackGraceMin ?? 30,
    command: land?.check,
    checkTimeoutMin: land?.checkTimeoutMin,
    maxFiles: land?.maxFiles,
    ...extra,
  };
}

/** A send-back report: the lander's message and next steps for `code`, plus the parts given. */
export function failureReport(code: LandingFailureCode, s: SendbackContext, parts: Partial<LandingReport> = {}): LandingReport {
  return { ...emptyReport(), message: failureMessage(code, s), next_steps: nextSteps(code, s), ...parts };
}

/** The direct message to the author of a landing that came back (best effort). */
export async function tellSendback(ctx: LanderContext, landing: Landing, code: LandingFailureCode, s: SendbackContext): Promise<void> {
  await bestEffort(ctx, `message to ${landing.agent}`, () => ctx.hub.post(landing.agent, sendbackMessage(code, s)));
}

/** The direct message to the author of a landing parked for approval (best effort). */
export async function tellParked(ctx: LanderContext, landing: Landing, paths: string[], approvers: string[] | null): Promise<void> {
  await bestEffort(ctx, `message to ${landing.agent}`, () => ctx.hub.post(landing.agent, parkedMessage({ landingId: landing.id, paths, approvers })));
}

/**
 * After a write that may have failed the landing (the hub fails it itself
 * past a retry limit, or at the claim gate): tells the author, unless the
 * write was a replay (the message went out the first time).
 */
export async function tellIfFailed(ctx: LanderContext, r: { landing: Landing; replayed?: boolean }, land: LandConfig | null, extra: Partial<SendbackContext> = {}): Promise<void> {
  if (r.replayed || r.landing.status !== 'failed' || !r.landing.failure) return;
  await tellSendback(ctx, r.landing, r.landing.failure.code, sendbackContext(ctx, r.landing, land, extra));
}
