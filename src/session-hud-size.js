"use strict";

// Session HUD size preferences shared by prefs, settings validators and the
// HUD window owner. Pure data — no Electron imports, so prefs.js can load it.
//
// Both prefs use 0 as "Auto": the historical layout-derived width and the
// per-label-mode row cap. Non-zero values are explicit user choices.

// CSS px before text scaling. The width is a floor on top of the automatic
// width (chips, actions and tags keep their room); the window is still
// clamped to the display's work area.
const SESSION_HUD_WIDTH_AUTO = 0;
const SESSION_HUD_WIDTH_MIN = 200;
const SESSION_HUD_WIDTH_MAX = 800;

const SESSION_HUD_MAX_ROWS_AUTO = 0;
const SESSION_HUD_MAX_ROWS_MIN = 1;
const SESSION_HUD_MAX_ROWS_MAX = 12;

function isValidSessionHudWidth(value) {
  return Number.isInteger(value)
    && (value === SESSION_HUD_WIDTH_AUTO
      || (value >= SESSION_HUD_WIDTH_MIN && value <= SESSION_HUD_WIDTH_MAX));
}

function isValidSessionHudMaxRows(value) {
  return Number.isInteger(value)
    && (value === SESSION_HUD_MAX_ROWS_AUTO
      || (value >= SESSION_HUD_MAX_ROWS_MIN && value <= SESSION_HUD_MAX_ROWS_MAX));
}

module.exports = {
  SESSION_HUD_WIDTH_AUTO,
  SESSION_HUD_WIDTH_MIN,
  SESSION_HUD_WIDTH_MAX,
  SESSION_HUD_MAX_ROWS_AUTO,
  SESSION_HUD_MAX_ROWS_MIN,
  SESSION_HUD_MAX_ROWS_MAX,
  isValidSessionHudWidth,
  isValidSessionHudMaxRows,
};
