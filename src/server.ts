/**
 * Stage 2: MCP server exposing a small set of tools over Streamable
 * HTTP. Originally read-only by design (get_emails_since only). As of
 * 2026-07-21, after Brendan explicitly approved write access, two
 * tools here (add_domain_rule / remove_domain_rule) configure
 * deterministic mailbox actions that digest.ts and imap-write.ts
 * actually perform — this file itself still never touches a mailbox
 * directly, it only reads/writes the rule config those other modules
 * consume.
 *
 * Auth: static bearer token (MCP_BEARER_TOKEN) checked with a
 * constant-time comparison. This is a deliberate simplification vs
 * the OAuth 2.1 the current MCP spec recommends for remote servers —
 * disproportionate for a single-user personal connector. See
 * architecture doc §3 for the tradeoff.
 */

import "dotenv/config";
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import * as z from "zod/v4";
import { fetchAllAccountsSince, MAX_LOOKBACK_DAYS } from "./imap.js";
import { addRule, readRules, addDomainRule, removeDomainRule, readDomainRules } from "./store.js";
import { runDigestAndDeliver, runUnsubscribeDigestAndDeliver } from "./digest.js";
import { startScheduler } from "./scheduler.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  // Buffers must be equal length for timingSafeEqual — pad/compare
  // lengths first without leaking timing on the token itself.
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function bearerAuthMiddleware(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Primary path: Authorization: Bearer <token> header.
    const header = req.header("authorization") ?? "";
    const [scheme, headerToken] = header.split(" ");
    const viaHeader = scheme === "Bearer" && !!headerToken && timingSafeEqualStrings(headerToken, expectedToken);

    // Fallback path: ?token=<token> query param. Added because some MCP
    // clients (e.g. Claude Cowork's custom-connector UI, as of the
    // request-headers beta not being available on this account) only
    // let you configure a server URL, not custom headers. Known
    // tradeoff: a token in a URL is more likely to end up in logs or
    // proxies than one in a header. Accepted for this personal-use
    // connector rather than standing up full OAuth 2.1.
    const queryToken = typeof req.query.token === "string" ? req.query.token : "";
    const viaQuery = !!queryToken && timingSafeEqualStrings(queryToken, expectedToken);

    if (!viaHeader && !viaQuery) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }
    next();
  };
}

function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "imap-readonly-connector",
    version: "0.1.0",
  });

  server.registerTool(
    "get_emails_since",
    {
      title: "Get emails since",
      description:
        `Read-only fetch of emails received since the given ISO 8601 timestamp, ` +
        `across both connected mailboxes (iCloud + VentraIP). Deduplicated by ` +
        `Message-ID. Never marks messages read, moves, deletes, or sends anything ` +
        `— this tool has no side effects on the mailboxes. Capped at ${MAX_LOOKBACK_DAYS} ` +
        `days of lookback regardless of the timestamp supplied.`,
      inputSchema: {
        since: z
          .string()
          .describe("ISO 8601 timestamp — fetch emails received at or after this instant"),
      },
    },
    async ({ since }) => {
      let sinceDate: Date;
      try {
        sinceDate = new Date(since);
        if (Number.isNaN(sinceDate.getTime())) throw new Error("invalid date");
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid "since" timestamp: ${since}` }],
        };
      }

      const emails = await fetchAllAccountsSince(sinceDate);
      return {
        content: [{ type: "text", text: JSON.stringify(emails, null, 2) }],
      };
    }
  );

  server.registerTool(
    "add_preference_rule",
    {
      title: "Add email preference rule",
      description:
        `Persists an explicit rule (e.g. "always deprioritise invoices from X") that the ` +
        `automated digest will apply on every future run. Purely additive — only appends ` +
        `to a local rules file, no effect on any mailbox. To remove or change a rule, a ` +
        `person needs to edit the rules file directly for now.`,
      inputSchema: {
        rule: z.string().describe("Plain-English rule, e.g. 'always mark newsletters from X as Low Priority'"),
      },
    },
    async ({ rule }) => {
      const allRules = await addRule(rule);
      return {
        content: [{ type: "text", text: `Rule added. Current rules (${allRules.length}):\n${allRules.map((r) => `- ${r}`).join("\n")}` }],
      };
    }
  );

  server.registerTool(
    "list_preference_rules",
    {
      title: "List email preference rules",
      description: "Lists the explicit preference rules currently applied to the automated digest.",
      inputSchema: {},
    },
    async () => {
      const allRules = await readRules();
      return {
        content: [
          {
            type: "text",
            text: allRules.length === 0 ? "No preference rules set yet." : allRules.map((r) => `- ${r}`).join("\n"),
          },
        ],
      };
    }
  );

  server.registerTool(
    "add_domain_rule",
    {
      title: "Add a domain-based mailbox rule",
      description:
        `Adds a deterministic, code-enforced rule applied to every new email from a given domain, every digest cycle: ` +
        `"auto-mark-read" marks matching mail \\Seen but still includes it in the digest normally; ` +
        `"auto-delete" deletes matching mail from the mailbox immediately and excludes it from the digest entirely, ` +
        `before Claude ever sees it; "exclude" is non-destructive — filters matching mail out of the digest same as ` +
        `auto-delete, but performs no mailbox write at all, the email is left completely untouched (not deleted, not ` +
        `marked read). This is separate from add_preference_rule (which only ever affects how Claude categorises ` +
        `mail) — these are hard, code-matched-by-exact-domain rules, never LLM interpretation. Does NOT cover ` +
        `unsubscribing — that always stays a suggestion Brendan actions himself. Re-adding a domain replaces its ` +
        `existing rule.`,
      inputSchema: {
        domain: z.string().describe("Domain to match, e.g. 'newsletter-domain.com' (a leading @ is fine too)"),
        action: z
          .enum(["auto-mark-read", "auto-delete", "exclude"])
          .describe("What to do with every new email from this domain, every cycle"),
      },
    },
    async ({ domain, action }) => {
      const rules = await addDomainRule(domain, action);
      return {
        content: [
          {
            type: "text",
            text: `Domain rule added: ${domain} → ${action}. Current domain rules (${rules.length}):\n${rules
              .map((r) => `- ${r.domain} → ${r.action}`)
              .join("\n")}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "remove_domain_rule",
    {
      title: "Remove a domain-based mailbox rule",
      description: "Removes a previously-added domain rule, so that domain's mail goes back through normal categorisation with no mailbox-level action applied.",
      inputSchema: {
        domain: z.string().describe("Domain to remove, e.g. 'newsletter-domain.com'"),
      },
    },
    async ({ domain }) => {
      const rules = await removeDomainRule(domain);
      return {
        content: [
          {
            type: "text",
            text: `Domain rule removed for ${domain}. Remaining (${rules.length}):\n${
              rules.length ? rules.map((r) => `- ${r.domain} → ${r.action}`).join("\n") : "none"
            }`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_domain_rules",
    {
      title: "List domain-based mailbox rules",
      description:
        "Lists the deterministic domain rules currently applied (auto-mark-read / auto-delete). Separate from list_preference_rules, which lists the free-text rules used for categorisation only.",
      inputSchema: {},
    },
    async () => {
      const rules = await readDomainRules();
      return {
        content: [
          {
            type: "text",
            text: rules.length === 0 ? "No domain rules set yet." : rules.map((r) => `- ${r.domain} → ${r.action}`).join("\n"),
          },
        ],
      };
    }
  );

  server.registerTool(
    "run_digest_now",
    {
      title: "Run the digest immediately",
      description:
        `Manually triggers one digest run outside the normal schedule (fetch since last checkpoint, ` +
        `categorise, ACTUALLY attempt delivery by email/Slack, advance the checkpoint on success). ` +
        `Reports real delivery status per channel — use this to genuinely verify delivery, not just categorisation.`,
      inputSchema: {},
    },
    async () => {
      try {
        const { digest, deliveries } = await runDigestAndDeliver();
        const deliveryLines = deliveries
          .map((d) => {
            if (d.skipped) return `- ${d.channel}: skipped (not configured)`;
            if (d.ok) return `- ${d.channel}: sent successfully`;
            return `- ${d.channel}: FAILED — ${d.error}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text:
                `Digest run complete. ${digest.emailCount} email(s) since ${digest.since.toISOString()}.\n\n` +
                `Delivery status:\n${deliveryLines}\n\n${digest.text}`,
            },
          ],
        };
      } catch (err) {
        // Belt-and-braces: return a clean tool error instead of letting
        // a rejection here become an unhandled one. The MCP SDK likely
        // already handles this, but a production crash-loop is reason
        // enough not to rely on "likely".
        console.error("[run_digest_now] failed:", err);
        return {
          isError: true,
          content: [{ type: "text", text: `Digest run failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    }
  );

  server.registerTool(
    "run_unsubscribe_digest_now",
    {
      title: "Send the weekly unsubscribe-suggestions email immediately",
      description:
        `Manually triggers the weekly unsubscribe-suggestions email outside its normal Monday schedule — drains ` +
        `whatever's accumulated since the last send. Reports whether anything was actually sent (skips silently ` +
        `if nothing has crossed the deletion threshold yet). Useful for testing without waiting a week.`,
      inputSchema: {},
    },
    async () => {
      try {
        const result = await runUnsubscribeDigestAndDeliver();
        if (result.error) {
          return { isError: true, content: [{ type: "text", text: `Send failed: ${result.error}` }] };
        }
        return {
          content: [
            {
              type: "text",
              text: result.sent
                ? `Sent — ${result.count} sender(s) suggested for unsubscribing.`
                : "Nothing to send — no senders have crossed the deletion threshold since the last send.",
            },
          ],
        };
      } catch (err) {
        console.error("[run_unsubscribe_digest_now] failed:", err);
        return {
          isError: true,
          content: [{ type: "text", text: `Run failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    }
  );

  return server;
}

const app = createMcpExpressApp({
  host: process.env.HOST ?? "0.0.0.0",
  allowedHosts: process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()),
});

const bearerToken = requireEnv("MCP_BEARER_TOKEN");
const auth = bearerAuthMiddleware(bearerToken);

// Unauthenticated health check only — Railway/uptime checks hit this,
// nothing IMAP-related is reachable without the bearer token.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/mcp", auth, async (req, res) => {
  const server = buildMcpServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session tracking needed for a single tool
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", auth, (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    })
  );
});

app.delete("/mcp", auth, (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    })
  );
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`IMAP read-only MCP server listening on port ${PORT}`);
  // Starts the independent digest scheduler in the same process — this
  // runs on Railway's clock regardless of whether the Claude app is
  // open, which is the whole point of moving it here from Cowork.
  startScheduler();
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
