import { describe, expect, it } from "vitest";
import { parseIrcLine, parseTags } from "./twitch";

describe("twitch IRC parsing", () => {
  it("reads tmi-sent-ts as platformTs and the user-id tag as the stable id", () => {
    const line =
      "@badge-info=;color=#FF0000;display-name=Sam\\sR;id=b34ccfc7-4977-403a-8a94-33c6bac34fb8;tmi-sent-ts=1759680000123;user-id=1337 :samr!samr@samr.tmi.twitch.tv PRIVMSG #shop :sold 12 M";
    const c = parseIrcLine(line, 1759680000400)!;
    expect(c).toMatchObject({
      id: "tw-b34ccfc7-4977-403a-8a94-33c6bac34fb8",
      platform: "twitch",
      userId: "1337",
      displayName: "Sam R",
      text: "sold 12 M",
      platformTs: 1759680000123,
      receivedTs: 1759680000400,
    });
  });

  it("ignores non-chat lines and unwraps /me actions", () => {
    expect(parseIrcLine(":tmi.twitch.tv 001 justinfan123 :Welcome, GLHF!", 1)).toBeNull();
    expect(parseIrcLine("PING :tmi.twitch.tv", 1)).toBeNull();
    const me = parseIrcLine(":kat!kat@kat.tmi.twitch.tv PRIVMSG #shop :\u0001ACTION wants 7 S\u0001", 5)!;
    expect(me.text).toBe("wants 7 S");
    expect(me.platformTs).toBe(5);
  });

  it("unescapes tag values", () => {
    expect(parseTags("a=x\\sy;b=1\\:2;c")).toEqual({ a: "x y", b: "1;2", c: "" });
  });
});
