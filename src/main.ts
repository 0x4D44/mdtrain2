// The thin, deliberately-untested impure shell. Wires keyboard → controls →
// safety → resolveInputs → the track-graph tick → render → HUD. Contains NO
// control/safety/HUD/sim arithmetic — every branch that could be wrong lives in a
// pure, tested function under src/sim. `mu` is derived each frame from the pure
// `environmentParams(env)`.
//
// Track graph (HLD 2026.06.20): the live scenario is the KINGSGATE JUNCTION — the
// real KINGSGATE_SEAHAVEN route decomposed into graph edges with a passing loop +
// a branch + reactive AI. The PLAYER's path edges reconstruct KINGSGATE exactly
// (P0/P1/G-DIFF), so the player's edge-local position maps to a global KINGSGATE
// chainage and the entire existing camera/scenery/AWS/HUD pipeline runs unchanged
// on KINGSGATE with that chainage. The AIs run on the graph (loop/branch) and are
// rendered as world meshes via placeOnEdge.

import {
  buildHudView,
  createInitialControls,
  createInitialSafety,
  POWER_NOTCHES,
  reduceControls,
  resolveInputs,
  resolvedBrakeDemand,
  tickSafety,
} from "./sim/controls";
import { createInitialAws, tickAws } from "./sim/aws";
import { type SimState } from "./sim/simulation";
import { KINGSGATE_SEAHAVEN } from "./sim/route";
import {
  DEFAULT_ENVIRONMENT,
  environmentParams,
  cycleEnvironment,
  type EnvironmentParams,
} from "./sim/environment";
import { type Edge, type Path, type TrainPosition } from "./sim/graph";
import { placeOnEdge, validateGraph } from "./sim/graph-geom";
import { tickAll, type TrainRecord } from "./sim/graph-sim";
import { KINGSGATE_JUNCTION } from "./sim/testbed";
import { createScene, type RenderView, type TrainMeshHandle } from "./render/scene";
import { createHud } from "./ui/hud";
import { createHelpPanel } from "./ui/help";
import { createAudioEngine } from "./audio/engine";
import { audioParams } from "./audio/params";
import {
  intentFromActions,
  keyboardActions,
  mergeActions,
} from "./input/intent";
import { createKeyboardSource } from "./input/keyboard";
import { createGamepadSource } from "./input/gamepad";
import { createTouchControls } from "./input/touch";
import { motionParams } from "./ui/motion";
import { qualityFor } from "./render/quality";

const app = document.getElementById("app");
if (!app) throw new Error("#app not found");

// The live scenario: the KINGSGATE junction (real route + loop + branch + AI).
const scenario = KINGSGATE_JUNCTION;
const graph = scenario.graph;
const route = KINGSGATE_SEAHAVEN; // the player's underlay route (scenery, AWS, HUD, camera)

// Fail fast at startup if the authored graph is structurally invalid.
const defects = validateGraph(
  graph,
  Object.values(scenario.paths),
  scenario.stationNames,
  scenario.maxSpeed,
  120,
);
if (defects.length) {
  throw new Error(`Track graph invalid:\n${defects.map((d) => `  ${d.kind}: ${d.detail}`).join("\n")}`);
}

// The player's path edges concatenate into KINGSGATE; build the edge→global
// chainage offset table so the player's edge-local position maps to a KINGSGATE
// chainage (and back, for the ?s= screenshot seed).
const playerPath = scenario.paths.player as Path;
const offsets: Record<string, number> = {};
{
  let acc = 0;
  for (const id of playerPath) {
    offsets[id] = acc;
    acc += (graph.edges[id] as Edge).route.length;
  }
}
const posToGlobal = (pos: TrainPosition): number => (offsets[pos.edgeId] ?? 0) + pos.s;
const globalToPos = (gs: number): TrainPosition => {
  for (const id of playerPath) {
    const len = (graph.edges[id] as Edge).route.length;
    const off = offsets[id] as number;
    if (gs < off + len || id === playerPath[playerPath.length - 1]) {
      return { edgeId: id, s: Math.max(0, Math.min(len, gs - off)), d: 0 };
    }
  }
  return { edgeId: playerPath[0] as string, s: 0, d: 0 };
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
const quality = qualityFor({
  coarsePointer,
  maxDevicePixelRatio: window.devicePixelRatio,
  reducedMotion,
});

const scene = createScene(app, route, quality);
const hud = createHud(document.body);
createHelpPanel(document.body);
const audio = createAudioEngine();

const kb = createKeyboardSource();
const pad = createGamepadSource();
const touch = createTouchControls(app);

// The trains: the scenario's initial records. ?s=<chainage> reseeds the player's
// start so the route's set-pieces (Wyre Viaduct ~8050, Stonehead Tunnel ~11700)
// can be captured without driving there.
let records: TrainRecord[] = scenario.makeRecords();
const startParam = Number(new URLSearchParams(location.search).get("s") ?? "");
if (Number.isFinite(startParam) && startParam > 0) {
  const seed = globalToPos(Math.max(0, Math.min(route.length, startParam)));
  records = records.map((r) =>
    r.id === "player" ? { ...r, pos: seed, state: { ...r.state, chainage: seed.s } } : r,
  );
}

// One world mesh per AI train.
const aiMeshes = new Map<string, TrainMeshHandle>();
for (const r of records) if (r.kind === "ai") aiMeshes.set(r.id, scene.addTrainMesh());

let controls = createInitialControls();
let safety = createInitialSafety();
let aws = createInitialAws();
let env = DEFAULT_ENVIRONMENT;

window.addEventListener("resize", () => scene.resize());

function startAudioOnce(): void {
  audio.start();
  window.removeEventListener("keydown", startAudioOnce);
  window.removeEventListener("pointerdown", startAudioOnce);
}
window.addEventListener("keydown", startAudioOnce);
window.addEventListener("pointerdown", startAudioOnce);

const player = (): TrainRecord => records.find((r) => r.id === "player") as TrainRecord;

let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05); // the ONLY wall-clock
  last = now;

  const actions = mergeActions(keyboardActions(kb.edges()), pad.actions(), touch.actions());
  const intent = intentFromActions(actions);
  if (actions.cycleEnvironment) env = cycleEnvironment(env);

  const motion = motionParams(reducedMotion);
  const base = environmentParams(env);
  const ep: EnvironmentParams = {
    ...base,
    rainIntensity: base.rainIntensity * motion.rainScale,
    wiperOn: base.wiperOn && motion.wiperEnabled,
  };

  // The player's pre-tick state in GLOBAL (KINGSGATE) chainage.
  const pRec = player();
  const prevGlobal = posToGlobal(pRec.pos);
  const preState: SimState = {
    chainage: prevGlobal,
    speed: pRec.state.speed,
    brakeActual: pRec.state.brakeActual,
    time: pRec.state.time,
  };

  controls = reduceControls(controls, intent, preState, safety); // safety = prior frame's
  const playerInputs = resolveInputs(controls, safety, ep.mu);

  // Advance every train on the graph (player by playerInputs, AIs by their controller).
  records = tickAll(graph, records, scenario.blockEdgeIds, dt, ep.mu, playerInputs);

  // The player's post-tick state, back in global chainage, drives the existing pipeline.
  const pNow = player();
  const nowGlobal = posToGlobal(pNow.pos);
  const postState: SimState = {
    chainage: nowGlobal,
    speed: pNow.state.speed,
    brakeActual: pNow.state.brakeActual,
    time: pNow.state.time,
  };
  const dir = controls.lastDir;
  const awsOut = tickAws(aws, postState, route, intent, prevGlobal, dir, dt);
  aws = awsOut.next;
  safety = tickSafety(safety, intent, postState, dt, { reasons: awsOut.reasons });

  const view: RenderView = {
    chainage: nowGlobal,
    speed: postState.speed,
    dt,
    controls,
    safety,
    aws,
    served: aws.served,
    env: ep,
  };
  scene.render(view);
  hud.update(buildHudView(postState, controls, safety, route, aws.served, awsOut.hud));

  // Position the AI-train meshes via placeOnEdge (world coords == KINGSGATE centreline).
  for (const r of records) {
    if (r.kind !== "ai") continue;
    const mesh = aiMeshes.get(r.id);
    if (!mesh) continue;
    const edge = graph.edges[r.pos.edgeId] as Edge;
    mesh.setPose(placeOnEdge(edge, r.pos.s, r.pos.d));
    mesh.setVisible(true);
  }

  const brakeDemand = resolvedBrakeDemand(controls, safety);
  audio.update(audioParams(postState.speed, controls.powerNotch / POWER_NOTCHES, brakeDemand));

  kb.clear();
}
requestAnimationFrame(frame);
