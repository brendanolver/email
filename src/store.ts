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
const DOMAIN_RULES_FILE = path.join(DATA_DIR, "domain-rules.json");

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
 * Domain rules are deliberately separate from the free-text preference
 * rules above. Preference rules are interpreted by Claude and only
 * ever affect categorisation — safe to leave loose and natural-language
 * because nothing destructive rides on them. Domain rules trigger a
 * real, code-enforced mailbox action (mark-read or delete) every
 * cycle, before Claude ever sees the message, so they're matched by
 * exact domain string in code, never by LLM interpretation.
 */
// "exclude" added 2026-07-21: the non-destructive option — the email
// is filtered out of the digest entirely but otherwise left completely
// untouched (not deleted, not marked read, no mailbox write at all).
// Distinct from "auto-delete" (which actually removes the message).
export type DomainRuleAction = "auto-mark-read" | "auto-delete" | "exclude";

export interface DomainRule {
  domain: string; // lowercase, no leading "@"
  action: DomainRuleAction;
  addedAt: string; // ISO
}

export async function readDomainRules(): Promise<DomainRule[]> {
  try {
    const raw = await fs.readFile(DOMAIN_RULES_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // no domain rules file yet
  }
  return [];
}

async function writeDomainRules(rules: DomainRule[]): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(DOMAIN_RULES_FILE, JSON.stringify(rules, null, 2), "utf-8");
}

function normaliseDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, "");
}

/** Adds a domain rule, replacing any existing rule for the same domain. */
export async function addDomainRule(domain: string, action: DomainRuleAction): Promise<DomainRule[]> {
  const normalised = normaliseDomain(domain);
  const rules = await readDomainRules();
  const existingIndex = rules.findIndex((r) => r.domain === normalised);
  const rule: DomainRule = { domain: normalised, action, addedAt: new Date().toISOString() };

  if (existingIndex >= 0) rules[existingIndex] = rule;
  else rules.push(rule);

  await writeDomainRules(rules);
  return rules;
}

export async function removeDomainRule(domain: string): Promise<DomainRule[]> {
  const normalised = normaliseDomain(domain);
  const rules = (await readDomainRules()).filter((r) => r.domain !== normalised);
  await writeDomainRules(rules);
  return rules;
}

/**
 * State backing three behaviours (all added 2026-07-21, after explicit
 * approval for write access):
 *  - flagCandidateId / deleteCandidateId: a 2-cycle rotation for the
 *    digest email itself. Flagging the digest right after sending it
 *    was tried first and failed every time in production (~15s isn't
 *    long enough for SMTP-out-then-back-into-IMAP latency) — instead,
 *    each cycle flags the digest sent *last* cycle (which has now had
 *    a full cycle, i.e. comfortably long enough, to become visible)
 *    and deletes the one from *two* cycles ago (which was already
 *    flagged last time round). Steady state: at most 2 digests ever
 *    sit in the inbox, never a stale unflagged one deleted by mistake.
 *  - tracked: every inbox message we've seen, so a future run can tell
 *    whether it later vanished (deleted/moved) — read-only to compute.
 *    Windowed (TRACKING_WINDOW_DAYS) — this is a recent-behaviour
 *    signal, not something that needs to persist indefinitely.
 *  - senderDeletions: counts per sender, feeding the "frequently
 *    deleted, consider unsubscribing" suggestions surfaced in the digest.
 *  - digestCache: every item Claude has categorised, keyed by
 *    Message-ID, with NO time-based expiry — added 2026-07-21 so an
 *    item that's still physically sitting in the inbox keeps
 *    reappearing in the digest until it's moved or deleted, however
 *    long that takes, rather than silently dropping off once it's no
 *    longer "new". Pruned only when the message is confirmed gone
 *    from its mailbox's INBOX, never by age.
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

export interface CachedDigestItem {
  mailbox: MailboxSource;
  section: string;
  // Deliberately untyped/opaque here (store.ts shouldn't need to know
  // the exact shape of a digest item) — digest.ts owns that type.
  item: Record<string, unknown>;
}

interface DigestState {
  flagCandidateId?: string; // sent last cycle — flag it now, it's had time to land
  deleteCandidateId?: string; // sent 2 cycles ago — already flagged, safe to remove
  tracked: Record<string, TrackedMessage>; // key: Message-ID
  senderDeletions: Record<string, SenderDeletionRecord>; // key: normalised sender address
  digestCache: Record<string, CachedDigestItem>; // key: Message-ID, no expiry
  // Accumulates between weekly unsubscribe-suggestion sends (added
  // 2026-07-21, moved out of the main hourly digest per Brendan's
  // request). Detection still runs every digest cycle as before —
  // only *delivery* moved to a separate weekly cadence.
  pendingUnsubscribeSuggestions: UnsubscribeCandidate[];
}

function defaultState(): DigestState {
  return { tracked: {}, senderDeletions: {}, digestCache: {}, pendingUnsubscribeSuggestions: [] };
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

export interface DigestRotation {
  flagCandidateId?: string;
  deleteCandidateId?: string;
}

export async function getDigestRotation(): Promise<DigestRotation> {
  const state = await readState();
  return { flagCandidateId: state.flagCandidateId, deleteCandidateId: state.deleteCandidateId };
}

export async function setDigestRotation(next: DigestRotation): Promise<void> {
  const state = await readState();
  state.flagCandidateId = next.flagCandidateId;
  state.deleteCandidateId = next.deleteCandidateId;
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

/** Adds newly-suggested candidates to the pending queue, to be delivered by the next weekly unsubscribe-suggestions send. */
export async function appendPendingUnsubscribeSuggestions(candidates: UnsubscribeCandidate[]): Promise<void> {
  if (candidates.length === 0) return;
  const state = await readState();
  state.pendingUnsubscribeSuggestions.push(...candidates);
  await writeState(state);
}

/** Drains and returns everything accumulated since the last weekly send. */
export async function takeAllPendingUnsubscribeSuggestions(): Promise<UnsubscribeCandidate[]> {
  const state = await readState();
  const pending = state.pendingUnsubscribeSuggestions;
  state.pendingUnsubscribeSuggestions = [];
  await writeState(state);
  return pending;
}

/** Caches this cycle's categorised items, keyed by Message-ID, for future carry-forward. Overwrites any existing cache entry for the same id. */
export async function cacheDigestItems(entries: Record<string, CachedDigestItem>): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  const state = await readState();
  Object.assign(state.digestCache, entries);
  await writeState(state);
}

export interface CarryForwardEntry {
  messageId: string;
  cached: CachedDigestItem;
}

/**
 * Returns cached items that are still physically present in their
 * mailbox's INBOX and weren't already included as "new" this cycle
 * (via excludeMessageIds), pruning anything no longer present as a
 * side effect. If a mailbox is missing from currentIdsByMailbox
 * (e.g. that account's presence-check failed this cycle), its cached
 * items are left untouched rather than assumed gone — a failed check
 * should never look like "Brendan moved this", only a confirmed one.
 */
export async function pruneAndGetCarryForward(
  currentIdsByMailbox: Partial<Record<MailboxSource, Set<string>>>,
  excludeMessageIds: Set<string>
): Promise<CarryForwardEntry[]> {
  const state = await readState();
  const carryForward: CarryForwardEntry[] = [];

  for (const [messageId, cached] of Object.entries(state.digestCache)) {
    const currentIds = currentIdsByMailbox[cached.mailbox];

    if (currentIds && !currentIds.has(messageId)) {
      delete state.digestCache[messageId];
      continue;
    }

    if (!excludeMessageIds.has(messageId)) {
      carryForward.push({ messageId, cached });
    }
  }

  await writeState(state);
  return carryForward;
}
