// Frame rates and times by the ecosystem timebase spec velisa/timebase@1 (Velisa ADR-026; D18 here).
// A rate is an exact fraction {num, den} of frames per second. Arithmetic that decides a frame count is done
// on exact fractions (BigInt), never on a rounded decimal such as 29.97.

// TB-2: a decimal within 0.005 of base * 1000/1001 for one of these bases, that is not an integer, is that NTSC rate.
const NTSC_BASES = [24, 30, 48, 60, 120, 240];
const DECIMAL_RE = /^\+?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const RATIONAL_RE = /^\s*(\d+)\s*\/\s*(\d+)\s*$/;

/** A time-base error; `code` is one of the spec's codes (INVALID_RATE, INVALID_TIME). */
export class TimebaseError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const babs = (x) => (x < 0n ? -x : x);
function gcd(a, b) {
  a = babs(a);
  b = babs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}
/** A reduced fraction [n, d] of BigInts, d > 0. */
function frac(n, d) {
  if (d === 0n) throw new TimebaseError("INVALID_TIME", "zero denominator");
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1n;
  return [n / g, d / g];
}
function floorDiv(n, d) {
  const q = n / d;
  return n % d !== 0n && (n < 0n) !== (d < 0n) ? q - 1n : q;
}

/** The exact value of decimal text ('29.97', '1e-3', '12'), or null when it is not decimal text. */
function decimalFraction(text) {
  const m = DECIMAL_RE.exec(text);
  if (!m) return null;
  let [mant, exp] = text.replace(/^\+/, "").toLowerCase().split("e");
  let e = exp === undefined ? 0 : Number(exp);
  const [ip, fp = ""] = mant.split(".");
  let n = BigInt((ip || "0") + fp);
  e -= fp.length;
  return e >= 0 ? frac(n * 10n ** BigInt(e), 1n) : frac(n, 10n ** BigInt(-e));
}

/** An exact fraction of seconds (TB-3): a number through its shortest text (String(x)), decimal text, or 'N/D'. */
export function parseSeconds(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TimebaseError("INVALID_TIME", `${value} is not finite`);
    value = String(value);
  }
  if (typeof value !== "string") throw new TimebaseError("INVALID_TIME", `${JSON.stringify(value)} is not a number`);
  const t = value.trim();
  const r = RATIONAL_RE.exec(t);
  if (r) return frac(BigInt(r[1]), BigInt(r[2]));
  const neg = t.startsWith("-");
  const f = decimalFraction(neg ? t.slice(1) : t);
  if (!f) throw new TimebaseError("INVALID_TIME", `${JSON.stringify(value)} is not a number`);
  return neg ? [-f[0], f[1]] : f;
}

/**
 * A frame rate as an exact {num, den} (TB-2). 'N/D' (or {num, den}) is taken as written; an integer is N/1; a
 * decimal that is not an integer and lies within 0.005 of base * 1000/1001 (base 24, 30, 48, 60, 120, 240) is that
 * NTSC rate ('23.976', '23.98', '29.97', 59.94); any other decimal is its exact value (12.5 is 25/2). The rate
 * must be in (0, 1000]. Throws TimebaseError INVALID_RATE.
 */
export function parseRate(value) {
  const bad = (why) => new TimebaseError("INVALID_RATE", `frame rate ${JSON.stringify(value)} ${why}`);
  let n;
  let d;
  if (value && typeof value === "object" && Number.isInteger(value.num) && Number.isInteger(value.den)) {
    if (value.den <= 0) throw bad("has a zero or negative denominator");
    [n, d] = frac(BigInt(value.num), BigInt(value.den));
  } else {
    let text;
    if (typeof value === "number" && Number.isFinite(value)) text = String(value);
    else if (typeof value === "string") text = value.trim();
    else throw bad("is not N/D, an integer or a decimal");
    const r = RATIONAL_RE.exec(text);
    if (r) {
      if (BigInt(r[2]) === 0n) throw bad("has a zero denominator");
      [n, d] = frac(BigInt(r[1]), BigInt(r[2]));
    } else {
      const neg = text.startsWith("-");
      const f = decimalFraction(neg ? text.slice(1) : text);
      if (!f) throw bad("is not N/D, an integer or a decimal");
      [n, d] = neg ? [-f[0], f[1]] : f;
      if (d !== 1n) {
        for (const base of NTSC_BASES) {
          // |n/d - base*1000/1001| <= 5/1000  <=>  |n*1001 - base*1000*d| * 1000 <= 5 * d * 1001
          if (babs(n * 1001n - BigInt(base) * 1000n * d) * 1000n <= 5n * d * 1001n) {
            [n, d] = [BigInt(base) * 1000n, 1001n];
            break;
          }
        }
      }
    }
  }
  if (n <= 0n || n > 1000n * d) throw bad("is out of range (0, 1000]");
  return { num: Number(n), den: Number(d) };
}

/** The canonical text of a rate: '30' or '30000/1001'. */
export function rateStr(rate) {
  const r = parseRate(rate);
  return r.den === 1 ? String(r.num) : `${r.num}/${r.den}`;
}

/** The rate as a JavaScript number (for display and for comparing with a measured rate only). */
export function rateNumber(rate) {
  const r = parseRate(rate);
  return r.num / r.den;
}

/** Two rates are the same only when their exact fractions are equal. */
export function sameRate(a, b) {
  const x = parseRate(a);
  const y = parseRate(b);
  return x.num === y.num && x.den === y.den;
}

/**
 * Frames of a time at a rate (TB-4), on exact fractions. nearest: floor(t * rate + 1/2), a half up (positions,
 * the frame count of a duration); down: floor((t + 1 ms) * rate) (the whole frames of a length).
 */
export function framesAt(seconds, rate, mode = "nearest") {
  const [tn, td] = parseSeconds(seconds);
  const r = parseRate(rate);
  const rn = BigInt(r.num);
  const rd = BigInt(r.den);
  if (mode === "nearest") return Number(floorDiv(2n * tn * rn + td * rd, 2n * td * rd));
  if (mode === "down") return Number(floorDiv((tn * 1000n + td) * rn, td * 1000n * rd));
  throw new TimebaseError("INVALID_TIME", `unknown rounding mode ${JSON.stringify(mode)} (nearest | down)`);
}

/** The exact start time of frame `frames`, as 'N/D' (or 'N') text. */
export function secondsOf(frames, rate) {
  if (!Number.isInteger(frames)) throw new TimebaseError("INVALID_TIME", `frame count ${frames} is not an integer`);
  const r = parseRate(rate);
  const [n, d] = frac(BigInt(frames) * BigInt(r.den), BigInt(r.num));
  return d === 1n ? String(n) : `${n}/${d}`;
}

/** The start time of frame `frames` as a JavaScript number of seconds. */
export function frameSeconds(frames, rate) {
  const r = parseRate(rate);
  return (frames * r.den) / r.num;
}
