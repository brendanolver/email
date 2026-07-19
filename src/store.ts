/**
 * Persistent state for the digest pipeline: the checkpoint (last
 * successful fetch time) and Brendan's explicit preference rules.
 *
 * Lives on a Railway Volume mounted at DATA_DIR so it survives
 * redeploys/restarts — Railway container filesystems are otherwise
 * ephemeral. Falls back to a local .data folder for local dev/testing
 * (gitignored), which is NOT persistent across Railway deploys, so
 * DATA_DIR must be set to the volume mount path in production.
 */

import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), ".data");
const CHECKPOINT_FILE = path.join(DATA_DIR, "checkpoint.txt");
const RULES_FILE = path.join(DATA_DIR, "rules.json");

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readCheckpoint(): Promise<Date> {
  try {
    const raw = (await fs.readFile(CHECKPOINT_FILE, "utf-8")).trim();
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  } catch {
    // fall through to default below — no checkpoint yet (first run)
  }
  return new Date(Date.now() - 3 * 60 * 60 * 1000); // default: 3 hours ago
}

export async function writeCheckpoint(when: Date): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(CHECKPOINT_FILE, when.toISOString(), "utf-8");
}

export async function readRules(): Promise<string[]> {
  try {
    const raw = await fs.readFile(RULES_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((r) => typeof r === "string");
  } catch {
    // no rules file yet
  }
  return [];
}

export async function addRule(rule: string): Promise<string[]> {
  await ensureDataDir();
  const rules = await readRules();
  rules.push(rule);
  await fs.writeFile(RULES_FILE, JSON.stringify(rules, null, 2), "utf-8");
  return rules;
}
