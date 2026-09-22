// Batch rows: a CSV file (header row + one row per item, RFC 4180 quoting) or a JSON array of
// objects. CSV is decoded strictly: invalid UTF-8 is an error that names --encoding shift_jis
// (the usual encoding of a spreadsheet saved as CSV on a Japanese Windows machine), never a
// silent mojibake render.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { ToolError } from "./result.mjs";

export const ENCODINGS = ["utf-8", "shift_jis"];

/** Parse RFC 4180 CSV text into an array of string arrays. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let quoted = false;
  let line = 1;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        if (i < text.length && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") throw new ToolError("input", `CSV line ${line}: text after a closing quote`);
        continue;
      }
      if (c === "\n") line++;
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (field !== "") throw new ToolError("input", `CSV line ${line}: a quote inside an unquoted field`);
      quoted = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      line++;
    } else {
      field += c;
      i++;
    }
  }
  if (quoted) throw new ToolError("input", `CSV: a quoted field is not closed (started before line ${line})`);
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/**
 * Load rows as [{index (1-based), line?, values: {column: string|number}}]. CSV cells are
 * strings; an empty cell means "not given". JSON rows keep their types.
 */
export function loadRows(path, { encoding = "utf-8" } = {}) {
  if (!ENCODINGS.includes(encoding)) throw new ToolError("input", `--encoding must be one of ${ENCODINGS.join(", ")}`);
  let buf;
  try {
    buf = readFileSync(path);
  } catch (e) {
    throw new ToolError("input", `cannot read ${path}: ${e.code ?? e.message}`);
  }
  let text;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(buf);
  } catch {
    throw new ToolError("input", `${path} is not valid ${encoding} text`, {
      hint: encoding === "utf-8" ? "a CSV saved by Excel on Japanese Windows is usually Shift_JIS: pass --encoding shift_jis, or save it as \"CSV UTF-8\"" : undefined,
    });
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const ext = extname(path).toLowerCase();
  if (ext === ".json") {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new ToolError("input", `${path} is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(data) || data.some((r) => typeof r !== "object" || r === null || Array.isArray(r))) {
      throw new ToolError("input", `${path} must hold a JSON array of objects (one per item)`);
    }
    return { columns: [...new Set(data.flatMap((r) => Object.keys(r)))], rows: data.map((values, n) => ({ index: n + 1, values })) };
  }
  if (ext !== ".csv") throw new ToolError("input", `rows must be a .csv or .json file, not ${ext || "(no extension)"}`);
  const table = parseCsv(text);
  if (table.length < 2) throw new ToolError("input", `${path} needs a header row and at least one data row`);
  const header = table[0].map((h) => h.trim());
  const dup = header.find((h, i) => h === "" || header.indexOf(h) !== i);
  if (dup !== undefined) throw new ToolError("input", `${path}: header has an empty or repeated column name ("${dup}")`);
  const rows = table.slice(1).map((cells, n) => {
    if (cells.length !== header.length) throw new ToolError("input", `${path} row ${n + 1}: ${cells.length} cells, the header has ${header.length}`);
    const values = {};
    header.forEach((h, i) => {
      if (cells[i] !== "") values[h] = cells[i];
    });
    return { index: n + 1, values };
  });
  return { columns: header, rows };
}

/** A file-name-safe label from a cell value: letters and digits of any script, others -> "-". */
export function slug(value) {
  return String(value)
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
