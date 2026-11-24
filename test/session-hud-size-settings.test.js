"use strict";

// Session HUD width / visible-session-count preferences: schema, validators,
// geometry, row cap, renderer wiring and Settings/i18n exposure.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const prefs = require("../src/prefs");
const { updateRegistry } = require("../src/settings-actions");
const size = require("../src/session-hud-size");
const sessionHud = require("../src/session-hud");
const {
  computeSessionHudBounds,
  computeHudLayout,
  computeHudHeight,
  getHudMaxExpandedRows,
  getHudWidth,
  constants,
} = sessionHud.__test;

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

function mkSessions(n) {
  const sessions = [];
  for (let i = 0; i < n; i++) {
    sessions.push({ id: `s${i}`, state: "working", headless: false, updatedAt: Date.now() - i });
  }
  return { sessions, orderedIds: sessions.map((s) => s.id) };
}

describe("session HUD size prefs", () => {
  it("defaults both prefs to Auto (0) so upgrades keep the historical HUD", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.sessionHudWidth, 0);
    assert.strictEqual(d.sessionHudMaxRows, 0);
  });

  it("persists valid values and drops invalid hand edits back to Auto", () => {
    const ok = prefs.validate({ sessionHudWidth: 520, sessionHudMaxRows: 8 });
    assert.strictEqual(ok.sessionHudWidth, 520);
    assert.strictEqual(ok.sessionHudMaxRows, 8);
    for (const bad of [150, 801, 300.5, "400", -1]) {
      assert.strictEqual(prefs.validate({ sessionHudWidth: bad }).sessionHudWidth, 0, String(bad));
    }
    for (const bad of [13, 2.5, "4", -1]) {
      assert.strictEqual(prefs.validate({ sessionHudMaxRows: bad }).sessionHudMaxRows, 0, String(bad));
    }
  });

  it("settings validators accept 0 or the documented ranges only", () => {
    const width = updateRegistry.sessionHudWidth;
    const rows = updateRegistry.sessionHudMaxRows;
    for (const v of [0, size.SESSION_HUD_WIDTH_MIN, 480, size.SESSION_HUD_WIDTH_MAX]) {
      assert.strictEqual(width(v).status, "ok", String(v));
    }
    for (const v of [1, 199, 801, 2.5, NaN, "400", null]) {
      assert.strictEqual(width(v).status, "error", String(v));
    }
    for (const v of [0, 1, 7, size.SESSION_HUD_MAX_ROWS_MAX]) {
      assert.strictEqual(rows(v).status, "ok", String(v));
    }
    for (const v of [-1, 13, 1.5, "3", null]) {
      assert.strictEqual(rows(v).status, "error", String(v));
    }
  });
});

describe("session HUD width setting", () => {
  it("Auto (0) keeps every automatic width unchanged", () => {
    for (const elapsed of [true, false]) {
      for (const labels of [true, false]) {
        for (const usage of [true, false]) {
          for (const tagged of [true, false]) {
            assert.strictEqual(
              getHudWidth(elapsed, labels, usage, tagged, 0),
              getHudWidth(elapsed, labels, usage, tagged)
            );
          }
        }
      }
    }
  });

  it("uses a wider custom width but never goes below the automatic width", () => {
    const auto = getHudWidth(true, true, true, false);
    assert.strictEqual(getHudWidth(true, true, true, false, 600), 600);
    assert.strictEqual(getHudWidth(true, true, true, false, 200), auto);
    // Invalid values are ignored rather than trusted.
    assert.strictEqual(getHudWidth(true, true, true, false, 5000), auto);
  });

  it("resizes the real window bounds and keeps a wide HUD inside the work area", () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    const hitRect = { left: 1800, top: 400, right: 1900, bottom: 500 };
    const wide = computeSessionHudBounds({ hitRect, workArea, width: 700, height: computeHudHeight(1) });
    assert.strictEqual(wide.contentBounds.width, 700);
    assert.strictEqual(
      wide.bounds.width,
      700 + constants.HUD_WINDOW_SHELL.left + constants.HUD_WINDOW_SHELL.right
    );
    assert.ok(wide.contentBounds.x + wide.contentBounds.width <= workArea.x + workArea.width);
    assert.ok(wide.contentBounds.x >= workArea.x);

    const small = { x: 0, y: 0, width: 640, height: 480 };
    const capped = computeSessionHudBounds({
      hitRect: { left: 300, top: 100, right: 340, bottom: 140 },
      workArea: small,
      width: 800,
      height: computeHudHeight(12),
      scale: 1.6,
    });
    assert.ok(capped.contentBounds.width <= small.width);
    assert.ok(capped.contentBounds.x >= small.x);
    assert.ok(capped.contentBounds.x + capped.contentBounds.width <= small.x + small.width);
    assert.ok(capped.contentBounds.y >= small.y);
    assert.ok(capped.contentBounds.y + capped.contentBounds.height <= small.y + small.height);
  });
});

describe("session HUD max visible sessions setting", () => {
  it("Auto (0) keeps the per-label-mode caps", () => {
    assert.strictEqual(getHudMaxExpandedRows(true, 0), constants.HUD_MAX_EXPANDED_ROWS_LABELS);
    assert.strictEqual(getHudMaxExpandedRows(false, 0), constants.HUD_MAX_EXPANDED_ROWS);
    assert.strictEqual(getHudMaxExpandedRows(true), constants.HUD_MAX_EXPANDED_ROWS_LABELS);
    assert.strictEqual(getHudMaxExpandedRows(false, 99), constants.HUD_MAX_EXPANDED_ROWS);
  });

  it("an explicit cap overrides both label modes and the height grows with it", () => {
    const snapshot = mkSessions(10);
    for (const showStateLabels of [true, false]) {
      const layout = computeHudLayout(snapshot, { showStateLabels, maxRows: 8 });
      assert.strictEqual(layout.expanded.length, 8);
      assert.strictEqual(layout.folded.length, 2);
      assert.strictEqual(layout.rowCount, 9, "8 rows plus the other-active footer");
      assert.strictEqual(computeHudHeight(layout.rowCount), 9 * constants.HUD_ROW_HEIGHT + 2);
    }
    const one = computeHudLayout(snapshot, { showStateLabels: true, maxRows: 1 });
    assert.strictEqual(one.expanded.length, 1);
    assert.strictEqual(one.folded.length, 9);
  });

  it("main sends the effective cap; the renderer obeys it and sizes titles by CSS", () => {
    const hud = read("src/session-hud.js");
    assert.match(hud, /hudMaxRows: getHudMaxExpandedRows\(ctx\.sessionHudShowStateLabels !== false, ctx\.sessionHudMaxRows\)/);
    assert.doesNotMatch(hud, /hudTitleMaxUnits/);
    assert.match(hud, /maxRows: ctx\.sessionHudMaxRows/);
    const renderer = read("src/session-hud-renderer.js");
    assert.match(renderer, /const configured = Number\(snapshot\.hudMaxRows\)/);
    assert.doesNotMatch(renderer, /shortenHudTitle|hudTitleMaxUnits/);
  });
});

describe("session HUD size settings wiring", () => {
  it("mirrors both prefs into main and re-syncs the HUD live", () => {
    const main = read("src/main.js");
    for (const key of ["sessionHudWidth", "sessionHudMaxRows"]) {
      assert.match(main, new RegExp(`let ${key} = _settingsController\\.get\\("${key}"\\)`));
      assert.match(main, new RegExp(`get ${key}\\(\\) \\{ return ${key}; \\}`));
      assert.match(main, new RegExp(`${key}: \\(v\\) => \\{ ${key} = v; \\}`));
    }
    const router = read("src/settings-effect-router.js");
    assert.match(router, /"sessionHudWidth" in changes/);
    assert.match(router, /"sessionHudMaxRows" in changes/);
  });

  it("shows both rows in the Sessions tab and patches them in place", () => {
    const tab = read("src/settings-tab-sessions.js");
    assert.match(tab, /key: "sessionHudWidth",\s*labelKey: "rowSessionHudWidth"/);
    assert.match(tab, /key: "sessionHudMaxRows",\s*labelKey: "rowSessionHudMaxRows"/);
    assert.match(tab, /SESSION_HUD_WIDTH_MIN = 200;/);
    assert.match(tab, /SESSION_HUD_WIDTH_MAX = 800;/);
    assert.match(tab, /SESSION_HUD_MAX_ROWS_MAX = 12;/);
    assert.strictEqual(size.SESSION_HUD_WIDTH_MIN, 200);
    assert.strictEqual(size.SESSION_HUD_WIDTH_MAX, 800);
    assert.strictEqual(size.SESSION_HUD_MAX_ROWS_MAX, 12);
  });

  it("translates every new string in every settings locale", () => {
    const { translations } = loadSettingsI18n();
    const langs = Object.keys(translations);
    assert.ok(langs.length >= 7);
    for (const lang of langs) {
      for (const key of [
        "rowSessionHudWidth",
        "rowSessionHudWidthDesc",
        "rowSessionHudMaxRows",
        "rowSessionHudMaxRowsDesc",
        "unitPixels",
        "valueAuto",
      ]) {
        const value = translations[lang][key];
        assert.ok(typeof value === "string" && value.length > 0, `${lang}.${key}`);
      }
    }
  });
});

function loadSettingsI18n() {
  // Browser-style IIFE: it registers itself on globalThis.
  require("../src/settings-i18n");
  return { translations: globalThis.ClawdSettingsI18n.STRINGS };
}
