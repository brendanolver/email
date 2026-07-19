/**
 * Regression test for cleanBodyText, built from real messages seen in
 * the 2026-07-17 live test (Stage 2). Not a scratch file — run this
 * whenever the trimming heuristic changes, since quote/signature
 * formats are too varied to catch with confidence from reading the
 * code alone. Known gap as of this version: short-form contact
 * labels ("p: 03 5338...", "e: matt@...") aren't recognised as
 * signature tokens the way "Mobile:"/"Email:" are, so some signatures
 * using that style survive trimming (see Matt Lakey case below).
 */
import { cleanBodyText } from "./imap.js";

const cases: { label: string; input: string }[] = [
  {
    label: "Matt Lakey (Outlook From:/Sent: chain)",
    input: `Yeah, that’s right – due 28th  July!\n\nThanks mate,\nKind Regards,\n[cid:image001.png@01DD137F.935CA6C0]\nMatthew Lakey | Sharp Accounting\np: 03 5338 7100\ne: matt@sharpac.au\n\nFrom: Brendan Olver <brendan@kohindustries.com>\nSent: Tuesday, July 14, 2026 10:44 AM\nTo: Matt Lakey <matt@sharpac.au>\nSubject: Re: Luca Geue\n\nThanks mate & I assume they are due 28th July?`,
  },
  {
    label: "jacky (Chinese 发件人 chain)",
    input: `No problem Brendan, Yoyo will send to you soon\n\nThanks and regards \n\nJacky\n\n阿里邮箱------------------------------------------------------------------\n发件人：Brendan Olver<brendan@kohindustries.com>\n日　期：2026年07月16日 16:23:38\n收件人：jacky<jacky@glamourchina.com.cn>\n主　题：Re: Extra stock\n\nHi Jacky,\n\nSorry for the delay in getting back to you...`,
  },
  {
    label: "Sheridan (Apple Mail 'On ... wrote:' chain)",
    input: `Okay no worries, thanks!\n\nKind regards,\n\nEmail: sheridan@kohindustries.com\n115A Ferrars Street,\nSouthbank VIC 3006\n\n> On 16 Jul 2026, at 6:20 pm, Brendan Olver <brendan@kohindustries.com> wrote:\n> \n> Good thinking Shez.`,
  },
  {
    label: "Jake Richardson (no quote chain, has signature)",
    input: `Hi Dennis,\n\nAs previously discussed with Brendan, please see the WeTransfer link below to the tech packs we would like sampled - https://we.tl/t-LTtJbNOeXDmo5cku\t\n\nCould you please produce 1x Size S, 1x Size M and 1x Size L sample of each style.\n\nPlease reply to confirm you've received all files.\n\nCheers,\n\nEmail: jake@kohindustries.com\nUnit 5, 6 Builders Close,\nWendouree VIC 3355`,
  },
  {
    label: "PayPal (no quote chain, no chatty signature)",
    input: `KOH INDUSTRIES PTY LTD, WE'RE REVIEWING THE PAYMENT.\n\nSharra Leask has authorised a payment to you of $195.94 AUD.\n\nTransaction ID 7CM99621E0788413C\n\nSubtotal $182.94 AUD Postage and handling $13.00 AUD Total $195.94 AUD`,
  },
];

for (const c of cases) {
  console.log(`=== ${c.label} ===`);
  console.log(JSON.stringify(cleanBodyText(c.input)));
  console.log();
}
