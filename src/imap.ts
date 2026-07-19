/**
 * Shared read-only IMAP logic, used by both the local prototype script
 * and the MCP server. Verified against real iCloud + VentraIP accounts
 * on 2026-07-17: fetched messages stayed unread on both servers under
 * controlled test conditions (see architecture doc §2 for the test
 * protocol). Do not change the readOnly/EXAMINE behaviour below without
 * re-running that same verification.
 */

import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";

export type MailboxSource = "icloud" | "ventraip";

export interface NormalisedEmail {
  mailbox: MailboxSource;
  messageId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  receivedAt: string;
  bodyText: string;
}

export interface Account {
  source: MailboxSource;
  host: string;
  port: number;
  user: string;
  pass: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function loadAccounts(): Account[] {
  return [
    {
      source: "icloud",
      host: requireEnv("ICLOUD_IMAP_HOST"),
      port: Number(requireEnv("ICLOUD_IMAP_PORT")),
      user: requireEnv("ICLOUD_USERNAME"),
      pass: requireEnv("ICLOUD_APP_PASSWORD"),
    },
    {
      source: "ventraip",
      host: requireEnv("VENTRAIP_IMAP_HOST"),
      port: Number(requireEnv("VENTRAIP_IMAP_PORT")),
      user: requireEnv("VENTRAIP_USERNAME"),
      pass: requireEnv("VENTRAIP_PASSWORD"),
    },
  ];
}

// Hard caps so a bad/old "since" value can't trigger a huge IMAP scan.
export const MAX_LOOKBACK_DAYS = 30;
export const MAX_MESSAGES_PER_MAILBOX = 500;

export async function fetchSince(account: Account, sinceExact: Date): Promise<NormalisedEmail[]> {
  const oldestAllowed = new Date(Date.now() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const effectiveSince = sinceExact < oldestAllowed ? oldestAllowed : sinceExact;

  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false, // avoid dumping IMAP traffic (which can include content) to logs
  });

  const results: NormalisedEmail[] = [];

  await client.connect();
  try {
    // readOnly: true => EXAMINE, not SELECT. Server-enforced: no flag
    // changes possible on this connection, for any reason. Verified
    // live against both accounts — see file header.
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const searchDateOnly = new Date(effectiveSince);
      searchDateOnly.setHours(0, 0, 0, 0);

      const uids = await client.search({ since: searchDateOnly }, { uid: true });
      if (!uids || uids.length === 0) return results;

      const cappedUids = uids.slice(-MAX_MESSAGES_PER_MAILBOX);

      for await (const message of client.fetch(
        cappedUids,
        { envelope: true, internalDate: true, source: true },
        { uid: true }
      ) as AsyncIterable<FetchMessageObject>) {
        const rawDate = message.internalDate ?? message.envelope?.date;
        if (!rawDate) continue;
        const receivedAt = rawDate instanceof Date ? rawDate : new Date(rawDate);
        if (receivedAt < effectiveSince) continue; // precise cutoff, SEARCH SINCE is date-only

        if (!message.source) continue;
        const parsed = await simpleParser(message.source);

        results.push({
          mailbox: account.source,
          messageId: parsed.messageId ?? message.envelope?.messageId ?? `no-id-${message.uid}`,
          from: parsed.from?.text ?? "",
          to: parsed.to
            ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).flatMap((a) => a.value.map((v) => v.address ?? ""))
            : [],
          cc: parsed.cc
            ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]).flatMap((a) => a.value.map((v) => v.address ?? ""))
            : [],
          subject: parsed.subject ?? "",
          receivedAt: receivedAt.toISOString(),
          // TODO Stage 3: fall back to stripped HTML if plain text part is absent
          bodyText: cleanBodyText(parsed.text ?? ""),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return results;
}

// Heuristic cleanup so raw email bodies don't dump entire quoted reply
// chains, signatures, and tracking links into whatever summarises
// this feed. Deliberately aggressive per Brendan's choice — accepts
// some risk of cutting real content in exchange for much less noise.
// Not perfect: quote/signature formats vary too much to catch every
// case, this catches the common ones seen in real test data (Outlook
// "From:/Sent:/To:", Apple Mail "On ... wrote:", Chinese client
// "发件人：" chains, "-----Original Message-----", ">" quote lines).
const MAX_BODY_CHARS = 500;

const QUOTE_CHAIN_MARKERS: RegExp[] = [
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^-{2,}\s*Replied Message\s*-{2,}/im,
  /^On\s.{0,120}\swrote:\s*$/im,
  /^From:\s.+$/im,
  /^发件人[:：]/m,
  /^>\s?.+$/m,
];

const SIGNOFF_LINE = /^(regards|kind regards|kindest regards|thanks|thank you|cheers|best regards|warm regards|best)[,.]?\s*$/gim;
const SIGNATURE_TOKENS = /(mobile:|phone:|tel:|email:|mailto:|www\.|unit \d|pty ltd)/i;

export function cleanBodyText(raw: string): string {
  if (!raw) return raw;

  let text = raw;

  // Cut at the earliest quoted-chain marker found.
  let earliestCut = text.length;
  for (const marker of QUOTE_CHAIN_MARKERS) {
    const match = marker.exec(text);
    if (match && match.index > 0 && match.index < earliestCut) {
      earliestCut = match.index;
    }
  }
  text = text.slice(0, earliestCut).trimEnd();

  // Cut at the last sign-off line if what follows looks signature-like.
  let lastSignoff = -1;
  let signoffMatch: RegExpExecArray | null;
  SIGNOFF_LINE.lastIndex = 0;
  while ((signoffMatch = SIGNOFF_LINE.exec(text)) !== null) {
    lastSignoff = signoffMatch.index;
  }
  if (lastSignoff >= 0) {
    const tail = text.slice(lastSignoff);
    if (tail.length < 600 && SIGNATURE_TOKENS.test(tail)) {
      text = text.slice(0, lastSignoff).trimEnd();
    }
  }

  text = text.trim();
  if (text.length > MAX_BODY_CHARS) {
    text = text.slice(0, MAX_BODY_CHARS).trimEnd() + "\n…[truncated]";
  }

  return text;
}

export function dedupe(emails: NormalisedEmail[]): NormalisedEmail[] {
  const seen = new Set<string>();
  const out: NormalisedEmail[] = [];
  for (const email of emails) {
    if (seen.has(email.messageId)) continue;
    seen.add(email.messageId);
    out.push(email);
  }
  return out;
}

export async function fetchAllAccountsSince(since: Date): Promise<NormalisedEmail[]> {
  const accounts = loadAccounts();
  const all: NormalisedEmail[] = [];
  for (const account of accounts) {
    const emails = await fetchSince(account, since);
    all.push(...emails);
  }
  return dedupe(all);
}
