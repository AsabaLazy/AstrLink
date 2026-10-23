import {
  isModelDiscoveryProtocol,
  type RequestSession,
} from "./request-record-model";
import { sessionRunning } from "./session-live-model";

/**
 * How long a conversation still counts as in progress after its last call
 * ended. Agents run their tools between two calls, so a conversation in the
 * middle of a loop stays on the board instead of dropping out and back.
 */
export const ACTIVE_GRACE_MS = 60_000;

/** The span the live board charts and counts recent failures over. */
export const ACTIVITY_WINDOW_MS = 5 * 60_000;

/**
 * Samples further apart than this were not taken back to back: the page was
 * closed or hidden in between, so the chart leaves that stretch empty.
 */
export const ACTIVITY_SAMPLE_GAP_MS = 5_000;

export type ConversationActivity =
  | {
      state: "calling";
      /** Start of the oldest call still running. */
      since: number;
      calls: number;
    }
  | {
      state: "idle";
      /** When the last call ended. */
      since: number;
    };

function parseTime(value: string | null | undefined): number {
  return value ? Date.parse(value) : Number.NaN;
}

/**
 * What a conversation is doing at `nowMs`: running a call, or waiting between
 * calls within the grace. Null once it no longer counts as in progress, and
 * for model discovery, which is a single lookup rather than a conversation.
 */
export function conversationActivity(
  session: RequestSession,
  nowMs: number,
): ConversationActivity | null {
  if (isModelDiscoveryProtocol(session.input_protocol)) return null;
  if (sessionRunning(session)) {
    const starts = session.active_request_starts
      .map(parseTime)
      .filter(Number.isFinite);
    const latest = parseTime(session.last_started_at);
    const since =
      starts.length > 0
        ? Math.min(...starts)
        : Number.isFinite(latest)
          ? latest
          : nowMs;
    return {
      state: "calling",
      since: Math.min(since, nowMs),
      calls: Math.max(1, starts.length),
    };
  }
  const ended = parseTime(session.completed_at);
  if (!Number.isFinite(ended) || nowMs - ended >= ACTIVE_GRACE_MS) return null;
  return { state: "idle", since: Math.min(ended, nowMs) };
}

export interface ActivitySnapshot {
  /** Conversations running a call or waiting between calls. */
  conversations: number;
  /** Calls in flight across those conversations. */
  calls: number;
  /** Start of the oldest call in flight; null while none runs. */
  oldestCallStart: number | null;
  /** Conversations whose latest call failed within the window. */
  failures: number;
}

export function activitySnapshot(
  sessions: readonly RequestSession[],
  nowMs: number,
): ActivitySnapshot {
  let conversations = 0;
  let calls = 0;
  let failures = 0;
  let oldestCallStart: number | null = null;
  for (const session of sessions) {
    const activity = conversationActivity(session, nowMs);
    if (activity) conversations += 1;
    if (activity?.state === "calling") {
      calls += activity.calls;
      oldestCallStart =
        oldestCallStart === null
          ? activity.since
          : Math.min(oldestCallStart, activity.since);
    }
    if (
      session.status === "failed" &&
      !isModelDiscoveryProtocol(session.input_protocol)
    ) {
      const ended = parseTime(session.completed_at);
      if (Number.isFinite(ended) && nowMs - ended < ACTIVITY_WINDOW_MS) {
        failures += 1;
      }
    }
  }
  return { conversations, calls, oldestCallStart, failures };
}

export function sameActivitySnapshot(
  left: ActivitySnapshot | null,
  right: ActivitySnapshot,
): boolean {
  return (
    left !== null &&
    left.conversations === right.conversations &&
    left.calls === right.calls &&
    left.oldestCallStart === right.oldestCallStart &&
    left.failures === right.failures
  );
}

export interface ActivitySample {
  at: number;
  value: number;
}

/**
 * `samples` with `sample` appended. Keeps what the window still shows plus
 * the last sample before it, which holds the value at the window's left edge.
 * A clock set back leaves samples from the future; those are dropped.
 */
export function appendActivitySample(
  samples: readonly ActivitySample[],
  sample: ActivitySample,
  windowMs: number = ACTIVITY_WINDOW_MS,
): ActivitySample[] {
  const past = samples.filter((entry) => entry.at < sample.at);
  const start = sample.at - windowMs;
  const firstInside = past.findIndex((entry) => entry.at >= start);
  const from = Math.max(
    0,
    (firstInside === -1 ? past.length : firstInside) - 1,
  );
  return [...past.slice(from), sample];
}

/**
 * The conversations in progress and the rest in their list order. Active ones
 * keep their place while they alternate between calls and tools, so they are
 * ordered by when each conversation began, newest first.
 */
export function splitActiveSessions(
  sessions: readonly RequestSession[],
  nowMs: number,
): { active: RequestSession[]; rest: RequestSession[] } {
  const active: RequestSession[] = [];
  const rest: RequestSession[] = [];
  for (const session of sessions) {
    if (conversationActivity(session, nowMs)) active.push(session);
    else rest.push(session);
  }
  active.sort((left, right) => {
    const difference =
      Date.parse(right.started_at) - Date.parse(left.started_at);
    return difference || right.id.localeCompare(left.id);
  });
  return { active, rest };
}
