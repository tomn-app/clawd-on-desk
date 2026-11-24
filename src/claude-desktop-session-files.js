"use strict";

// Read-only view of Claude Desktop's own session files, used to decide when a
// finished Claude Desktop (Code tab) session may leave the HUD:
//   - archived in Claude Desktop      -> drop it now
//   - finished but not yet viewed     -> keep it past the idle timeout
//   - viewed                          -> normal idle timeout
//
// Undocumented Claude Desktop details this relies on, in
// %APPDATA%\Claude\claude-code-sessions\<account>\<org>\local_*.json:
//   cliSessionId / priorCliSessionIds  the ids Claude Code hooks report
//   isArchived                         archived in the sidebar
//   lastTurnEdgeAt                     last turn start/end
//   lastFocusedAt                      last time the session GAINED focus. It
//                                      is not updated when focus leaves, so a
//                                      session counts as viewed until another
//                                      session's lastFocusedAt (or forever if
//                                      it is still the most recently focused).
// If the files are missing or change shape, getState() returns null and the
// caller keeps its old behavior.

const fs = require("fs");
const path = require("path");
const { getClaudeDesktopSessionsRoot, listSessionFiles } = require("./claude-desktop-sidebar-focus");

const REFRESH_MIN_INTERVAL_MS = 5000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function finiteOr0(value) {
  return Number.isFinite(value) ? value : 0;
}

function parseSessionRecord(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || typeof parsed.cliSessionId !== "string") return null;
  const ids = [parsed.cliSessionId];
  if (Array.isArray(parsed.priorCliSessionIds)) {
    for (const id of parsed.priorCliSessionIds) if (typeof id === "string") ids.push(id);
  }
  return {
    ids,
    isArchived: parsed.isArchived === true,
    lastFocusedAt: finiteOr0(parsed.lastFocusedAt),
    lastTurnEdgeAt: finiteOr0(parsed.lastTurnEdgeAt),
  };
}

// Pure: given every parsed record, decide unread per record.
function computeUnread(records) {
  const focusTimes = records
    .filter((r) => !r.isArchived)
    .map((r) => r.lastFocusedAt)
    .sort((a, b) => a - b);
  return records.map((r) => {
    if (r.isArchived || !r.lastTurnEdgeAt) return false;
    // Viewed from lastFocusedAt until the next session took focus.
    const next = focusTimes.find((t) => t > r.lastFocusedAt);
    if (next === undefined) return false; // still the most recently focused one
    return r.lastTurnEdgeAt > next;
  });
}

function createClaudeDesktopSessionFiles(options = {}) {
  const fsp = options.fsPromises || fs.promises;
  const env = options.env || process.env;
  const nowFn = typeof options.now === "function" ? options.now : Date.now;
  const fileCache = new Map(); // file -> { mtimeMs, size, record }
  let byId = new Map(); // cli session id -> { archived, unread }
  let lastRefreshAt = 0;
  let inFlight = null;

  async function doRefresh() {
    const root = getClaudeDesktopSessionsRoot(env);
    if (!root) { byId = new Map(); return; }
    const files = await listSessionFiles(root, fsp);
    const seen = new Set();
    for (const file of files) {
      seen.add(file);
      let stat;
      try { stat = await fsp.stat(file); } catch { continue; }
      const cached = fileCache.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
      if (stat.size > MAX_FILE_BYTES) { fileCache.delete(file); continue; }
      let text;
      try { text = await fsp.readFile(file, "utf8"); } catch { continue; }
      const record = parseSessionRecord(text);
      if (record) fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, record });
      // A half-written file keeps its previous record until the next change.
    }
    for (const file of [...fileCache.keys()]) if (!seen.has(file)) fileCache.delete(file);

    const records = [...fileCache.values()].map((c) => c.record);
    const unread = computeUnread(records);
    const next = new Map();
    records.forEach((r, i) => {
      const state = { archived: r.isArchived, unread: unread[i] };
      // The current cliSessionId wins over another file's prior id.
      next.set(r.ids[0], state);
      for (const id of r.ids.slice(1)) if (!next.has(id)) next.set(id, state);
    });
    byId = next;
  }

  function refresh({ force = false } = {}) {
    if (inFlight) return inFlight;
    const now = nowFn();
    if (!force && now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return Promise.resolve();
    lastRefreshAt = now;
    inFlight = doRefresh().catch(() => {}).finally(() => { inFlight = null; });
    return inFlight;
  }

  // Synchronous, from the last refresh. null = unknown (keep old behavior).
  function getState(rawSessionId) {
    if (typeof rawSessionId !== "string" || !rawSessionId) return null;
    return byId.get(rawSessionId) || null;
  }

  return { refresh, getState };
}

module.exports = {
  createClaudeDesktopSessionFiles,
  parseSessionRecord,
  computeUnread,
};
