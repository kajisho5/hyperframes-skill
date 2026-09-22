// The tool list. Order here is not significant; the contract sorts by id.
import * as doctor from "./tools/doctor.mjs";
import * as preview from "./tools/preview.mjs";
import * as probe from "./tools/probe.mjs";
import * as render from "./tools/render.mjs";
import * as scene from "./tools/scene.mjs";

export const TOOLS = [doctor, scene, render, probe, preview];

export function toolByName(name) {
  return TOOLS.find((t) => t.meta.name === name) ?? null;
}
