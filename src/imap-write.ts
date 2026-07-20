/**
 * The only IMAP write operations this connector performs. Added
 * deliberately on 2026-07-21 after Brendan explicitly approved write
 * access — the connector was read-only by design up to that point
 * (see imap.ts header). Kept in a separate file on purpose, so the
 * read-only guarantee in imap.ts stays true by inspection, and so
 * every write path in the whole codebase is findable in one place.
 *
 * Each function here is scoped as narrowly as its job allows:
 * - deleteMessageById only ever deletes a single message matched by
 *   an exact Message-ID already on record (the digest's own previous
 *   send) — never a search- or filter-based bulk delete.
 * - flagMessageById only adds flags (e.g. \Flagged) — never
 *   destructive, never removes existing flags.
 * - markAllSeenInSpecialUse only marks \Seen inside the account's own
 *   Junk or Trash folder — it never opens INBOX for writing.
 *
 * None of these run without a human having approved the behaviour
 * that triggers them; they don't expand in scope on their own.
 */

import { ImapFlow } from "imapflow";
import type { Account } from "./imap.js";

async function withClient<T>(account: Account, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false, // avoid dumping IMAP traffic (which can include content) to logs
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

/**
 * Deletes exactly one message matched by an exact Message-ID header.
 * No-op (returns false) if no such message is found — never falls
 * back to a broader match.
 */
export async function deleteMessageById(account: Account, mailboxPath: string, messageId: string): Promise<boolean> {
  return withClient(account, async (client) => {
    const lock = await client.getMailboxLock(mailboxPath, { readOnly: false });
    try {
      const uids = await client.search({ header: { "message-id": messageId } }, { uid: true });
      if (!uids || uids.length === 0) return false;
      await client.messageDelete(uids, { uid: true });
      return true;
    } finally {
      lock.release();
    }
  });
}

/**
 * Adds IMAP flags (e.g. ["\\Flagged"]) to exactly one message matched
 * by an exact Message-ID header. Never removes flags, never touches
 * any other message.
 */
export async function flagMessageById(
  account: Account,
  mailboxPath: string,
  messageId: string,
  flags: string[]
): Promise<boolean> {
  return withClient(account, async (client) => {
    const lock = await client.getMailboxLock(mailboxPath, { readOnly: false });
    try {
      const uids = await client.search({ header: { "message-id": messageId } }, { uid: true });
      if (!uids || uids.length === 0) return false;
      await client.messageFlagsAdd(uids, flags, { uid: true });
      return true;
    } finally {
      lock.release();
    }
  });
}

const JUNK_PATH_FALLBACKS = ["Junk", "INBOX.Junk", "Junk E-mail", "Spam"];
const TRASH_PATH_FALLBACKS = ["Deleted Messages", "Trash", "INBOX.Trash", "Deleted Items"];

async function resolveSpecialUseMailbox(client: ImapFlow, specialUse: "\\Junk" | "\\Trash"): Promise<string | null> {
  const list = await client.list();

  const bySpecialUse = list.find((mb) => mb.specialUse === specialUse);
  if (bySpecialUse) return bySpecialUse.path;

  // Not every server (VentraIP's cPanel/Dovecot setup in particular)
  // exposes the IMAP SPECIAL-USE extension, so fall back to common
  // folder names rather than silently doing nothing.
  const fallbacks = specialUse === "\\Junk" ? JUNK_PATH_FALLBACKS : TRASH_PATH_FALLBACKS;
  const byName = list.find((mb) => fallbacks.includes(mb.path));
  return byName?.path ?? null;
}

/**
 * Marks every currently-unseen message \Seen inside the account's
 * Junk or Trash folder. Returns null if that folder can't be
 * resolved on this account (e.g. no Junk folder exists). Never opens
 * INBOX or any other folder.
 */
export async function markAllSeenInSpecialUse(
  account: Account,
  specialUse: "\\Junk" | "\\Trash"
): Promise<{ mailbox: string; count: number } | null> {
  return withClient(account, async (client) => {
    const mailboxPath = await resolveSpecialUseMailbox(client, specialUse);
    if (!mailboxPath) return null;

    const lock = await client.getMailboxLock(mailboxPath, { readOnly: false });
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) return { mailbox: mailboxPath, count: 0 };
      await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
      return { mailbox: mailboxPath, count: uids.length };
    } finally {
      lock.release();
    }
  });
}
