/**
 * Delivers the digest by email, reusing the existing iCloud
 * credentials (no new mail credential needed — same app-specific
 * password already used for IMAP also works for SMTP).
 */

import nodemailer from "nodemailer";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/**
 * Sends both an HTML body (styled, sectioned, colour-coded) and a
 * plain-text alternative generated from the same structured data —
 * nodemailer/most clients pick whichever they can render, HTML first.
 *
 * Also sets Importance/X-Priority headers so clients that support a
 * priority indicator (Outlook in particular) show one, and returns
 * the sent Message-ID so the caller can flag/track this exact email
 * via IMAP afterwards.
 */
export async function sendDigestEmail(subject: string, bodyText: string, bodyHtml: string): Promise<{ messageId: string }> {
  const user = requireEnv("ICLOUD_USERNAME");
  const pass = requireEnv("ICLOUD_APP_PASSWORD");
  const to = process.env.DIGEST_EMAIL_TO ?? user; // defaults to sending to yourself

  const transporter = nodemailer.createTransport({
    host: "smtp.mail.me.com",
    port: 587,
    secure: false, // STARTTLS on 587, not implicit TLS
    auth: { user, pass },
  });

  const info = await transporter.sendMail({
    from: user,
    to,
    subject,
    text: bodyText,
    html: bodyHtml,
    headers: {
      Importance: "high",
      "X-Priority": "1",
    },
  });

  return { messageId: info.messageId };
}
