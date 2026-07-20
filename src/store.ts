/**
 * Persistent state for the digest pipeline: the checkpoint (last
 * successful fetch time) and Brendan's explicit preference rules.
 *
 * Lives on a Railway Volume mounted at DATA_DIR so it survives
 * redeploys/restarts — Railway container filesystems are otherwise
 * ephemeral. Falls back to a local .data folder for local dev/testing
 * (gitignored), which is NOT persistent across Railway deploys, so
 * DATA_DIR must be set to the volume mount path in production.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { MailboxSource } from "./imap.js";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), ".data");
const CHECKPOINT_FILE = path.join(DATA_DIR, "checkpoint.txt");
const RULES_FILE = path.join(DATA_DIR, "rules.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readCheckpoint(): Promise<Date> {
  try {
    const raw = (await fs.readFile(CHECKPOINT_FILE, "utf-8")).trim();
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  } catch {
    // fall through to default below — no checkpoint yet (first run)
  }
  return new Date(Date.now() - 3 * 60 * 60 * 1000); // default: 3 hours ago
}

export async function writeCheckpoint(when: Date): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(CHECKPOINT_FILE, when.toISOString(), "utf-8");
}

export async function readRules(): Promise<string[]> {
  try {
    const raw = await fs.readFile(RULES_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((r) => typeof r === "string");
  } catch {
    // no rules file yet
  }
  return [];
}

export async function addRule(rule: string): Promise<string[]> {
  await ensureDataDir();
  const rules = await readRules();
  rules.push(rule);
  await fs.writeFile(RULES_FILE, JSON.stringify(rules, null, 2), "utf-8");
  return rules;
}

/**
 * State backing three behaviours (all added 2026-07-21, after explicit
 * approval for write access):
 *  - previousDigestMessageId: lets us delete last cycle's digest email
 *    before/after sending the new one, so exactly one digest sits in
 *    the inbox at a time.
 *  - tracked: every inbox message we've seen, so a future run can tell
 *    whether it later vanished (deleted/moved) — read-only to compute.
 *  - senderDeletions: counts per sender, feeding the "frequently
 *    deleted, consider unsubscribing" suggestions surfaced in the digest.
 */
interface TrackedMessage {
  mailbox: MailboxSource;
  from: string;
  subject: string;
  firstSeenAt: string; // ISO
  listUnsubscribe?: string;
}

interface SenderDeletionRecord {
  displayName: string;
  deletedCount: number;
  lastDeletedAt: string; // ISO
  listUnsubscribe?: string;
  suggested: boolean;
}

interface DigestState {
  previousDigestMessageId?: string;
  tracked: Record<string, TrackedMessage>; // key: Message-ID
  senderDeletions: Record<string, SenderDeletionRecord>; // key: normalised sender address
}

function defaultState(): DigestState {
  return { tracked: {}, senderDeletions: {} };
}

async function readState(): Promise<DigestState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

async function writeState(state: DigestState): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export async function getPreviousDigestMessageId(): Promise<string | undefined> {
  const state = await readState();
  return state.previousDigestMessageId;
}

export async function setPreviousDigestMessageId(messageId: string): Promise<void> {
  const state = await readState();
  state.previousDigestMessageId = messageId;
  await writeState(state);
}

function normaliseSender(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}

/** Adds newly-seen inbox messages to tracked state, keyed by Message-ID. Idempotent — already-tracked messages are left untouched. */
export async function recordTrackedMessages(
  emails: { mailbox: MailboxSource; messageId: string; from: string; subject: string; listUnsubscribe?: string }[]
): Promise<void> {
  if (emails.length === 0) return;
  const state = await readState();
  const now = new Date().toISOString();

  for (const email of emails) {
    if (state.tracked[email.messageId]) continue;
    state.tracked[email.messageId] = {
      mailbox: email.mailbox,
      from: email.from,
      subject: email.subject,
      firstSeenAt: now,
      listUnsubscribe: email.listUnsubscribe,
    };
  }

  await writeState(state);
}

// Comfortably under imap.ts's MAX_LOOKBACK_DAYS (30) so a tracked
// message never falls out of the IMAP search window we diff against
// before we've had a chance to check it — that would otherwise look
// exactly like a deletion and cause a false positive.
export const TRACKING_WINDOW_DAYS = 14;

/**
 * Compares tracked messages against what's currently present in each
 * mailbox's INBOX. Anything tracked, younger than the tracking
 * window, and no longer present is treated as deleted by Brendan and
 * counted against its sender. Anything older than the window is
 * dropped without counting — it aged out of the observation window,
 * which isn't the same thing as being deleted.
 */
export async function diffTrackedAgainstCurrent(
  currentIdsByMailbox: Partial<Record<MailboxSource, Set<string>>>
): Promise<void> {
  const state = await readState();
  const now = Date.now();
  const cutoffMs = TRACKING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  for (const [messageId, tracked] of Object.entries(state.tracked)) {
    const age = now - new Date(tracked.firstSeenAt).getTime();

    if (age > cutoffMs) {
      delete state.tracked[messageId];
      continue;
    }

    const currentIds = currentIdsByMailbox[tracked.mailbox];
    if (currentIds && !currentIds.has(messageId)) {
      const key = normaliseSender(tracked.from);
      const existing = state.senderDeletions[key];
      state.senderDeletions[key] = {
        displayName: tracked.from,
        deletedCount: (existing?.deletedCount ?? 0) + 1,
        lastDeletedAt: new Date().toISOString(),
        listUnsubscribe: tracked.listUnsubscribe ?? existing?.listUnsubscribe,
        suggested: existing?.suggested ?? false,
      };
      delete state.tracked[messageId];
    }
  }

  await writeState(state);
}

export interface UnsubscribeCandidate {
  from: string;
  deletedCount: number;
  listUnsubscribe?: string;
}

const UNSUBSCRIBE_THRESHOLD = 3;

/**
 * Senders deleted at least UNSUBSCRIBE_THRESHOLD times without ever
 * being suggested before. Marks them suggested as a side effect, so
 * each sender only ever surfaces once, not on every digest.
 */
export async function takeUnsuggestedCandidates(): Promise<UnsubscribeCandidate[]> {
  const state = await readState();
  const candidates: UnsubscribeCandidate[] = [];

  for (const record of Object.values(state.senderDeletions)) {
    if (record.suggested) continue;
    if (record.deletedCount < UNSUBSCRIBE_THRESHOLD) continue;
    candidates.push({
      from: record.displayName,
      deletedCount: record.deletedCount,
      listUnsubscribe: record.listUnsubscribe,
    });
    record.suggested = true;
  }

  if (candidates.length > 0) await writeState(state);
  return candidates;
}
