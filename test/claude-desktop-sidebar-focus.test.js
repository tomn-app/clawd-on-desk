"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createClaudeDesktopSidebarFocus,
  shouldSelectClaudeDesktopSession,
  getClaudeDesktopSessionsRoot,
  readTitleIfMatches,
  SIDEBAR_SELECT_SCRIPT,
} = require("../src/claude-desktop-sidebar-focus");

const CLI_ID = "b85c68bd-04d4-4300-a815-3f70dbf15077";

function desktopSession(overrides = {}) {
  return {
    agentId: "claude-code",
    claudeEntrypoint: "claude-desktop",
    rawSessionId: CLI_ID,
    ...overrides,
  };
}

function makeAppData(files) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-ccd-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(appData, "Claude", "claude-code-sessions", rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content));
  }
  return appData;
}

function makeExecFile(stdout, error = null) {
  const fn = (bin, args, options, done) => {
    fn.calls.push({ bin, args, options });
    setImmediate(() => done(error, stdout));
  };
  fn.calls = [];
  return fn;
}

describe("shouldSelectClaudeDesktopSession", () => {
  it("accepts a local Windows Claude Desktop session", () => {
    assert.strictEqual(shouldSelectClaudeDesktopSession(desktopSession(), "win32"), true);
  });

  it("rejects other platforms, launchers, agents and remote sessions", () => {
    assert.strictEqual(shouldSelectClaudeDesktopSession(desktopSession(), "darwin"), false);
    assert.strictEqual(shouldSelectClaudeDesktopSession(desktopSession({ claudeEntrypoint: "cli" }), "win32"), false);
    assert.strictEqual(shouldSelectClaudeDesktopSession(desktopSession({ agentId: "codex" }), "win32"), false);
    assert.strictEqual(shouldSelectClaudeDesktopSession(desktopSession({ host: "devbox" }), "win32"), false);
    assert.strictEqual(shouldSelectClaudeDesktopSession(desktopSession({ wslDistro: "Ubuntu" }), "win32"), false);
    assert.strictEqual(shouldSelectClaudeDesktopSession(desktopSession({ rawSessionId: "x" }), "win32"), false);
    assert.strictEqual(shouldSelectClaudeDesktopSession(desktopSession({ rawSessionId: "a b/../c" }), "win32"), false);
    assert.strictEqual(shouldSelectClaudeDesktopSession(null, "win32"), false);
  });
});

describe("readTitleIfMatches", () => {
  it("returns the title only for the exact cliSessionId", () => {
    const text = JSON.stringify({ sessionId: "local_1", cliSessionId: CLI_ID, title: "  My session " });
    assert.strictEqual(readTitleIfMatches(text, CLI_ID), "My session");
    assert.strictEqual(readTitleIfMatches(text, "b85c68bd-0000-0000-0000-000000000000"), null);
  });

  it("ignores an id that only appears elsewhere in the file", () => {
    const text = JSON.stringify({ cliSessionId: "other-session-id", title: "Parent", note: CLI_ID });
    assert.strictEqual(readTitleIfMatches(text, CLI_ID), null);
  });

  it("rejects malformed JSON and unusable titles", () => {
    assert.strictEqual(readTitleIfMatches(`{"cliSessionId":"${CLI_ID}"`, CLI_ID), null);
    assert.strictEqual(readTitleIfMatches(JSON.stringify({ cliSessionId: CLI_ID, title: "" }), CLI_ID), null);
    assert.strictEqual(readTitleIfMatches(JSON.stringify({ cliSessionId: CLI_ID, title: "a\nb" }), CLI_ID), null);
    assert.strictEqual(readTitleIfMatches(JSON.stringify({ cliSessionId: CLI_ID, title: 42 }), CLI_ID), null);
  });
});

describe("getClaudeDesktopSessionsRoot", () => {
  it("resolves under APPDATA and is null without it", () => {
    assert.strictEqual(
      getClaudeDesktopSessionsRoot({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }),
      path.join("C:\\Users\\u\\AppData\\Roaming", "Claude", "claude-code-sessions"),
    );
    assert.strictEqual(getClaudeDesktopSessionsRoot({}), null);
  });
});

describe("findSessionTitle", () => {
  it("finds the title in the account/org nested session files", async () => {
    const appData = makeAppData({
      "acct/org/local_aaa.json": { cliSessionId: "11111111-other", title: "Other" },
      "acct/org/local_bbb.json": { cliSessionId: CLI_ID, title: "Claude Desktop session focus" },
      "acct/org/notes.txt": CLI_ID,
    });
    const focus = createClaudeDesktopSidebarFocus({ env: { APPDATA: appData } });
    assert.strictEqual(await focus.findSessionTitle(CLI_ID), "Claude Desktop session focus");
  });

  it("re-reads the cached file so a renamed session uses its new title", async () => {
    const appData = makeAppData({ "a/b/local_x.json": { cliSessionId: CLI_ID, title: "Before" } });
    const focus = createClaudeDesktopSidebarFocus({ env: { APPDATA: appData } });
    assert.strictEqual(await focus.findSessionTitle(CLI_ID), "Before");
    fs.writeFileSync(
      path.join(appData, "Claude", "claude-code-sessions", "a", "b", "local_x.json"),
      JSON.stringify({ cliSessionId: CLI_ID, title: "After" }),
    );
    assert.strictEqual(await focus.findSessionTitle(CLI_ID), "After");
  });

  it("returns null when the folder or the session is missing", async () => {
    const missing = createClaudeDesktopSidebarFocus({ env: { APPDATA: path.join(os.tmpdir(), "clawd-ccd-none") } });
    assert.strictEqual(await missing.findSessionTitle(CLI_ID), null);
    const appData = makeAppData({ "a/b/local_x.json": { cliSessionId: "22222222-other", title: "Other" } });
    const focus = createClaudeDesktopSidebarFocus({ env: { APPDATA: appData } });
    assert.strictEqual(await focus.findSessionTitle(CLI_ID), null);
    assert.strictEqual(await focus.findSessionTitle("../../etc"), null);
  });
});

describe("selectSession", () => {
  it("passes the title through the environment, never the script text", async () => {
    const appData = makeAppData({ "a/b/local_x.json": { cliSessionId: CLI_ID, title: "Fix '$(rm)' & stuff" } });
    const execFile = makeExecFile("selected\r\n");
    const logs = [];
    const focus = createClaudeDesktopSidebarFocus({
      env: { APPDATA: appData },
      execFile,
      focusLog: (line) => logs.push(line),
    });
    assert.strictEqual(await focus.selectSession(desktopSession(), "sid1"), "selected");
    assert.strictEqual(execFile.calls.length, 1);
    const { bin, args, options } = execFile.calls[0];
    assert.strictEqual(bin, "powershell.exe");
    assert.ok(args.includes("-EncodedCommand"));
    assert.strictEqual(options.env.CLAWD_CCD_TITLE, "Fix '$(rm)' & stuff");
    const decoded = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
    assert.strictEqual(decoded, SIDEBAR_SELECT_SCRIPT);
    assert.ok(!decoded.includes("$(rm)"));
    assert.deepStrictEqual(logs, ["focus result branch=claude-desktop-sidebar reason=selected sid=sid1"]);
  });

  it("does not run the script when no title is found", async () => {
    const execFile = makeExecFile("selected");
    const focus = createClaudeDesktopSidebarFocus({ env: {}, execFile });
    assert.strictEqual(await focus.selectSession(desktopSession()), "title-not-found");
    assert.strictEqual(execFile.calls.length, 0);
  });

  it("maps script output to a known reason", async () => {
    const appData = makeAppData({ "a/b/local_x.json": { cliSessionId: CLI_ID, title: "T" } });
    const cases = [
      ["ambiguous\n", null, "ambiguous"],
      ["not-found", null, "not-found"],
      ["script-failed", null, "script-failed"],
      ["garbage", null, "unknown"],
      ["", new Error("timeout"), "script-failed"],
    ];
    for (const [stdout, error, expected] of cases) {
      const focus = createClaudeDesktopSidebarFocus({ env: { APPDATA: appData }, execFile: makeExecFile(stdout, error) });
      assert.strictEqual(await focus.selectSession(desktopSession()), expected);
    }
  });
});

describe("SIDEBAR_SELECT_SCRIPT", () => {
  it("anchors on the exact 'More options for <title>' sibling and refuses duplicates", () => {
    assert.ok(SIDEBAR_SELECT_SCRIPT.includes("'More options for ' + $title"));
    assert.ok(SIDEBAR_SELECT_SCRIPT.includes("GetPreviousSibling"));
    assert.ok(SIDEBAR_SELECT_SCRIPT.includes("'ambiguous'"));
  });

  it("skips the open session's header button and keeps only real sidebar rows", () => {
    assert.ok(SIDEBAR_SELECT_SCRIPT.includes("foreach ($h in $hits)"));
    assert.ok(SIDEBAR_SELECT_SCRIPT.includes("[System.StringComparison]::Ordinal"));
    assert.ok(SIDEBAR_SELECT_SCRIPT.includes("if ($rows.Count -gt 1) { 'ambiguous'; exit 0 }"));
  });
});
