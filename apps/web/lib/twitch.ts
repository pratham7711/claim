import type { ChatComment } from "@claim/core";

export const TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv:443";

function unescapeTag(v: string): string {
  return v.replace(/\\(.)/g, (_, c: string) => ({ s: " ", ":": ";", "\\": "\\", r: "\r", n: "\n" })[c] ?? c);
}

export function parseTags(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) out[part] = "";
    else out[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1));
  }
  return out;
}

/**
 * One IRC line -> ChatComment, or null when it is not a chat message.
 * `tmi-sent-ts` is Twitch's own post time, so it becomes platformTs; the user-id tag is the stable id.
 */
export function parseIrcLine(line: string, receivedTs: number): ChatComment | null {
  let rest = line.trim();
  if (!rest) return null;
  let tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    tags = parseTags(rest.slice(1, sp));
    rest = rest.slice(sp + 1);
  }
  const m = /^:([^!\s]+)(?:![^\s]+)?\s+PRIVMSG\s+#(\S+)\s+:(.*)$/.exec(rest);
  if (!m) return null;
  const login = m[1]!;
  const text = m[3]!.replace(/^\u0001ACTION (.*)\u0001$/, "$1");
  const sent = Number(tags["tmi-sent-ts"]);
  return {
    id: `tw-${tags.id || `${login}-${receivedTs}`}`,
    platform: "twitch",
    userId: tags["user-id"] || login,
    displayName: tags["display-name"] || login,
    text,
    platformTs: Number.isFinite(sent) && sent > 0 ? sent : receivedTs,
    receivedTs,
  };
}

export interface TwitchConnection {
  close(): void;
}

export interface TwitchHandlers {
  onComment(c: ChatComment): void;
  onState(state: "connecting" | "live" | "error" | "off", error?: string): void;
}

/** Anonymous, read-only chat reader: `justinfan<n>` needs no account and cannot post. */
export function connectTwitch(channel: string, handlers: TwitchHandlers, Ws: typeof WebSocket = WebSocket): TwitchConnection {
  const chan = channel.replace(/^#/, "").trim().toLowerCase();
  const nick = `justinfan${Math.floor(10_000 + Math.random() * 89_999)}`;
  let closed = false;
  const ws = new Ws(TWITCH_IRC_URL);
  handlers.onState("connecting");

  ws.addEventListener("open", () => {
    ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    ws.send("PASS SCHMOOPIIE");
    ws.send(`NICK ${nick}`);
    ws.send(`JOIN #${chan}`);
  });
  ws.addEventListener("message", (ev: MessageEvent) => {
    const now = Date.now();
    for (const line of String(ev.data).split("\r\n")) {
      if (!line) continue;
      if (line.startsWith("PING")) {
        ws.send(line.replace("PING", "PONG"));
        continue;
      }
      if (/ JOIN #/.test(line) && line.includes(nick)) handlers.onState("live");
      if (/ NOTICE \* :Login/.test(line)) handlers.onState("error", "Twitch refused the anonymous login");
      const c = parseIrcLine(line, now);
      if (c) handlers.onComment(c);
    }
  });
  ws.addEventListener("error", () => {
    if (!closed) handlers.onState("error", "WebSocket error talking to Twitch");
  });
  ws.addEventListener("close", () => {
    if (!closed) handlers.onState("error", "Twitch closed the connection");
  });

  return {
    close() {
      closed = true;
      try {
        ws.close();
      } catch {
        // already closed
      }
      handlers.onState("off");
    },
  };
}
