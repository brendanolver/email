/**
 * Renders a structured digest (see StructuredDigest below) into both
 * an HTML email body and a plain-text fallback / Slack message.
 *
 * HTML email quirk: most email clients (Outlook especially) don't
 * support <style> blocks reliably, so styling is all inline. Kept
 * deliberately simple — a coloured left-border per section, a
 * priority pill, no external assets/images (avoids remote-image
 * blocking and keeps this fast).
 */

export type PriorityLabel = "Today" | "This Week" | "Can Wait";

export interface DigestItem {
  from: string;
  summary: string;
  whyItMatters: string;
  recommendedAction: string;
  priority: PriorityLabel;
  draftReply?: string;
  /** Set when this item wasn't new this cycle — it's still sitting in the inbox from an earlier digest, carried forward until moved/deleted. */
  carriedOver?: boolean;
}

export interface DigestSection {
  name: string; // e.g. "Urgent", "Decisions Required", ...
  items: DigestItem[];
}

export interface UnsubscribeSuggestion {
  from: string;
  deletedCount: number;
  listUnsubscribe?: string;
}

export interface StructuredDigest {
  sections: DigestSection[];
  headline?: string; // short one-liner, e.g. used when nothing important arrived
}

/** Pulls the first usable link out of a raw List-Unsubscribe header value. Prefers a one-click https link over mailto. */
function extractUnsubscribeLink(raw?: string): { url?: string; mailto?: string } {
  if (!raw) return {};
  const matches = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  const url = matches.find((m) => /^https?:/i.test(m));
  const mailto = matches.find((m) => /^mailto:/i.test(m));
  return { url, mailto };
}

const SECTION_COLOURS: Record<string, string> = {
  Urgent: "#d32f2f",
  "Decisions Required": "#e65100",
  "Reply Needed": "#1565c0",
  "Waiting on Others": "#757575",
  FYI: "#2e7d32",
  "Low Priority": "#9e9e9e",
};

const PRIORITY_COLOURS: Record<PriorityLabel, string> = {
  Today: "#d32f2f",
  "This Week": "#e65100",
  "Can Wait": "#757575",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderHtml(digest: StructuredDigest): string {
  const sectionsHtml = digest.sections
    .filter((s) => s.items.length > 0)
    .map((section) => {
      const colour = SECTION_COLOURS[section.name] ?? "#616161";
      const itemsHtml = section.items
        .map((item) => {
          const priorityColour = PRIORITY_COLOURS[item.priority] ?? "#616161";
          const draftBlock = item.draftReply
            ? `<div style="margin-top:10px;padding:10px 12px;background:#f5f5f5;border-radius:4px;font-style:italic;color:#424242;">
                 <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#9e9e9e;font-style:normal;margin-bottom:4px;">Draft reply</div>
                 ${escapeHtml(item.draftReply).replace(/\n/g, "<br>")}
               </div>`
            : "";
          const carriedOverBadge = item.carriedOver
            ? `<span style="font-size:11px;font-weight:600;color:#616161;background:#eeeeee;padding:2px 8px;border-radius:10px;white-space:nowrap;margin-left:6px;">Still outstanding</span>`
            : "";
          return `
            <div style="padding:14px 16px;margin-bottom:10px;background:#ffffff;border-left:3px solid ${colour};border-radius:2px;box-shadow:0 1px 2px rgba(0,0,0,0.06);">
              <div style="display:flex;justify-content:space-between;align-items:baseline;">
                <span style="font-weight:600;color:#212121;font-size:14px;">${escapeHtml(item.from)}</span>
                <span style="white-space:nowrap;">
                  <span style="font-size:11px;font-weight:600;color:#fff;background:${priorityColour};padding:2px 8px;border-radius:10px;white-space:nowrap;margin-left:8px;">${escapeHtml(item.priority)}</span>
                  ${carriedOverBadge}
                </span>
              </div>
              <div style="margin-top:6px;color:#424242;font-size:14px;line-height:1.4;">${escapeHtml(item.summary)}</div>
              <div style="margin-top:8px;font-size:13px;color:#616161;"><strong>Why it matters:</strong> ${escapeHtml(item.whyItMatters)}</div>
              <div style="margin-top:4px;font-size:13px;color:#616161;"><strong>Next action:</strong> ${escapeHtml(item.recommendedAction)}</div>
              ${draftBlock}
            </div>`;
        })
        .join("\n");

      return `
        <div style="margin-bottom:24px;">
          <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:${colour};margin-bottom:8px;">${escapeHtml(section.name)} (${section.items.length})</div>
          ${itemsHtml}
        </div>`;
    })
    .join("\n");

  const headline = digest.headline
    ? `<p style="font-size:14px;color:#616161;margin:0 0 20px 0;">${escapeHtml(digest.headline)}</p>`
    : "";

  return `
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
      <h1 style="font-size:18px;color:#212121;margin:0 0 4px 0;">Inbox digest</h1>
      ${headline}
      ${sectionsHtml || '<p style="color:#616161;font-size:14px;">Nothing new to report.</p>'}
    </div>
  </body>
</html>`;
}

/**
 * Standalone weekly email — deliberately separate from the main
 * digest template (moved out 2026-07-21 per Brendan's request, so the
 * hourly digest stays focused on new/outstanding mail and this runs
 * on its own cadence instead).
 */
export function renderUnsubscribeEmailHtml(suggestions: UnsubscribeSuggestion[]): string {
  const itemsHtml = suggestions
    .map((s) => {
      const { url, mailto } = extractUnsubscribeLink(s.listUnsubscribe);
      const link = url ?? mailto;
      const linkHtml = link
        ? `<a href="${escapeHtml(link)}" style="color:#1565c0;text-decoration:none;font-weight:600;">Unsubscribe →</a>`
        : `<span style="color:#9e9e9e;">no unsubscribe link found — you'll need to do this one manually</span>`;
      return `
        <div style="padding:14px 16px;margin-bottom:10px;background:#ffffff;border-left:3px solid #9e9e9e;border-radius:2px;box-shadow:0 1px 2px rgba(0,0,0,0.06);">
          <div style="font-weight:600;color:#212121;font-size:14px;">${escapeHtml(s.from)}</div>
          <div style="margin-top:6px;font-size:13px;color:#616161;">Deleted ${s.deletedCount}× without opening.</div>
          <div style="margin-top:8px;">${linkHtml}</div>
        </div>`;
    })
    .join("\n");

  return `
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
      <h1 style="font-size:18px;color:#212121;margin:0 0 4px 0;">Unsubscribe suggestions</h1>
      <p style="font-size:14px;color:#616161;margin:0 0 20px 0;">Senders you've repeatedly deleted without opening, accumulated since the last time this ran.</p>
      ${itemsHtml}
    </div>
  </body>
</html>`;
}

export function renderUnsubscribeEmailText(suggestions: UnsubscribeSuggestion[]): string {
  const lines: string[] = ["Senders you've repeatedly deleted without opening:", ""];
  for (const s of suggestions) {
    const { url, mailto } = extractUnsubscribeLink(s.listUnsubscribe);
    const link = url ?? mailto;
    lines.push(`${s.from} — deleted ${s.deletedCount}x without opening.${link ? ` Unsubscribe: ${link}` : " (no unsubscribe link found)"}`);
  }
  return lines.join("\n");
}

export function renderPlainText(digest: StructuredDigest): string {
  const lines: string[] = [];
  if (digest.headline) lines.push(digest.headline, "");

  for (const section of digest.sections) {
    if (section.items.length === 0) continue;
    lines.push(`## ${section.name} (${section.items.length})`, "");
    for (const item of section.items) {
      lines.push(`From: ${item.from}`);
      lines.push(`Priority: ${item.priority}${item.carriedOver ? " (still outstanding — carried over from an earlier digest)" : ""}`);
      lines.push(item.summary);
      lines.push(`Why it matters: ${item.whyItMatters}`);
      lines.push(`Next action: ${item.recommendedAction}`);
      if (item.draftReply) lines.push(`Draft reply: ${item.draftReply}`);
      lines.push("");
    }
  }

  if (lines.length === 0) lines.push("Nothing new to report.");

  return lines.join("\n");
}
