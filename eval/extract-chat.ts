/**
 * Turns yt-dlp live_chat replays in a directory (default eval/raw/) into one anonymised pool.jsonl there.
 * User ids and names become salted hashes; @mentions, phone numbers, emails and URLs are masked.
 * Usage: npx tsx eval/extract-chat.ts [dir]   e.g. eval/raw/heldout
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAW = join(fileURLToPath(new URL(".", import.meta.url)), "raw");
const SALT = "claim-eval-2026-10";

interface Run {
  text?: string;
  emoji?: { emojiId?: string; isCustomEmoji?: boolean; shortcuts?: string[] };
}

export interface PoolMessage {
  id: string;
  video: string;
  offsetMs: number;
  user: string;
  role: "viewer" | "owner" | "moderator";
  text: string;
}

const hash = (s: string) => createHash("sha256").update(SALT + s).digest("hex").slice(0, 10);

export function scrub(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>")
    .replace(/@[^\s@]{2,40}/g, "@user")
    .replace(/\+?\d[\d\s-]{8,}\d/g, "<phone>");
}

function runsToText(runs: Run[]): string {
  return runs
    .map((r) => r.text ?? (r.emoji?.isCustomEmoji ? (r.emoji.shortcuts?.[0] ?? "") : (r.emoji?.emojiId ?? "")))
    .join("");
}

function roleOf(badges: unknown[] | undefined): PoolMessage["role"] {
  const icons = (badges ?? []).map((b) => (b as any)?.liveChatAuthorBadgeRenderer?.icon?.iconType);
  if (icons.includes("OWNER")) return "owner";
  if (icons.includes("MODERATOR")) return "moderator";
  return "viewer";
}

function extract(dir: string, file: string): PoolMessage[] {
  const video = file.replace(".live_chat.json", "");
  const out: PoolMessage[] = [];
  for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const replay = row.replayChatItemAction;
    for (const action of replay?.actions ?? []) {
      const r = action?.addChatItemAction?.item?.liveChatTextMessageRenderer;
      if (!r) continue;
      const text = scrub(runsToText(r.message?.runs ?? [])).trim();
      if (!text) continue;
      out.push({
        id: `${video}-${hash(r.id ?? text).slice(0, 8)}`,
        video,
        offsetMs: Number(replay.videoOffsetTimeMsec ?? 0),
        user: `u_${hash(r.authorExternalChannelId ?? r.authorName?.simpleText ?? "anon")}`,
        role: roleOf(r.authorBadges),
        text,
      });
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] ? resolve(process.argv[2]) : RAW;
  const files = readdirSync(dir).filter((f) => f.endsWith(".live_chat.json"));
  const pool = files.flatMap((f) => extract(dir, f));
  writeFileSync(join(dir, "pool.jsonl"), pool.map((m) => JSON.stringify(m)).join("\n") + "\n");
  const byVideo = new Map<string, number>();
  for (const m of pool) byVideo.set(m.video, (byVideo.get(m.video) ?? 0) + 1);
  console.log(`pool: ${pool.length} messages from ${files.length} replays`, Object.fromEntries(byVideo));
}
