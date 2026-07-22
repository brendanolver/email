/**
 * Core digest generation: fetch emails since the checkpoint, hand them
 * to Claude Haiku for categorisation against the six-bucket brief plus
 * whatever explicit rules Brendan has set, return the digest text.
 *
 * Kept model-agnostic-ish via an env var so the model can be bumped
 * later without a code change.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  fetchAllAccountsSince,
  listInboxMessageIds,
  loadAccounts,
  type NormalisedEmail,
  type MailboxSource,
} from "./imap.js";
import { deleteMessageById, flagMessageById, markAllSeenInSpecialUse } from "./imap-write.js";
import {
  readCheckpoint,
  writeCheckpoint,
  readRules,
  recordTrackedMessages,
  diffTrackedAgainstCurrent,
  takeUnsuggestedCandidates,
  getDigestRotation,
  setDigestRotation,
  readDomainRules,
  cacheDigestItems,
  pruneAndGetCarryForward,
  appendPendingUnsubscribeSuggestions,
  takeAllPendingUnsubscribeSuggestions,
  type UnsubscribeCandidate,
  type CachedDigestItem,
} from "./store.js";
import { sendDigestEmail, sendUnsubscribeSuggestionsEmail } from "./mailer.js";
import { sendDigestSlack } from "./slack.js";
import {
  renderHtml,
  renderPlainText,
  renderUnsubscribeEmailHtml,
  renderUnsubscribeEmailText,
  type StructuredDigest,
  type DigestItem,
} from "./render.js";

const MODEL = process.env.DIGEST_MODEL ?? "claude-haiku-4-5-20251001";

const SECTION_NAMES = [
  "Urgent",
  "Decisions Required",
  "Reply Needed",
  "Waiting on Others",
  "FYI",
  "Low Priority",
] as const;

const BASE_BRIEF = `You are Brendan's executive email assistant. You'll be given a batch of new emails (JSON) from his connected mailboxes. Your job:

- Identify only the emails that genuinely require his attention.
- Ignore or deprioritise newsletters, marketing emails, automated notifications, receipts, and other low-value messages unless they contain something important.
- Group into six sections, omitting any that are empty: Urgent (needs action today), Decisions Required (needs a decision/approval), Reply Needed (needs a response, not urgent), Waiting on Others (no action needed right now), FYI (useful, no action needed), Low Priority (everything else that can wait).
- For each important email give: who it's from, a 1-2 sentence summary, why it matters, the recommended next action, and a priority (Today / This Week / Can Wait).
- Where a reply is appropriate, draft it concisely and professionally in Brendan's voice, but never imply it has been sent — it's a draft for his review only.
- The goal is filtering signal from noise: if 20 emails arrived and only 3 matter, surface only those 3 prominently.
- If nothing in the batch is worth surfacing, say so briefly via the headline field and return empty sections rather than padding out a report.
- Every item MUST include a messageId field, copied EXACTLY (character for character) from the "messageId" field of the corresponding email in the input JSON. Never invent, alter, or omit it — it's used to track the item across future digests, not shown to Brendan.
- Call the submit_digest tool exactly once with the full structured result. Do not respond in plain text.`;

// Forces Claude to return validated structured data instead of freeform
// markdown — this is what lets us render a real HTML email (colour-coded
// sections/priority pills) rather than emailing raw asterisks and hashes.
const SUBMIT_DIGEST_TOOL: Anthropic.Tool = {
  name: "submit_digest",
  description: "Submit the categorised email digest.",
  input_schema: {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description: "Optional one-line summary, especially used when nothing important arrived.",
      },
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", enum: SECTION_NAMES as unknown as string[] },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  messageId: {
                    type: "string",
                    description: "Copied exactly from the corresponding input email's messageId field. Not shown to Brendan — used internally to track this item across future digests.",
                  },
                  from: { type: "string" },
                  summary: { type: "string" },
                  whyItMatters: { type: "string" },
                  recommendedAction: { type: "string" },
                  priority: { type: "string", enum: ["Today", "This Week", "Can Wait"] },
                  draftReply: { type: "string", description: "Optional draft reply text." },
                },
                required: ["messageId", "from", "summary", "whyItMatters", "recommendedAction", "priority"],
              },
            },
          },
          required: ["name", "items"],
        },
      },
    },
    required: ["sections"],
  },
};

export interface DigestResult {
  since: Date;
  until: Date;
  emailCount: number;
  text: string;
  html: string;
}

/** What Claude actually returns per item — includes messageId, which render.ts's DigestItem deliberately doesn't declare (it's plumbing, never rendered). */
interface RawDigestItem extends DigestItem {
  messageId: string;
}

function extractDomain(from: string): string | null {
  const angleMatch = from.match(/<([^>]+)>/);
  const address = angleMatch ? angleMatch[1] : from;
  const at = address.lastIndexOf("@");
  if (at === -1) return null;
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

interface DomainRuleOutcome {
  kept: NormalisedEmail[];
  markedReadCount: number;
  deletedCount: number;
  excludedCount: number;
}

/**
 * Applies deterministic domain rules before anything else touches
 * the batch: auto-delete removes the message from the mailbox and
 * excludes it from the digest entirely (Claude never sees it, and it
 * never enters deletion-tracking — Brendan didn't delete it, we did,
 * on his standing instruction, so it shouldn't count toward or
 * trigger an unsubscribe suggestion for a domain he's already handled).
 * auto-mark-read only changes the \Seen flag and leaves the email in
 * the normal digest flow untouched. exclude is the non-destructive
 * option — filtered out of the digest the same as auto-delete, but no
 * mailbox write happens at all: the email is left completely alone,
 * still unread/wherever it is, just never surfaced in the digest.
 */
async function applyDomainRules(emails: NormalisedEmail[]): Promise<DomainRuleOutcome> {
  const rules = await readDomainRules();
  if (rules.length === 0) return { kept: emails, markedReadCount: 0, deletedCount: 0, excludedCount: 0 };

  const actionByDomain = new Map(rules.map((r) => [r.domain, r.action]));
  const accountBySource = new Map(loadAccounts().map((a) => [a.source, a]));

  const kept: NormalisedEmail[] = [];
  let markedReadCount = 0;
  let deletedCount = 0;
  let excludedCount = 0;

  for (const email of emails) {
    const domain = extractDomain(email.from);
    const action = domain ? actionByDomain.get(domain) : undefined;

    if (!action) {
      kept.push(email);
      continue;
    }

    if (action === "exclude") {
      // No mailbox interaction at all — purely a digest-content filter.
      excludedCount++;
      continue;
    }

    const account = accountBySource.get(email.mailbox);
    if (!account) {
      kept.push(email); // shouldn't happen, but never silently lose an email if it does
      continue;
    }

    if (action === "auto-delete") {
      const deleted = await deleteMessageById(account, "INBOX", email.messageId).catch((err) => {
        console.error(`[digest] domain rule: failed to auto-delete mail from ${domain}:`, err);
        return false;
      });
      if (deleted) deletedCount++;
      continue; // excluded from the digest either way — don't surface a half-deleted message
    }

    // action === "auto-mark-read"
    const marked = await flagMessageById(account, "INBOX", email.messageId, ["\\Seen"]).catch((err) => {
      console.error(`[digest] domain rule: failed to auto-mark-read mail from ${domain}:`, err);
      return false;
    });
    if (marked) markedReadCount++;
    kept.push(email);
  }

  return { kept, markedReadCount, deletedCount, excludedCount };
}

// How far back the "is this still in the inbox" presence-check looks
// for carry-forward purposes. Deliberately separate from imap.ts's
// MAX_LOOKBACK_DAYS (30), which caps how far the *new-mail* fetch can
// ever reach from a checkpoint — that's a different safety concern
// (guards against a corrupted/very old checkpoint triggering a huge
// scan) and widening it would be the wrong lever to pull here.
// Widened from 30 to 90 days on 2026-07-21 at Brendan's request — his
// inbox holds onto unresolved items longer than a month.
const CARRY_FORWARD_LOOKBACK_DAYS = 90;

/**
 * One presence-check per account per cycle, shared by two different
 * consumers with two different needs: sender-deletion tracking (which
 * only cares about the last TRACKING_WINDOW_DAYS) and digest
 * carry-forward (which needs to know about anything still in the
 * inbox up to CARRY_FORWARD_LOOKBACK_DAYS back, un-windowed by intent
 * beyond that cap — see store.ts). Computing this once and reusing it
 * for both avoids a duplicate IMAP round-trip per account per cycle.
 * A wider window here than either consumer strictly needs is always
 * safe: an entry either consumer cares about that's genuinely still
 * present will always be found; the narrower TRACKING_WINDOW_DAYS
 * logic in diffTrackedAgainstCurrent only ever looks at its own
 * tracked entries' age, not this window's size.
 *
 * Best-effort per account: if one account's check fails, its mailbox
 * is simply left out of the map rather than failing the whole cycle —
 * store.ts treats a missing mailbox as "unknown", never as "gone",
 * so a transient failure here can never look like Brendan deleted
 * or moved something he didn't.
 */
async function computeCurrentInboxIds(): Promise<Partial<Record<MailboxSource, Set<string>>>> {
  const accounts = loadAccounts();
  const presenceSince = new Date(Date.now() - CARRY_FORWARD_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const currentIdsByMailbox: Partial<Record<MailboxSource, Set<string>>> = {};

  for (const account of accounts) {
    try {
      currentIdsByMailbox[account.source] = await listInboxMessageIds(account, presenceSince);
    } catch (err) {
      console.error(`[digest] presence check failed for ${account.source} — leaving it out of this cycle's diff:`, err);
    }
  }

  return currentIdsByMailbox;
}

/**
 * Sender-deletion tracking: compares tracked messages against what's
 * currently present, then returns any senders that just crossed the
 * unsubscribe threshold for the first time. Best-effort/non-fatal —
 * see the comment history in this file for why (a crash was traced
 * to an unguarded version of this).
 */
async function computeUnsubscribeSuggestions(
  currentIdsByMailbox: Partial<Record<MailboxSource, Set<string>>>
): Promise<UnsubscribeCandidate[]> {
  try {
    await diffTrackedAgainstCurrent(currentIdsByMailbox);
    return await takeUnsuggestedCandidates();
  } catch (err) {
    console.error("[digest] deletion tracking failed — skipping unsubscribe suggestions this cycle:", err);
    return [];
  }
}

/** Merges cached carry-forward items into the matching section, creating the section if this cycle had no new items in it. */
function mergeCarryForward(
  structured: StructuredDigest,
  carryForward: { messageId: string; cached: CachedDigestItem }[]
): void {
  for (const { cached } of carryForward) {
    let section = structured.sections.find((s) => s.name === cached.section);
    if (!section) {
      section = { name: cached.section, items: [] };
      structured.sections.push(section);
    }
    section.items.push({ ...(cached.item as unknown as DigestItem), carriedOver: true });
  }
}

export async function runDigest(): Promise<DigestResult> {
  const since = await readCheckpoint();
  const until = new Date();

  const rawEmails: NormalisedEmail[] = await fetchAllAccountsSince(since);

  // Domain rules run first: auto-deleted mail is removed from the
  // mailbox and never seen again downstream (not by Claude, not by
  // tracking). auto-mark-read mail stays in the batch, just \Seen.
  // Best-effort: a failure here falls back to treating the batch as
  // if no domain rules applied, rather than blocking the digest.
  const {
    kept: emails,
    markedReadCount,
    deletedCount,
    excludedCount,
  } = await applyDomainRules(rawEmails).catch((err) => {
    console.error("[digest] domain rule pass failed — skipping domain rules this cycle:", err);
    return { kept: rawEmails, markedReadCount: 0, deletedCount: 0, excludedCount: 0 };
  });
  if (markedReadCount > 0 || deletedCount > 0 || excludedCount > 0) {
    console.log(`[digest] domain rules: marked ${markedReadCount} read, auto-deleted ${deletedCount}, excluded ${excludedCount}`);
  }

  // Track every email we've seen (for deletion-detection) regardless
  // of whether it ends up in this digest.
  await recordTrackedMessages(emails);

  const currentIdsByMailbox = await computeCurrentInboxIds();
  const unsubscribeSuggestions = await computeUnsubscribeSuggestions(currentIdsByMailbox);

  // Only genuinely new mail goes to Claude — carry-forward items are
  // re-rendered from cache below, never re-categorised, so API cost
  // stays bounded by new-mail volume regardless of how much sits
  // unresolved in the inbox over time.
  let structured: StructuredDigest;
  const emailByMessageId = new Map(emails.map((e) => [e.messageId, e]));

  if (emails.length === 0) {
    structured = { sections: [], headline: "No new emails since the last check." };
  } else {
    const rules = await readRules();
    const rulesBlock =
      rules.length > 0
        ? `\n\nBrendan's explicit preference rules (apply these when categorising):\n${rules.map((r) => `- ${r}`).join("\n")}`
        : "";

    const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: BASE_BRIEF + rulesBlock,
      tools: [SUBMIT_DIGEST_TOOL],
      tool_choice: { type: "tool", name: "submit_digest" },
      messages: [
        {
          role: "user",
          content: `Here are ${emails.length} new emails since ${since.toISOString()}:\n\n${JSON.stringify(emails, null, 2)}`,
        },
      ],
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === "submit_digest"
    );

    if (!toolUse) {
      throw new Error("Anthropic response did not include the expected submit_digest tool call.");
    }

    structured = toolUse.input as StructuredDigest;
  }

  // Cache this cycle's new items (keyed by the messageId Claude echoed
  // back) so they can be carried forward in future cycles for as long
  // as they're still physically sitting in the inbox.
  const cacheEntries: Record<string, CachedDigestItem> = {};
  const newMessageIds = new Set<string>();
  for (const section of structured.sections) {
    for (const rawItem of section.items as RawDigestItem[]) {
      if (!rawItem.messageId) continue; // shouldn't happen given the required schema field, but never let a malformed item crash the cycle
      newMessageIds.add(rawItem.messageId);
      const email = emailByMessageId.get(rawItem.messageId);
      if (email) {
        cacheEntries[rawItem.messageId] = {
          mailbox: email.mailbox,
          section: section.name,
          item: rawItem as unknown as Record<string, unknown>,
        };
      }
    }
  }
  await cacheDigestItems(cacheEntries);

  // Anything cached from an earlier cycle that's still physically in
  // the inbox — and wasn't already included as "new" above — gets
  // carried forward into this digest too. This is the behaviour
  // Brendan asked for explicitly: an email still sitting in the inbox
  // deserves to keep appearing until it's moved or deleted, not drop
  // off once it's no longer "new".
  const carryForward = await pruneAndGetCarryForward(currentIdsByMailbox, newMessageIds);
  mergeCarryForward(structured, carryForward);

  // Unsubscribe suggestions no longer ride along in the hourly digest
  // (moved to a separate weekly email per Brendan's request) — just
  // queue them up for that send.
  await appendPendingUnsubscribeSuggestions(unsubscribeSuggestions);
  const text = renderPlainText(structured);
  const html = renderHtml(structured);

  // Only mark the checkpoint after the digest was actually produced —
  // a failed Anthropic call (thrown above) leaves the checkpoint
  // untouched, so the next run naturally re-covers this window.
  await writeCheckpoint(until);

  return { since, until, emailCount: emails.length, text, html };
}

export interface DeliveryOutcome {
  channel: "email" | "slack";
  ok: boolean;
  skipped?: boolean; // e.g. Slack with no webhook configured yet — not a failure
  error?: string;
}

export interface DigestAndDeliveryResult {
  digest: DigestResult;
  deliveries: DeliveryOutcome[];
}

/**
 * Housekeeping around the digest email itself: rotates a 2-cycle
 * window rather than racing SMTP-to-IMAP visibility. Flagging the
 * just-sent digest synchronously was tried first and failed every
 * time in production — 15s of retries isn't long enough for the
 * email to round-trip out via SMTP and back in via IMAP. Instead:
 * flag the digest sent *last* cycle (which has now had a full cycle's
 * worth of time, easily long enough) and delete the one from *two*
 * cycles ago (already flagged, safe to remove). Also cleans up
 * Junk/Trash on both accounts. Every step is best-effort and
 * independently logged — a failure here never blocks the digest
 * itself from having been sent.
 */
async function runInboxHousekeeping(sentMessageId: string): Promise<void> {
  const accounts = loadAccounts();
  const icloudAccount = accounts.find((a) => a.source === "icloud");

  if (icloudAccount) {
    const recipient = process.env.DIGEST_EMAIL_TO ?? icloudAccount.user;
    const digestLandsInOwnMailbox = recipient.toLowerCase() === icloudAccount.user.toLowerCase();

    if (digestLandsInOwnMailbox) {
      const { flagCandidateId, deleteCandidateId } = await getDigestRotation();

      if (deleteCandidateId) {
        const deleted = await deleteMessageById(icloudAccount, "INBOX", deleteCandidateId).catch((err) => {
          console.error("[digest] failed to delete old digest email:", err);
          return false;
        });
        console.log(`[digest] digest from 2 cycles ago ${deleted ? "deleted" : "not found — already gone"}`);
      }

      let flaggedLastCycle = false;
      if (flagCandidateId) {
        flaggedLastCycle = await flagMessageById(icloudAccount, "INBOX", flagCandidateId, ["\\Flagged"]).catch((err) => {
          console.error("[digest] failed to flag previous cycle's digest:", err);
          return false;
        });
        console.log(
          `[digest] previous cycle's digest ${flaggedLastCycle ? "flagged" : "still not found via IMAP — moving on regardless, will not retry"}`
        );
      }

      // Rotate: whatever we just tried to flag becomes next cycle's
      // delete target regardless of whether flagging succeeded — we
      // never want to lose track of it and leak digest emails forever.
      await setDigestRotation({ flagCandidateId: sentMessageId, deleteCandidateId: flagCandidateId });
    } else {
      console.log("[digest] DIGEST_EMAIL_TO doesn't match a connected mailbox — skipping flag/delete housekeeping.");
    }
  }

  for (const account of accounts) {
    for (const specialUse of ["\\Junk", "\\Trash"] as const) {
      const result = await markAllSeenInSpecialUse(account, specialUse).catch((err) => {
        console.error(`[digest] failed marking ${specialUse} read on ${account.source}:`, err);
        return null;
      });
      if (result) console.log(`[digest] marked ${result.count} message(s) read in ${account.source}:${result.mailbox}`);
    }
  }
}

/**
 * Runs the digest AND actually attempts delivery — shared by both the
 * cron scheduler and the manual run_digest_now tool, so a "successful"
 * manual test run means email/Slack were genuinely attempted, not just
 * the categorisation half of the pipeline.
 */
export async function runDigestAndDeliver(): Promise<DigestAndDeliveryResult> {
  const digest = await runDigest();

  const subject =
    digest.emailCount === 0
      ? "Inbox digest: nothing new"
      : `Inbox digest: ${digest.emailCount} new email${digest.emailCount === 1 ? "" : "s"}`;

  const [emailOutcome, slackOutcome] = await Promise.allSettled([
    sendDigestEmail(subject, digest.text, digest.html),
    sendDigestSlack(`*${subject}*\n\n${digest.text}`),
  ]);

  const deliveries: DeliveryOutcome[] = [
    {
      channel: "email",
      ok: emailOutcome.status === "fulfilled",
      error: emailOutcome.status === "rejected" ? String(emailOutcome.reason) : undefined,
    },
    {
      channel: "slack",
      ok: slackOutcome.status === "fulfilled",
      skipped: slackOutcome.status === "fulfilled" && slackOutcome.value === false,
      error: slackOutcome.status === "rejected" ? String(slackOutcome.reason) : undefined,
    },
  ];

  if (emailOutcome.status === "fulfilled") {
    // Fire-and-forget from the caller's perspective — housekeeping
    // failures are logged, never thrown, and never affect the
    // reported delivery outcome above.
    await runInboxHousekeeping(emailOutcome.value.messageId).catch((err) =>
      console.error("[digest] inbox housekeeping failed:", err)
    );
  }

  return { digest, deliveries };
}

export interface UnsubscribeDigestResult {
  sent: boolean;
  count: number;
  error?: string;
}

/**
 * Delivers the weekly unsubscribe-suggestions email — drains whatever
 * has accumulated since the last send. Skips sending entirely if
 * there's nothing to report, rather than emailing an empty "no
 * suggestions this week" notice. Shared by the weekly cron job and a
 * manual trigger tool, same pattern as runDigestAndDeliver.
 */
export async function runUnsubscribeDigestAndDeliver(): Promise<UnsubscribeDigestResult> {
  const suggestions = await takeAllPendingUnsubscribeSuggestions();

  if (suggestions.length === 0) {
    return { sent: false, count: 0 };
  }

  try {
    await sendUnsubscribeSuggestionsEmail(
      `Unsubscribe suggestions: ${suggestions.length} sender${suggestions.length === 1 ? "" : "s"}`,
      renderUnsubscribeEmailText(suggestions),
      renderUnsubscribeEmailHtml(suggestions)
    );
    return { sent: true, count: suggestions.length };
  } catch (err) {
    // Put the drained suggestions back so they aren't lost — the
    // whole point of draining-then-sending is that a delivery
    // failure shouldn't silently discard them.
    await appendPendingUnsubscribeSuggestions(suggestions);
    return { sent: false, count: suggestions.length, error: String(err) };
  }
}
