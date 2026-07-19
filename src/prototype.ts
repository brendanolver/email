/**
 * Stage 1 prototype CLI — thin wrapper around src/imap.ts for manual
 * testing against real accounts. Verified live 2026-07-17 against both
 * iCloud and VentraIP: correct messages returned, dedup works, and
 * read-only/EXAMINE held under controlled unread-status tests on both
 * servers.
 */

import "dotenv/config";
import { fetchAllAccountsSince } from "./imap.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function main() {
  const since = new Date(requireEnv("PROTOTYPE_SINCE"));
  console.log(`Fetching all accounts since ${since.toISOString()}...`);

  const deduped = await fetchAllAccountsSince(since);
  console.log(`\nTotal after dedup: ${deduped.length}`);

  // Deliberately truncated preview only — avoid dumping full email
  // content to a terminal/log during testing.
  for (const email of deduped) {
    console.log(
      `[${email.mailbox}] ${email.receivedAt} | ${email.from} | ${email.subject} | body: ${email.bodyText.slice(0, 80).replace(/\s+/g, " ")}...`
    );
  }
}

main().catch((err) => {
  console.error("Prototype run failed:", err);
  process.exit(1);
});
