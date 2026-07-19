/**
 * In-process scheduler running inside the same long-lived Railway
 * service that serves the MCP endpoint. This is what makes the
 * digest actually independent of the Claude app being open — Cowork's
 * own scheduled tasks only run while the desktop app is open, which
 * defeated the original point of this project. This scheduler runs
 * as long as the Railway container is up, full stop.
 *
 * Timezone hardcoded to Australia/Melbourne based on Brendan's
 * business addresses (Wendouree/Ballarat, VIC) seen in his own email
 * data during testing — flagged here in case that assumption is ever
 * wrong and needs correcting.
 */

import cron from "node-cron";
import { runDigestAndDeliver } from "./digest.js";

const TIMEZONE = "Australia/Melbourne";

async function runAndDeliver(label: string): Promise<void> {
  console.log(`[scheduler] ${label} run starting`);
  try {
    const { digest, deliveries } = await runDigestAndDeliver();
    for (const d of deliveries) {
      if (!d.ok) console.error(`[scheduler] ${d.channel} delivery failed:`, d.error);
    }
    console.log(`[scheduler] ${label} run complete — ${digest.emailCount} emails`);
  } catch (err) {
    // Deliberately does not update the checkpoint (runDigest only does
    // that on success) — a failed run just means the next run covers
    // a longer window.
    console.error(`[scheduler] ${label} run failed:`, err);
  }
}

export function startScheduler(): void {
  // Weekdays, hourly, 8am-6pm
  cron.schedule("0 8-18 * * 1-5", () => runAndDeliver("weekday"), { timezone: TIMEZONE });

  // Weekends, 9am/12pm/3pm/6pm
  cron.schedule("0 9,12,15,18 * * 0,6", () => runAndDeliver("weekend"), { timezone: TIMEZONE });

  console.log(`[scheduler] started (timezone: ${TIMEZONE})`);
}
