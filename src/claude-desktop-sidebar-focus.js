"use strict";

// Claude Desktop (Code tab) has no link that opens an existing session, so the
// window focus walk can only raise the Claude window. This module goes one step
// further on Windows: it finds the session's title in Claude Desktop's own
// session files, then uses UI Automation to invoke that session's sidebar row.
//
// Both halves lean on undocumented Claude Desktop details:
//   - %APPDATA%\Claude\claude-code-sessions\<account>\<org>\local_*.json holds
//     `cliSessionId` (the id Claude Code hooks report) next to `title`.
//   - Each sidebar row is a Button immediately followed by a sibling Button
//     named "More options for <exact title>". The row's own name carries extra
//     status text ("Running", "Unread response", ...), so the sibling is the
//     only exact handle on the title.
// Any miss (file not found, row not rendered, duplicate title, UI change) ends
// quietly: the window focus that already ran stays the user-visible result.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const RAW_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const SESSION_FILE_RE = /^local_[A-Za-z0-9_-]+\.json$/;
const TITLE_MAX = 500;
const PS_TIMEOUT_MS = 8000;

function shouldSelectClaudeDesktopSession(session, platform = process.platform) {
  return platform === "win32"
    && !!session
    && session.agentId === "claude-code"
    && session.claudeEntrypoint === "claude-desktop"
    && !session.host
    && !session.wslDistro
    && typeof session.rawSessionId === "string"
    && RAW_SESSION_ID_RE.test(session.rawSessionId);
}

function getClaudeDesktopSessionsRoot(env = process.env) {
  const appData = env && typeof env.APPDATA === "string" ? env.APPDATA : "";
  return appData ? path.join(appData, "Claude", "claude-code-sessions") : null;
}

function readTitleIfMatches(text, rawSessionId) {
  // Cheap substring gate before parsing: these files can be large.
  if (typeof text !== "string" || !text.includes(rawSessionId)) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || parsed.cliSessionId !== rawSessionId) return null;
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  if (!title || title.length > TITLE_MAX || /[\0\r\n]/.test(title)) return null;
  return title;
}

async function listSessionFiles(root, fsp) {
  const files = [];
  let level1;
  try { level1 = await fsp.readdir(root, { withFileTypes: true }); } catch { return files; }
  for (const a of level1) {
    if (!a.isDirectory()) continue;
    let level2;
    try { level2 = await fsp.readdir(path.join(root, a.name), { withFileTypes: true }); } catch { continue; }
    for (const b of level2) {
      if (!b.isDirectory()) continue;
      const dir = path.join(root, a.name, b.name);
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && SESSION_FILE_RE.test(e.name)) files.push(path.join(dir, e.name));
      }
    }
  }
  return files;
}

function createClaudeDesktopSidebarFocus(options = {}) {
  const fsp = options.fsPromises || fs.promises;
  const env = options.env || process.env;
  const execFileImpl = options.execFile || execFile;
  const log = typeof options.focusLog === "function" ? options.focusLog : () => {};
  // rawSessionId -> file path. Titles change (renames), so the file is re-read
  // on every click; only the directory scan is cached.
  const fileCache = new Map();

  async function findSessionTitle(rawSessionId) {
    if (typeof rawSessionId !== "string" || !RAW_SESSION_ID_RE.test(rawSessionId)) return null;
    const cached = fileCache.get(rawSessionId);
    if (cached) {
      try {
        const title = readTitleIfMatches(await fsp.readFile(cached, "utf8"), rawSessionId);
        if (title) return title;
      } catch {}
      fileCache.delete(rawSessionId);
    }
    const root = getClaudeDesktopSessionsRoot(env);
    if (!root) return null;
    const files = await listSessionFiles(root, fsp);
    for (const file of files) {
      let text;
      try { text = await fsp.readFile(file, "utf8"); } catch { continue; }
      const title = readTitleIfMatches(text, rawSessionId);
      if (title) {
        fileCache.set(rawSessionId, file);
        return title;
      }
    }
    return null;
  }

  function invokeSidebarRow(title) {
    return new Promise((resolve) => {
      const encoded = Buffer.from(SIDEBAR_SELECT_SCRIPT, "utf16le").toString("base64");
      execFileImpl(
        "powershell.exe",
        ["-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        {
          encoding: "utf8",
          timeout: PS_TIMEOUT_MS,
          windowsHide: true,
          // The title travels in the environment, never in the script text.
          env: { ...env, CLAWD_CCD_TITLE: title },
        },
        (err, stdout) => {
          const line = String(stdout || "").trim().split(/\r?\n/).pop() || "";
          if (/^(selected|not-found|ambiguous|no-row|no-window|script-failed)$/.test(line)) return resolve(line);
          resolve(err ? "script-failed" : "unknown");
        },
      );
    });
  }

  async function selectSession(session, sid = "") {
    const sidLog = sid ? ` sid=${sid}` : "";
    let title;
    try { title = await findSessionTitle(session && session.rawSessionId); } catch { title = null; }
    if (!title) {
      log(`focus result branch=claude-desktop-sidebar reason=title-not-found${sidLog}`);
      return "title-not-found";
    }
    const reason = await invokeSidebarRow(title);
    log(`focus result branch=claude-desktop-sidebar reason=${reason}${sidLog}`);
    return reason;
  }

  return { findSessionTitle, selectSession, invokeSidebarRow };
}

// Windows PowerShell 5.1 (always present) with .NET UI Automation. Prints one
// status token on its last line. Chromium builds its accessibility tree lazily
// on the first UIA query, so the lookup retries briefly until the tree is warm.
const SIDEBAR_SELECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $title = $env:CLAWD_CCD_TITLE
  if (-not $title) { 'not-found'; exit 0 }
  $AE = [System.Windows.Automation.AutomationElement]
  $btnType = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $nameCond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, ('More options for ' + $title))
  $cond = New-Object System.Windows.Automation.AndCondition($btnType, $nameCond)
  $roots = @(Get-Process -Name Claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $AE::FromHandle($_.MainWindowHandle) })
  if ($roots.Count -eq 0) { 'no-window'; exit 0 }
  $hits = @()
  for ($i = 0; $i -lt 8; $i++) {
    $hits = @()
    $warm = $false
    foreach ($r in $roots) {
      $found = $r.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
      foreach ($h in $found) { $hits += $h }
      if (-not $warm) { $warm = $r.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnType).Count -gt 30 }
    }
    if ($hits.Count -gt 0 -or $warm) { break }
    Start-Sleep -Milliseconds 300
  }
  if ($hits.Count -eq 0) { 'not-found'; exit 0 }
  # The open session's header has its own "More options for <title>" button.
  # Only a hit right after a row button whose name starts with the title is a
  # sidebar row.
  $rows = @()
  foreach ($h in $hits) {
    $prev = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetPreviousSibling($h)
    if ($prev -and $prev.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $prev.Current.Name.StartsWith($title, [System.StringComparison]::Ordinal)) { $rows += $prev }
  }
  if ($rows.Count -eq 0) { 'no-row'; exit 0 }
  if ($rows.Count -gt 1) { 'ambiguous'; exit 0 }
  $row = $rows[0]
  $row.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  'selected'
} catch {
  'script-failed'
}
`;

module.exports = {
  createClaudeDesktopSidebarFocus,
  shouldSelectClaudeDesktopSession,
  getClaudeDesktopSessionsRoot,
  listSessionFiles,
  readTitleIfMatches,
  SIDEBAR_SELECT_SCRIPT,
};
