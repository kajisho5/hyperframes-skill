#!/usr/bin/env node
import { main } from "../lib/cli.mjs";
import * as tool from "../lib/tools/doctor.mjs";

await main(tool);
