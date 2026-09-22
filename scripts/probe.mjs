#!/usr/bin/env node
import { main } from "../lib/cli.mjs";
import * as tool from "../lib/tools/probe.mjs";

await main(tool);
