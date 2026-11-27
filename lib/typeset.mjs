// International typesetting and text fit (roadmap step 8, design-decisions D21): a text layer's own
// language (lang, direction), line-break rules (UAX #14 by the browser, strict kinsoku, phrase breaks
// with BudouX run locally), the opt-in regional profiles (vertical writing, ruby), and `fit: shrink`,
// which finds the largest font size at which the text fits its box by laying it out in the same
// headless Chromium the render uses. Text is never cut or ellipsised: a text that does not fit at the
// stated minimum is an error that gives the overflow in pixels.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { resolveChromium } from "./deps.mjs";
import { ToolError } from "./result.mjs";

const require = createRequire(import.meta.url);

// Scripts written right to left, by primary language subtag (BCP 47).
export const RTL_LANGS = new Set(["ar", "arc", "ckb", "dv", "fa", "he", "iw", "ks", "ku", "ps", "sd", "syr", "ug", "ur", "yi"]);
export const LINE_BREAKS = ["normal", "strict", "loose"];
export const WRITING_MODES = ["horizontal", "vertical"];
export const DIRECTIONS = ["auto", "ltr", "rtl"];
const MAX_FIT_STEPS = 16;

const primary = (lang) => String(lang).split("-")[0].toLowerCase();

/** The direction a layer's text runs in: stated, else from its language (rtl for Arabic, Hebrew, ...). */
export function textDirection(style, lang) {
  if (style.direction === "ltr" || style.direction === "rtl") return style.direction;
  return RTL_LANGS.has(primary(lang)) ? "rtl" : "ltr";
}

/**
 * The BudouX parser for a language, or null where BudouX has no model: Japanese, Simplified and
 * Traditional Chinese, Thai. zh is Simplified unless the tag says Hant, TW, HK or MO.
 */
export function phraseParser(lang) {
  const budoux = require("budoux");
  const p = primary(lang);
  if (p === "ja") return { model: "ja", parser: budoux.loadDefaultJapaneseParser() };
  if (p === "th") return { model: "th", parser: budoux.loadDefaultThaiParser() };
  if (p === "zh") {
    const hant = /-(hant|tw|hk|mo)\b/i.test(lang);
    return hant ? { model: "zh-hant", parser: budoux.loadDefaultTraditionalChineseParser() } : { model: "zh-hans", parser: budoux.loadDefaultSimplifiedChineseParser() };
  }
  return null;
}

/**
 * Ruby notation in a text: {base|reading}. Returns [{text} | {base, ruby}] or {error}. A brace that
 * is not part of a complete {base|reading} group is refused, so nothing is silently drawn as markup.
 */
export function parseRuby(text) {
  const out = [];
  const re = /\{([^{}|]+)\|([^{}|]+)\}/gu;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ base: m[1], ruby: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  const stray = out.find((p) => p.text !== undefined && /[{}|]/.test(p.text));
  if (stray) return { error: `"${stray.text}" has a { } or | outside a complete {base|reading} group` };
  if (!out.some((p) => p.base !== undefined)) return { error: "has no {base|reading} group" };
  return { parts: out };
}

/** The text as it is drawn (ruby readings left out): what title.json and the line report carry. */
export function plainText(L) {
  if (!L.style?.ruby) return L.text;
  const r = parseRuby(L.text);
  return r.parts ? r.parts.map((p) => p.text ?? p.base).join("") : L.text;
}

/**
 * Validate the step-8 keys of a text layer (already normalized style) and return the problems through
 * err. `out` is the normalized layer: out.lang, out.fit are set here.
 */
export function validateTypesetting(L, out, sceneLang, fonts, err, at) {
  const S = out.style;
  const lang = L.lang ?? sceneLang;
  if (L.lang !== undefined && (typeof L.lang !== "string" || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(L.lang))) err(`${at}.lang must be a BCP 47 tag such as en, ar, hi or ja`);
  out.lang = lang;
  if (!DIRECTIONS.includes(S.direction)) err(`${at}.style.direction must be one of ${DIRECTIONS.join(", ")} (auto: from the layer's lang)`);
  if (!LINE_BREAKS.includes(S.line_break)) err(`${at}.style.line_break must be one of ${LINE_BREAKS.join(", ")} (strict: strict kinsoku for CJK)`);
  if (!WRITING_MODES.includes(S.writing_mode)) err(`${at}.style.writing_mode must be horizontal or vertical`);
  for (const k of ["phrases", "ruby"]) if (typeof S[k] !== "boolean") err(`${at}.style.${k} must be true or false`);
  const units = out.transition_in?.units || out.transition_out?.units;
  if (S.phrases === true) {
    if (typeof lang === "string" && !phraseParser(lang)) err(`${at}.style.phrases: BudouX has no model for "${lang}" (it has ja, zh-Hans, zh-Hant and th)`);
    if (units) err(`${at}.style.phrases and a chars / words / lines transition both split the text; use one`);
  }
  if (S.ruby === true) {
    if (typeof L.text === "string") {
      const r = parseRuby(L.text);
      if (r.error) err(`${at}.text ${r.error} (style.ruby reads {base|reading})`);
    }
    if (units) err(`${at}.style.ruby cannot be combined with a chars / words / lines transition`);
    if (S.phrases === true) err(`${at}.style.ruby and style.phrases: use one`);
  }
  if (S.writing_mode === "vertical" && S.direction === "rtl") err(`${at}.style.writing_mode vertical runs top to bottom; direction rtl does not apply`);
  if (L.fit === undefined) return;
  const F = L.fit;
  if (typeof F !== "object" || F === null || Array.isArray(F)) return err(`${at}.fit must be an object {mode: "shrink", min_font_size}`);
  let ok = true;
  const bad = (m) => {
    ok = false;
    err(m);
  };
  for (const k of Object.keys(F)) if (!["mode", "min_font_size"].includes(k)) bad(`${at}.fit: unknown key "${k}" (mode, min_font_size)`);
  if (F.mode !== "shrink") bad(`${at}.fit.mode must be shrink (the only fit: the size goes down, the text is never cut)`);
  if (!Number.isInteger(F.min_font_size) || F.min_font_size < 1) bad(`${at}.fit.min_font_size must be an integer >= 1 (px)`);
  else if (Number.isInteger(S.font_size) && F.min_font_size > S.font_size) bad(`${at}.fit.min_font_size (${F.min_font_size}) is larger than style.font_size (${S.font_size}), the size it starts from`);
  // the size measured must be the size rendered: the font is a file the scene ships, not whatever a machine maps a name to
  const first = String(S.font_family).split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  if (!fonts.some((f) => f.family.toLowerCase() === first.toLowerCase())) bad(`${at}.fit: style.font_family "${first}" must name a family shipped in fonts[] (or --font), so the size measured is the size rendered`);
  if (out.keyframes?.tracking || out.keyframes?.font_variation) bad(`${at}.fit cannot be combined with tracking or font_variation keyframes: they change the text's size while it plays`);
  if (ok) out.fit = { mode: "shrink", min_font_size: F.min_font_size, max_font_size: S.font_size };
}

/** Does this layer need the wrapper span (fit measures it; phrases and ruby are markup inside it)? */
export const needsWrapper = (L) => !!(L.fit || L.style.phrases || L.style.ruby);

/** The inner markup of a text layer with phrases or ruby (escaped), or null for plain text. */
export function typesetInner(L, esc) {
  if (L.style.ruby) return parseRuby(L.text).parts.map((p) => (p.text !== undefined ? esc(p.text) : `<ruby>${esc(p.base)}<rt>${esc(p.ruby)}</rt></ruby>`)).join("");
  if (L.style.phrases) {
    const { model, parser } = phraseParser(L.lang);
    // Thai: Chrome breaks Thai inside a phrase too, so each phrase is kept whole; CJK: keep-all + <wbr>
    if (model === "th") return parser.parse(L.text).map((p) => `<span class="hfs-p">${esc(p)}</span>`).join("<wbr>");
    return parser.parse(L.text).map(esc).join("<wbr>");
  }
  return null;
}

/** The CSS declarations a text layer's typesetting adds to its rule ("" when it sets none). */
export function typesetCss(L) {
  const S = L.style;
  const d = [];
  if (S.line_break !== "normal") d.push(`line-break:${S.line_break}`);
  if (S.phrases && phraseParser(L.lang).model !== "th") d.push("word-break:keep-all");
  if (S.writing_mode === "vertical") d.push("writing-mode:vertical-rl;text-orientation:mixed");
  // fit: a word longer than the line overflows (and is measured) instead of being broken anywhere
  if (L.fit) d.push("overflow-wrap:normal");
  return d.length ? ";" + d.join(";") : "";
}

// --- measuring ---------------------------------------------------------------------------------

/**
 * In the page: for each layer id, the overflow of its text at the size it has now, and its lines.
 * Overflow is how far the text's box reaches past the layer's box, in px, on either axis (0 = fits).
 */
function pageMeasure(ids) {
  const res = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    const inner = el.querySelector(".hfs-t");
    const box = el.getBoundingClientRect();
    const r = inner.getBoundingClientRect();
    const w = Math.max(r.width, inner.scrollWidth);
    const h = Math.max(r.height, inner.scrollHeight);
    const vertical = getComputedStyle(el).writingMode.startsWith("vertical");
    const overflow = Math.max(0, w - box.width, h - box.height);
    // lines: graphemes grouped by their position on the block axis (ruby readings left out)
    const lines = [];
    let cur = "";
    let pos = null;
    const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);
    const seg = new Intl.Segmenter(el.lang || undefined, { granularity: "grapheme" });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement.closest("rt")) continue;
      let i = 0;
      for (const g of seg.segment(n.data)) {
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + g.segment.length);
        i += g.segment.length;
        if (g.segment === "\n") {
          lines.push(cur);
          cur = "";
          pos = null;
          continue;
        }
        const rect = [...range.getClientRects()].find((x) => x.width > 0 || x.height > 0);
        if (!rect) {
          cur += g.segment;
          continue;
        }
        const p = vertical ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
        const size = vertical ? rect.width : rect.height;
        if (pos !== null && Math.abs(p - pos) > size / 2 && !/^\s+$/.test(g.segment)) {
          lines.push(cur);
          cur = "";
        }
        if (!/^\s+$/.test(g.segment) || cur) pos = /^\s+$/.test(g.segment) ? pos : p;
        cur += g.segment;
      }
    }
    lines.push(cur);
    res[id] = { overflow: Math.ceil(overflow * 100) / 100, lines: lines.map((l) => l.replace(/\s+$/u, "")).filter((l, k, a) => l !== "" || k < a.length - 1), font_size: parseFloat(getComputedStyle(el).fontSize) };
  }
  return res;
}

async function launch() {
  const chrome = resolveChromium();
  if (!chrome.path || !chrome.exists) {
    throw new ToolError("missing_tool", "fit: shrink lays the text out in headless Chromium, and none was found", { hint: "run `npx hyperframes browser ensure`, or set HYPERFRAMES_BROWSER_PATH; `hyperframes-skill doctor` lists what was searched" });
  }
  const puppeteer = require("puppeteer-core");
  // the flags of HyperFrames' own capture that change text layout: no hinting, sRGB, no scrollbars
  const args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none", "--force-color-profile=srgb", "--hide-scrollbars", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking"];
  const browser = await puppeteer.launch({ executablePath: chrome.path, headless: true, args, pipe: true });
  return { browser, chrome };
}

/**
 * Fit every `fit` layer of the scene directory's index.html: the largest integer font size from the
 * layer's font_size down to its min_font_size at which the text fits its box. Binary search, then the
 * chosen size is measured again. Returns {chrome, layers: {id: {font_size, overflow, lines, fits}}}.
 */
export async function measureFit(ctx, sceneDir, layers, { width, height }) {
  const { browser, chrome } = await launch();
  ctx.record([chrome.path, "--headless", "(puppeteer: lay out the scene's text to fit it)", pathToFileURL(join(sceneDir, "index.html")).href], { exit_code: 0, role: "chrome-measure" });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(join(sceneDir, "index.html")).href, { waitUntil: "load" });
    // every declared face loaded before anything is measured
    await page.evaluate(async () => {
      await Promise.all([...document.fonts].map((f) => f.load().catch(() => null)));
      await document.fonts.ready;
    });
    const measureAt = async (sizes) =>
      page.evaluate(
        (sizes, src) => {
          for (const [id, s] of Object.entries(sizes)) document.getElementById(id).style.fontSize = `${s}px`;
          return new Function(`return (${src})`)()(Object.keys(sizes));
        },
        sizes,
        pageMeasure.toString(),
      );
    const out = {};
    // the starting size first (most text fits as given), then the minimum for the rest: a text that
    // does not fit at its minimum is reported with its overflow there. Then a binary search per layer
    // between a size that fits (lo) and one that does not (hi).
    const state = {};
    let m = await measureAt(Object.fromEntries(layers.map((L) => [L.id, L.fit.max_font_size])));
    for (const L of layers) state[L.id] = m[L.id].overflow === 0 ? { best: L.fit.max_font_size } : { lo: L.fit.min_font_size, hi: L.fit.max_font_size, best: null };
    const rest = layers.filter((L) => state[L.id].best === null);
    if (rest.length) {
      m = await measureAt(Object.fromEntries(rest.map((L) => [L.id, L.fit.min_font_size])));
      for (const L of rest) if (m[L.id].overflow > 0) state[L.id] = { best: L.fit.min_font_size, failed: true };
    }
    for (let step = 0; step < MAX_FIT_STEPS; step++) {
      const open = layers.filter((L) => state[L.id].best === null && state[L.id].hi - state[L.id].lo > 1);
      if (!open.length) break;
      const probe = Object.fromEntries(open.map((L) => [L.id, Math.floor((state[L.id].lo + state[L.id].hi) / 2)]));
      m = await measureAt(probe);
      for (const L of open) {
        if (m[L.id].overflow === 0) state[L.id].lo = probe[L.id];
        else state[L.id].hi = probe[L.id];
      }
    }
    for (const L of layers) if (state[L.id].best === null) state[L.id].best = state[L.id].lo;
    m = await measureAt(Object.fromEntries(layers.map((L) => [L.id, state[L.id].best])));
    for (const L of layers) out[L.id] = { font_size: state[L.id].best, overflow: m[L.id].overflow, lines: m[L.id].lines, fits: m[L.id].overflow === 0, measured_font_size: m[L.id].font_size };
    return { chrome: { path: chrome.path, source: chrome.source }, layers: out };
  } finally {
    await browser.close();
  }
}

/** Measure the scene as written, at the sizes in its HTML (no change): the read-back after fitting. */
export async function measureAsWritten(ctx, sceneDir, ids, { width, height }) {
  const { browser, chrome } = await launch();
  ctx.record([chrome.path, "--headless", "(puppeteer: measure the fitted text as written)", pathToFileURL(join(sceneDir, "index.html")).href], { exit_code: 0, role: "chrome-measure" });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(join(sceneDir, "index.html")).href, { waitUntil: "load" });
    await page.evaluate(async () => {
      await Promise.all([...document.fonts].map((f) => f.load().catch(() => null)));
      await document.fonts.ready;
    });
    return await page.evaluate((ids, src) => new Function(`return (${src})`)()(ids), ids, pageMeasure.toString());
  } finally {
    await browser.close();
  }
}
