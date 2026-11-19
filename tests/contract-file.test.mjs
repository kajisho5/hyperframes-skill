// contract/contract.json is the committed copy of the contract; it must match what the code prints.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { render } from "../contract/generate.mjs";
import { ROOT } from "./helpers.mjs";

test("contract/contract.json is up to date (regenerate: node contract/generate.mjs)", () => {
  assert.equal(readFileSync(join(ROOT, "contract", "contract.json"), "utf8"), render());
});
