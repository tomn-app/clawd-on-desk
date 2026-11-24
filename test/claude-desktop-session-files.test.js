"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createClaudeDesktopSessionFiles,
  parseSessionRecord,
  computeUnread,
} = require("../src/claude-desktop-session-files");

function rec(over = {}) {
  return { ids: ["x"], isArchived: false, lastFocusedAt: 0, lastTurnEdgeAt: 0, ...over };
}

describe("parseSessionRecord", () => {
  it("reads ids, archive flag and timestamps", () => {
    const r = parseSessionRecord(JSON.stringify({
      cliSessionId: "cur-12345678", priorCliSessionIds: ["old-12345678", 5],
      isArchived: true, lastFocusedAt: 10, lastTurnEdgeAt: "bad",
    }));
    assert.deepStrictEqual(r, {
      ids: ["cur-12345678", "old-12345678"], isArchived: true, lastFocusedAt: 10, lastTurnEdgeAt: 0,
    });
  });

  it("rejects broken or foreign JSON", () => {
    assert.strictEqual(parseSessionRecord("{"), null);
    assert.strictEqual(parseSessionRecord("{}"), null);
    assert.strictEqual(parseSessionRecord("null"), null);
  });
});

describe("computeUnread", () => {
  it("counts a session as viewed until another session takes focus", () => {
    const records = [
      rec({ lastFocusedAt: 100, lastTurnEdgeAt: 150 }), // finished while open, left at 200
      rec({ lastFocusedAt: 200, lastTurnEdgeAt: 500 }), // finished after the user moved on at 300
      rec({ lastFocusedAt: 300, lastTurnEdgeAt: 900 }), // still the most recently focused
      rec({ lastFocusedAt: 50, lastTurnEdgeAt: 0 }), // never ran a turn
    ];
    assert.deepStrictEqual(computeUnread(records), [false, true, false, false]);
  });

  it("never marks archived sessions unread and ignores their focus times", () => {
    const records = [
      rec({ lastFocusedAt: 100, lastTurnEdgeAt: 500 }),
      rec({ isArchived: true, lastFocusedAt: 200, lastTurnEdgeAt: 900 }),
    ];
    assert.deepStrictEqual(computeUnread(records), [false, false]);
  });
});

describe("createClaudeDesktopSessionFiles", () => {
  function setup() {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-ccd-files-"));
    const dir = path.join(appData, "Claude", "claude-code-sessions", "acct", "org");
    fs.mkdirSync(dir, { recursive: true });
    const write = (name, data) => fs.writeFileSync(
      path.join(dir, name),
      typeof data === "string" ? data : JSON.stringify(data),
    );
    let now = 1_000_000;
    const reader = createClaudeDesktopSessionFiles({ env: { APPDATA: appData }, now: () => now });
    return { dir, write, reader, tick: (ms) => { now += ms; } };
  }

  it("maps current and prior cli ids to archived/unread state", async () => {
    const { write, reader } = setup();
    write("local_a.json", { cliSessionId: "aaaaaaaa", priorCliSessionIds: ["oldaaaaa"], lastFocusedAt: 100, lastTurnEdgeAt: 500 });
    write("local_b.json", { cliSessionId: "bbbbbbbb", lastFocusedAt: 300, lastTurnEdgeAt: 350 });
    write("local_c.json", { cliSessionId: "cccccccc", isArchived: true });
    write("local_bad.json", "not json");
    await reader.refresh({ force: true });
    assert.deepStrictEqual(reader.getState("aaaaaaaa"), { archived: false, unread: true });
    assert.deepStrictEqual(reader.getState("oldaaaaa"), { archived: false, unread: true });
    assert.deepStrictEqual(reader.getState("bbbbbbbb"), { archived: false, unread: false });
    assert.deepStrictEqual(reader.getState("cccccccc"), { archived: true, unread: false });
    assert.strictEqual(reader.getState("missing1"), null);
    assert.strictEqual(reader.getState(undefined), null);
  });

  it("throttles refreshes and picks up changed and deleted files", async () => {
    const { dir, write, reader, tick } = setup();
    write("local_a.json", { cliSessionId: "aaaaaaaa", lastFocusedAt: 100, lastTurnEdgeAt: 50 });
    await reader.refresh();
    assert.deepStrictEqual(reader.getState("aaaaaaaa"), { archived: false, unread: false });

    write("local_a.json", { cliSessionId: "aaaaaaaa", isArchived: true, lastFocusedAt: 100, lastTurnEdgeAt: 50, pad: "size-change" });
    await reader.refresh();
    assert.strictEqual(reader.getState("aaaaaaaa").archived, false, "throttled");
    tick(6000);
    await reader.refresh();
    assert.strictEqual(reader.getState("aaaaaaaa").archived, true);

    fs.unlinkSync(path.join(dir, "local_a.json"));
    await reader.refresh({ force: true });
    assert.strictEqual(reader.getState("aaaaaaaa"), null);
  });

  it("returns nothing without APPDATA", async () => {
    const reader = createClaudeDesktopSessionFiles({ env: {} });
    await reader.refresh({ force: true });
    assert.strictEqual(reader.getState("aaaaaaaa"), null);
  });
});
