/**
 * Stage 2: MCP server exposing a single read-only tool,
 * get_emails_since, over Streamable HTTP. Deliberately minimal —
 * there is no send/delete/move/mark-read tool anywhere in this file,
 * by omission, not by a permission flag that could be misconfigured.
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
import { addRule, readRules } from "./store.js";
import { runDigestAndDeliver } from "./digest.js";
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
