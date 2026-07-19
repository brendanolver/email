/**
 * Core digest generation: fetch emails since the checkpoint, hand them
 * to Claude Haiku for categorisation against the six-bucket brief plus
 * whatever explicit rules Brendan has set, return the digest text.
 *
 * Kept model-agnostic-ish via an env var so the model can be bumped
 * later without a code change.
 */

import Anthropic from "@anthropic-ai/sdk";
import { fetchAllAccountsSince, type NormalisedEmail } from "./imap.js";
import { readCheckpoint, writeCheckpoint, readRules } from "./store.js";
import { sendDigestEmail } from "./mailer.js";
import { sendDigestSlack } from "./slack.js";
import { renderHtml, renderPlainText, type StructuredDigest } from "./render.js";

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
                  from: { type: "string" },
                  summary: { type: "string" },
                  whyItMatters: { type: "string" },
                  recommendedAction: { type: "string" },
                  priority: { type: "string", enum: ["Today", "This Week", "Can Wait"] },
                  draftReply: { type: "string", description: "Optional draft reply text." },
                },
                required: ["from", "summary", "whyItMatters", "recommendedAction", "priority"],
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

function emptyDigestResult(since: Date, until: Date, headline: string): DigestResult {
  const structured: StructuredDigest = { sections: [], headline };
  return {
    since,
    until,
    emailCount: 0,
    text: renderPlainText(structured),
    html: renderHtml(structured),
  };
}

export async function runDigest(): Promise<DigestResult> {
  const since = await readCheckpoint();
  const until = new Date();

  const emails: NormalisedEmail[] = await fetchAllAccountsSince(since);

  if (emails.length === 0) {
    await writeCheckpoint(until);
    return emptyDigestResult(since, until, "No new emails since the last check.");
  }

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

  const structured = toolUse.input as StructuredDigest;
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

  return { digest, deliveries };
}
