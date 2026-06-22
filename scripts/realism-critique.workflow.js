export const meta = {
  name: 'realism-critique',
  description: 'Fan-out art-director critics over night-cab stills, synthesise a ranked realism change list',
  whenToUse: 'After capturing e2e/screenshots, to review the rendered world against the realism rubric',
  phases: [
    { title: 'Critique', detail: 'one art-director per rubric lens reads the stills' },
    { title: 'Synthesize', detail: 'dedupe + rank into a prioritised change list' },
  ],
};

// The reusable review engine for the realism loop (see
// wrk_docs/2026.06.22 - PLN - realism iteration loop.md). Each critic agent READS
// the screenshots (the Read tool shows images) and judges through one lens; a
// synthesiser merges them. Override the shot list / label via args.

const SHOT_DIR = 'C:/worktrees/mdtrain2/ai-render/e2e/screenshots';
const DEFAULT_SHOTS = [
  'day-01-kingsgate', 'day-02-signal-ashcombe', 'day-03-truss-bridge',
  'day-04-open-country', 'day-05-viaduct', 'day-06-drive-kingsgate',
  'dusk-01-country',
  '01-kingsgate-skyline', '03-truss-bridge', '06-viaduct', '08-drive-kingsgate',
];
const shots = (args && args.shots ? args.shots : DEFAULT_SHOTS).map(
  (n) => `${SHOT_DIR}/${n}.png`,
);
const label = (args && args.label) || 'iteration';

const MAP = `Renderer is impure Three.js under src/render/, driven by a PURE tested sim core (src/sim/*, do NOT change except the lighting constants in environment.ts):
- src/render/scene.ts — camera/eye pose, FOV(70)/eye-height, hemisphere+moon DirectionalLight, gradient sky-dome shader, tiny IBL env-map, rain Points, lazy UnrealBloom, ACES tone-map, signals, AI trains, contact wire, celestial layer (moon/halo/stars).
- src/render/scenery.ts — trees, bushes, lit-window buildings, box overbridges, the steel truss bridge, platform people, warm ballast marker lights, road traffic.
- src/render/lineside (in scene.ts) — OLE masts, fencing, mileposts.
- src/render/textures.ts — procedural Canvas-2D maps (ground/ballast/masonry/rail/facade), env equirect, rain-drop, moon halo.
- src/render/terrain-mesh.ts — the terrain ribbon (cuttings, embankments, hills).
- src/render/cab.ts — cab interior (levers, needles, lamps, wiper).
- src/sim/environment.ts — PURE: time-of-day x weather -> skyColor, fog near/far, hemi/sun colours+intensities, exposure, bloomStrength, sunDir, nightFactor, groundColor. The tunable lighting knobs live HERE.
- src/render/quality.ts — per-tier settings (pixel ratio, rain count, shadows, bloom).`;

const CONSTRAINTS = `Constraints on any fix: 100% procedural (no new npm runtime deps, no committed image assets); no Math.random in the per-frame loop; PointLights hard-capped per tier (prefer emissive); keep the pure sim core untouched except environment.ts lighting constants. The HUD text overlay and the green sphere / cab frame in shots are UI/cab, not world — ignore them.`;

const LENSES = [
  { key: 'lighting-atmosphere', brief: 'Lighting & atmosphere: is the sky gradient & fog believable for THIS time-of-day? Exposure right (day genuinely bright, dusk golden, night moody)? Bloom overblown or tasteful? Does light DIRECTION read coherently (sheen/shading agree with one sun/moon)? Colour temperature per time-of-day.' },
  { key: 'scale-proportion', brief: 'Scale & proportion: are buildings, signals, bridges, trees, platforms sized right vs the train and each other (nothing toy-like or giant)? Does the eye height / FOV / framing feel like a real driving cab? Does the sense of speed/space read right?' },
  { key: 'materials-surfaces', brief: 'Materials & surfaces: do steel, masonry, ballast, rail, foliage, road, terrain read as THEIR material under this light — or flat, plastic, uniformly tinted, too smooth/too noisy? Are textures at a believable scale?' },
  { key: 'geometry-integrity', brief: 'Geometry & world integrity: any floating, clipping, z-fighting, gaps, or props not sitting on the ground? Is placement & DENSITY plausible (too sparse / too cluttered / repetitive)? Horizon and terrain shape believable?' },
  { key: 'believability', brief: 'Believability (a real train driver looking out): does it FEEL like a real railway in the real world? What single thing most breaks the illusion in each scene? What does a real lineside have that ours lacks (distance haze, ground detail, sky, signage, ground clutter, sensible element mix)?' },
];

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    overall: { type: 'string', description: 'one-paragraph verdict on this lens across the set' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scene: { type: 'string', description: 'which screenshot (or "general")' },
          issue: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'polish'] },
          why: { type: 'string', description: 'why it breaks realism' },
          suspectedArea: { type: 'string', description: 'file/system most likely responsible' },
          suggestedFix: { type: 'string' },
        },
        required: ['scene', 'issue', 'severity', 'why', 'suspectedArea', 'suggestedFix'],
      },
    },
  },
  required: ['lens', 'overall', 'findings'],
};

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'where the world stands vs "feels like a real train"' },
    topThemes: { type: 'array', items: { type: 'string' }, description: 'the few cross-cutting themes' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rank: { type: 'number' },
          title: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'polish'] },
          scenes: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
          suspectedFiles: { type: 'array', items: { type: 'string' } },
          approach: { type: 'string', description: 'concrete, procedural, feasible fix' },
          effort: { type: 'string', enum: ['S', 'M', 'L'] },
        },
        required: ['rank', 'title', 'severity', 'scenes', 'rationale', 'suspectedFiles', 'approach', 'effort'],
      },
    },
  },
  required: ['summary', 'topThemes', 'changes'],
};

phase('Critique');
log(`Critiquing ${shots.length} stills across ${LENSES.length} lenses (${label})`);
const critiques = await parallel(
  LENSES.map((lens) => () =>
    agent(
      `You are a meticulous art director for a UK train simulator that aims to FEEL like driving a real train in the real world (day, dusk and night; clear and rain). Judge ONLY through this lens:

${lens.brief}

Read EACH of these screenshots before judging (use the Read tool — they render as images), and judge them as a set so you can compare times of day:
${shots.join('\n')}

${MAP}

${CONSTRAINTS}

Be specific and actionable: name the scene, say what is wrong and WHY it breaks realism, rate severity honestly (most things are minor/polish; reserve blocker/major for what genuinely breaks the illusion), and give a concrete procedural fix with a suspected file. Do not invent issues to pad the list; if a scene is good, say so.`,
      { label: `critique:${lens.key}`, phase: 'Critique', schema: FINDINGS_SCHEMA },
    ),
  ),
);

phase('Synthesize');
const valid = critiques.filter(Boolean);
const plan = await agent(
  `You are the lead. Five art directors critiqued the same train-sim screenshots, each through one lens. Merge their findings into ONE prioritised, DEDUPED change list that moves the world toward "feels like driving a real train in the real world".

Rank by (severity x how much it breaks the illusion x how many scenes it touches), collapse duplicates across lenses into single changes, map each to the most likely file(s), and give a concrete procedural approach + effort (S/M/L). Lead with the daytime issues if day looks weaker than night (the prior work was night-focused). Be honest about what is already good.

${MAP}

Critiques (JSON):
${JSON.stringify(valid)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: PLAN_SCHEMA },
);

return { plan, critiques: valid };
