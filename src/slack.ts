/**
 * Optional Slack delivery via an Incoming Webhook. Deliberately
 * degrades gracefully: if SLACK_WEBHOOK_URL isn't set (not configured
 * yet), this is a no-op rather than an error, since Slack delivery
 * was deferred until Brendan sets a webhook up.
 */

/**
 * Returns true if an actual send was attempted and succeeded, false if
 * skipped because no webhook is configured yet. Throws on a genuine
 * delivery failure (webhook configured but the request failed).
 */
export async function sendDigestSlack(text: string): Promise<boolean> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return false; // not configured yet — skip silently, not a failure

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook returned ${res.status}: ${await res.text()}`);
  }
  return true;
}
