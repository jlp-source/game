/* ============================================================
   THE QUIET WOOD — browser horror/survival prototype
   Three.js (global build), vanilla JS, no build tooling.
   ============================================================ */
'use strict';

/* ---------------- map configuration ----------------
   Edit the world layout with editor.html — it exports map.js,
   which defines window.MAP_DATA. Missing fields fall back to these. */
const MAP_DEFAULTS = {
  seed: 20260713,
  worldSize: 190,             // half-extent of the playable square, 150-350
  props: [],                  // extra placed objects: {type, x, z}
  riverX: 60,
  pond: { x: 45, z: -70, r: 13 },
  hill: { x: 148, z: 148 },
  bridgeZ: 55,
  fire: { x: 11, z: 8 },
  cabin: { x: -95, z: 85 },
  campsite: { x: 95, z: -115 },
  blind: { x: -140, z: -55 },
  hollow: { x: -170, z: -170 },
  pieces: [{ x: -34, z: 27 }, { x: 42, z: -16 }, { x: -15, z: -45 }, { x: 30, z: 41 }],
  tallGrass: [{ x: 40, z: -45 }, { x: -55, z: 20 }, { x: 80, z: 40 }, { x: -20, z: -70 }],
};
const MAPCFG = Object.assign({}, MAP_DEFAULTS, window.MAP_DATA || {});

/* ---------------- helpers ---------------- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(MAPCFG.seed);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// smoothstep that tolerates e0 > e1 (inverted ranges)
function sstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
const $ = id => document.getElementById(id);

/* ---------------- constants ---------------- */
const PIXEL_SCALE = 1.0; // native render resolution
const WORLD = clamp(MAPCFG.worldSize || 190, 150, 350); // playable half-extent, from the map editor
const DENS = Math.min(3, (WORLD / 190) ** 2);           // scatter density scales with world area
const SEC_PER_HOUR = 180;       // 3 real minutes = 1 in-game hour (1 real min ≈ 20 game min)
const START_HOUR = 20; // you wake at nightfall, beside a fire someone lit
const NIGHT_START = 20, NIGHT_END = 6;

const RIVER_X = MAPCFG.riverX, RIVER_HALF = 9;
const POND = MAPCFG.pond;
const FIRE = MAPCFG.fire;
const SHELTER = { x: FIRE.x + 3, z: FIRE.z + 4 }; // camp centre, used by set dressing

/* Per-night escalation: scare count, audio-event count, storm */
const NIGHTS = {
  1: { sil: 0, aud: 1, storm: false },
  2: { sil: 1, aud: 1, storm: false },
  3: { sil: 2, aud: 2, storm: false },
  4: { sil: 3, aud: 3, storm: true  },
  5: { sil: 3, aud: 3, storm: false },
  6: { sil: 5, aud: 4, storm: true  },
  7: { sil: 6, aud: 5, storm: false },
};


const ITEM_HINTS = {
  'Small Stick': 'dry kindling', Stick: 'firewood', Branch: 'heavy firewood',
  Pebble: 'a smooth stone', Stone: 'a heavy stone', Mud: 'cold river mud',
  Leaves: 'soft leaves',
  'Key': 'opens the cabin',
  Flashlight: 'pushes the dark back a little — F switches it on and off',
  Battery: 'for the generator',
  'Spark Plug': 'for the generator',
  'Drive Belt': 'for the generator',
  Plank: 'long enough to bridge a gap',
};

const ITEM_COLORS = {
  'Small Stick': '#8a6a3c', Stick: '#7a5a32', Branch: '#5f4222', Pebble: '#9a9a9a', Stone: '#767676',
  Mud: '#4c3b26', Leaves: '#4a7a34', Berries: '#8a2f47',
  Grubs: '#c9b98a', Rations: '#b8873d',
  'Key': '#9c7a4a', Flashlight: '#4c545e',
  Battery: '#2a2d33', 'Spark Plug': '#d8d4c8', 'Drive Belt': '#2f2b28', Plank: '#8a6a42',
};
const ITEM_ABBR = {
  'Small Stick': 'sS', Stick: 'St', Branch: 'Br', Pebble: 'Pb', Stone: 'So', Mud: 'Mu',
  Leaves: 'Lv', Berries: 'Be', Grubs: 'Gr', Rations: 'Ra', 'Key': 'Ky', Flashlight: 'Fl',
  Battery: 'Ba', 'Spark Plug': 'Sp', 'Drive Belt': 'Db', Plank: 'Pk',
};

/* ---------------- game state ---------------- */
const CABIN = MAPCFG.cabin;
const CAMPSITE = MAPCFG.campsite;
const BLIND = MAPCFG.blind;
const HOLLOW = MAPCFG.hollow;   // where it sleeps
const HILL = MAPCFG.hill;       // the great hill, and the watch tower on top
const TOWER = { y: 0 };         // platform height, set when the tower is built
/* the generator sits below the hill's foot, ~95m out to the south-west — a
   power line runs down from the tower straight to it. Kept well clear of the
   river: the belt spot sits 13m river-side of it and must stay on dry land. */
const GEN = (() => {
  const dx = -70, dz = 170, d = Math.hypot(dx, dz);
  return { x: Math.round(HILL.x + dx / d * 95), z: Math.round(HILL.z + dz / d * 95) };
})();
const GEN_PARTS = ['Battery', 'Spark Plug', 'Drive Belt'];
/* the bridge's missing plank washed up twenty-odd metres shy of it, beside the path */
const PLANK_SPOT = { x: MAPCFG.riverX - 24, z: MAPCFG.bridgeZ + 2 };
/* where the stripped parts ended up, all within a short search of the machine */
const PART_SPOTS = {
  Battery:      { x: GEN.x - 10, z: GEN.z + 7 },
  'Spark Plug': { x: GEN.x + 9,  z: GEN.z + 8 },
  'Drive Belt': { x: GEN.x - 4,  z: GEN.z - 13 },
};
/* the log shed now stands ACROSS the river, off to the south-east of the crash —
   the only way to it runs over the bridge, so no shed path comes near the crash
   clearing and the cabin walk stays clean and clear */
const SHED = { x: 105, z: 103 }; // east bank, ~50m south-east of the bridge crossing (clear of the generator)
// the door faces back the way you arrive — up toward the bridge you crossed to
// get here — so the doorway is the first thing you see, not a blank log wall
const SHED_ROT = Math.atan2((RIVER_X + 14) - SHED.x, MAPCFG.bridgeZ - SHED.z);

/* the walked trails — defined early so the forest leaves them clear.
   The two paths leave the crash clearing from OPPOSITE sides: the cabin path
   from the west edge, the bridge path from the east edge, with the open ground
   and the wreck between them. So on either path you never sight the other — the
   ring of trees and the fuselage screen the one from the other. */
const TRAIL_A = { x: -15, z: 6 };   // the cabin path's mouth, on the west treeline
const TRAIL_B = cabRot(0, 6.5);
const TRAIL_LEN = Math.hypot(TRAIL_B.x - TRAIL_A.x, TRAIL_B.z - TRAIL_A.z);
const CABIN_MOUTH = { x: -11, z: 5.5 }; // where the cabin path meets the crash clearing; kept clear of trees
const TRAIL_LEGS = [
  // a short connector carries the cabin path right into the crash clearing (up to
  // the wreck) so it no longer just stops dead at the treeline — you can see where
  // it leaves the crash site
  { a: { x: -4, z: 5 }, b: TRAIL_A },
  { a: TRAIL_A, b: TRAIL_B },                                                  // crash (west edge) -> cabin porch
  // the bridge path leaves the EAST edge of the clearing, in two legs so the
  // last stretch arrives square-on to the bridge instead of climbing the bank
  { a: { x: 13, z: -3 }, b: { x: MAPCFG.riverX - 38, z: MAPCFG.bridgeZ - 7 } },
  { a: { x: MAPCFG.riverX - 38, z: MAPCFG.bridgeZ - 7 }, b: { x: MAPCFG.riverX - 14, z: MAPCFG.bridgeZ } },
  // once you cross the bridge there is ONE worn path — no separate trail to the
  // tower. It runs to the shed, then carries on FROM the shed, turns left, and
  // sweeps out east and up north to the watch tower, giving the generator and its
  // scattered parts a wide berth (30m+ of screening trees) so you never sight them.
  { a: { x: MAPCFG.riverX + 14, z: MAPCFG.bridgeZ }, b: SHED },   // bridge -> shed
  { a: SHED, b: { x: 150, z: 112 } },                            // on past the shed, turning left (due east)
  { a: { x: 150, z: 112 }, b: { x: 156, z: 6 } },                // climb north, well east of the generator + parts
  { a: { x: 156, z: 6 }, b: { x: HILL.x - 4, z: HILL.z + 8 } },  // in to the watch tower
];
function legNear(L, x, z, margin) {
  const dx = L.b.x - L.a.x, dz = L.b.z - L.a.z, len = Math.hypot(dx, dz);
  const t = clamp(((x - L.a.x) * dx + (z - L.a.z) * dz) / (dx * dx + dz * dz), 0, 1);
  // matches the ribbon's wander — scaled to the leg, so short legs run true
  const wob = Math.sin(t * 9.2) * Math.min(6, len * 0.035) + Math.sin(t * 23) * Math.min(2.5, len * 0.015);
  const px = L.a.x + dx * t + dz / len * wob;
  const pz = L.a.z + dz * t - dx / len * wob;
  return Math.hypot(x - px, z - pz) < margin;
}
function nearTrail(x, z, margin) {
  for (const L of TRAIL_LEGS) if (legNear(L, x, z, margin)) return true;
  return false;
}
const TRAIL_PERP = { x: (TRAIL_B.z - TRAIL_A.z) / TRAIL_LEN, z: -(TRAIL_B.x - TRAIL_A.x) / TRAIL_LEN };

/* the supply caches are gone — food left the game, and the crates went with it */
const CACHES = [];
/* hand-placed scenes along the walking routes — reasons to look sideways */
const SCENE_SPOTS = (() => {
  const camp = trailPoint(0.35);
  return {
    camp: { x: camp.x + TRAIL_PERP.x * 6, z: camp.z + TRAIL_PERP.z * 6 }, // a cold camp off the cabin trail
    snare: { x: 55, z: -25 },   // a snare line on the way to the bridge
    claws: { x: 180, z: -70 },  // raked trees past the river
    cairn: { x: 230, z: -110 }, // a ranger cairn, knocked over, under the hill
  };
})();

/* rough compass direction of a point, seen from the crash site by default */
function compassWord(p, from) {
  const fx = from ? from.x : 0, fz = from ? from.z : 0;
  const deg = ((Math.atan2(p.x - fx, -(p.z - fz)) * 180 / Math.PI) + 360) % 360;
  const words = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return words[Math.round(deg / 45) % 8];
}

/* you wake between the fire and the wreck, looking back at what is left of the plane */
const SPAWN = (() => {
  const x = FIRE.x * 0.58, z = FIRE.z * 0.58; // a few steps nearer the fuselage, clear of the scattered pages
  return { x, z, yaw: Math.atan2(x, z) }; // yaw faces the wreck at the origin
})();

const state = {
  running: false,
  ended: false,
  dead: false,
  absHours: START_HOUR,       // absolute in-game hours since day-1 00:00
  day: 1,
  health: 100,
  stamina: 15, sprinting: false,
  jumpY: 0, velY: 0,          // jumping and falling
  lastGy: null,               // ground height last frame, for fall detection
  onTower: false,             // standing on the watch tower platform
  wasWet: false, fireT: 0, stepDist: 0,
  torchOn: true,              // the flashlight switch — F flips it while held
  notesRead: [],              // every note found so far — re-readable from the inventory
  gotKit: false,              // the flashlight and map, from the first bag you open
  shakeT: 0,                  // camera shake timer, set by impacts
  held: null,                 // item name currently held in hand
  playSec: 0,                 // real seconds since the run began
  inv: {},
  invOrder: [],               // item types in the order first acquired (drives the hotbar)
  quest: 0,                   // story stage — see QUEST_TEXT
  pieces: 0,                  // map pieces found (0-5)
  generatorOn: false,
  fixT: 0,                    // seconds left on the generator fix, 0 = not fixing
  stoneT: 0,                  // seconds left turning the pale stone over
  climb: null,                // ladder climb in progress: {t, dur, up}
  yaw: SPAWN.yaw, pitch: 0,
  pos: new THREE.Vector3(SPAWN.x, 0, SPAWN.z),
  moving: false,
  nightScheduled: 0,          // last night we generated events for
  eventQueue: [],             // {at: absHours, type:'sil'|'aud'}
  overlayOpen: null,          // 'note' | 'help' | 'inv'
  nextGlimpse: START_HOUR + 1.5, // absHours of the next glimpse
  nextFlock: START_HOUR + 0.7,   // absHours of the next flock crossing the sky
};
function tod() { return ((state.absHours % 24) + 24) % 24; }
/* night falls at the start, and it does not lift. The clock keeps counting the
   hours; the sun simply never answers them. */
function isNight() { return true; }
function nightNumber() {
  // one "night" per 24 hours survived — the escalation clock
  return Math.max(1, Math.floor((state.absHours - NIGHT_START) / 24) + 1);
}

/* ---------------- renderer / scene ---------------- */
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const COARSE = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
/* render at the device's real resolution (capped) — CSS-pixel rendering left
   high-DPI phones and laptops with a quarter of their pixels */
const DPR = Math.min(window.devicePixelRatio || 1, COARSE ? 1.75 : 2);
const ANISO = Math.min(16, renderer.capabilities.getMaxAnisotropy()); // crisp ground/bark at grazing angles
renderer.setSize(innerWidth * PIXEL_SCALE * DPR, innerHeight * PIXEL_SCALE * DPR, false);
/* cast shadows are back — but the map re-renders on a slow cadence in the
   frame loop (the sun only crawls), not every frame, so the old cost doesn't
   return with them; weak GPUs shed them automatically if the frame rate sags */
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x8fa38a, 0.014);
scene.background = new THREE.Color(0x8fa38a);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 400);
camera.rotation.order = 'YXZ';
scene.add(camera); // so the held-item view model can be a camera child

/* Keep the render buffer and camera aspect glued to the real viewport.
   On phones a single resize event is not enough — rotation, fullscreen and
   the browser bars collapsing all report their sizes late, and a stale
   aspect squashes the world (doors shrink, the player seems tall). So this
   is re-checked every frame; the equality test makes that free. */
let vpW = 0, vpH = 0;
function fitViewport() {
  const w = innerWidth, h = innerHeight;
  if (w === vpW && h === vpH) return;
  vpW = w; vpH = h;
  renderer.setSize(w * PIXEL_SCALE * DPR, h * PIXEL_SCALE * DPR, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', fitViewport);
addEventListener('orientationchange', fitViewport);
document.addEventListener('fullscreenchange', fitViewport);
if (window.visualViewport) visualViewport.addEventListener('resize', fitViewport);

const hemi = new THREE.HemisphereLight(0xcfd8c0, 0x2a3324, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffeecc, 0.9);
sun.position.set(60, 80, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(COARSE ? 2048 : 3072, COARSE ? 2048 : 3072); // sharper contact shadows
sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
sun.shadow.camera.near = 20; sun.shadow.camera.far = 220;
sun.shadow.bias = -0.0015;
sun.shadow.normalBias = 0.03; // kills the shadow acne / peter-panning on the logs and ground
scene.add(sun);
scene.add(sun.target);

function mat(color, extra) {
  return new THREE.MeshPhongMaterial(Object.assign({ color, shininess: 0, flatShading: true }, extra || {}));
}
function enableShadows(obj) {
  obj.traverse(o => { if (o.isMesh) { o.castShadow = !(o.material && o.material.transparent); o.receiveShadow = false; } });
}

/* ---------------- procedural textures (canvas — no assets needed) ---------------- */
function makeCanvasTex(size, painter, repeatX, repeatY) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  painter(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.encoding = THREE.sRGBEncoding;
  t.anisotropy = ANISO;
  if (repeatX) t.repeat.set(repeatX, repeatY || repeatX);
  return t;
}
function blotches(c, size, colors, n, rmin, rmax, alpha) {
  for (let i = 0; i < n; i++) {
    c.fillStyle = colors[i % colors.length];
    c.globalAlpha = alpha;
    c.beginPath();
    c.arc(Math.random() * size, Math.random() * size, rmin + Math.random() * (rmax - rmin), 0, 7);
    c.fill();
  }
  c.globalAlpha = 1;
}
const barkTex = makeCanvasTex(128, (c, s) => {
  c.fillStyle = '#c4b49a'; c.fillRect(0, 0, s, s);
  for (let i = 0; i < 46; i++) { // vertical bark streaks
    c.fillStyle = i % 2 ? '#6d5c45' : '#8d7c60';
    c.globalAlpha = 0.35 + Math.random() * 0.3;
    const x = Math.random() * s;
    c.fillRect(x, 0, 1 + Math.random() * 3, s);
  }
  c.globalAlpha = 1;
  blotches(c, s, ['#5a4a36', '#a89878'], 40, 1, 4, 0.4);
}, 2, 1);
const leafTex = makeCanvasTex(256, (c, s) => {
  // shadowed depths first — the dark gaps between leaves
  c.fillStyle = '#4c5c39'; c.fillRect(0, 0, s, s);
  blotches(c, s, ['#37452a', '#425238'], 90, 8, 26, 0.5);
  // then layers of actual leaves, dark to light, the top layer catching the sky.
  // each leaf is drawn at wrapped offsets too, so the tile has no seams
  const layers = [
    ['#5d7244', '#516539', 150, 0.75],
    ['#6d8450', '#617748', 130, 0.8],
    ['#7f9a5e', '#8fae6c', 90, 0.85],
    ['#a7c07e', '#b9d18c', 34, 0.8],
  ];
  for (const [c1, c2, n, al] of layers)
    for (let i = 0; i < n; i++) {
      const x = Math.random() * s, y = Math.random() * s, a = Math.random() * Math.PI;
      const L = 6 + Math.random() * 10, W2 = 2 + Math.random() * 3;
      const col = Math.random() < 0.5 ? c1 : c2;
      for (const [ox, oy] of [[0, 0], [-s, 0], [s, 0], [0, -s], [0, s]]) {
        c.globalAlpha = al;
        c.fillStyle = col;
        c.beginPath();
        c.ellipse(x + ox, y + oy, L, W2, a, 0, 7);
        c.fill();
        c.globalAlpha = al * 0.4;
        c.strokeStyle = '#e6f0cd'; // the pale midrib
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x + ox - Math.cos(a) * L * 0.8, y + oy - Math.sin(a) * L * 0.8);
        c.lineTo(x + ox + Math.cos(a) * L * 0.8, y + oy + Math.sin(a) * L * 0.8);
        c.stroke();
      }
    }
  c.globalAlpha = 1;
}, 3, 3);
const groundTex = makeCanvasTex(256, (c, s) => {
  // fine soil-and-thatch grain — no blobs, nothing for the eye to catch tiling
  c.fillStyle = '#a9af9d'; c.fillRect(0, 0, s, s);
  c.globalAlpha = 0.5;
  for (let i = 0; i < 5200; i++) {
    const sh = 118 + Math.random() * 92 | 0;
    c.fillStyle = `rgb(${sh - 10},${sh},${sh - 24})`;
    c.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 1.6, 1 + Math.random() * 1.6);
  }
  c.globalAlpha = 0.22; // short lying strokes, like grass pressed flat by the rain
  c.lineWidth = 1;
  for (let i = 0; i < 700; i++) {
    const x = Math.random() * s, y = Math.random() * s, a = Math.random() * Math.PI, L = 3 + Math.random() * 5;
    const sh = 100 + Math.random() * 110 | 0;
    c.strokeStyle = `rgb(${sh - 12},${sh},${sh - 26})`;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L);
    c.stroke();
  }
  c.globalAlpha = 1;
}, 48, 48);
const waterTex = makeCanvasTex(256, (c, s) => {
  c.fillStyle = '#a9c3cd'; c.fillRect(0, 0, s, s);
  for (let i = 0; i < 90; i++) { // horizontal ripple strokes
    c.fillStyle = i % 2 ? '#c8dde4' : '#8fabb6';
    c.globalAlpha = 0.3;
    c.fillRect(Math.random() * s, Math.random() * s, 20 + Math.random() * 70, 1 + Math.random() * 2);
  }
  c.globalAlpha = 1;
}, 8, 8);
const moonTex = makeCanvasTex(1024, (c, s) => {
  const cx = s / 2, cy = s / 2, R = s * 0.5;
  // limb-darkened disc, lit from the upper left
  const base = c.createRadialGradient(cx - s * 0.07, cy - s * 0.08, s * 0.06, cx, cy, R);
  base.addColorStop(0, '#f6f6ec');
  base.addColorStop(0.5, '#e8e9e2');
  base.addColorStop(0.8, '#cfd3d8');
  base.addColorStop(1, '#9aa4b4');
  c.fillStyle = base; c.fillRect(0, 0, s, s);
  // large-scale highland mottling so the bright terrain isn't flat
  for (let i = 0; i < 260; i++) {
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * R * 0.95;
    c.fillStyle = i % 2 ? 'rgba(214,218,214,.10)' : 'rgba(176,184,196,.10)';
    c.beginPath();
    c.ellipse(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr,
              s * (0.01 + Math.random() * 0.05), s * (0.01 + Math.random() * 0.05), Math.random() * 3, 0, 7);
    c.fill();
  }
  // the maria, laid out like the real near side (north up):
  // Imbrium, Serenitatis, Tranquillitatis, Fecunditatis, Crisium, Nectaris,
  // Oceanus Procellarum, Humorum, Nubium, Vaporum, and Frigoris across the top
  const seas = [
    [0.38, 0.28, 0.130, 1.00], [0.56, 0.28, 0.090, 1.00], [0.62, 0.40, 0.085, 1.05],
    [0.72, 0.50, 0.065, 1.30], [0.80, 0.33, 0.048, 1.15], [0.64, 0.53, 0.042, 1.00],
    [0.20, 0.40, 0.150, 1.80], [0.28, 0.60, 0.048, 1.00], [0.41, 0.60, 0.065, 1.10],
    [0.47, 0.42, 0.038, 1.00], [0.46, 0.14, 0.150, 0.28],
  ];
  for (const [mx, my, mr, el] of seas)
    for (let i = 0; i < 62; i++) { // each sea is a soft cluster of overlapping basalt blobs
      const a = Math.random() * Math.PI * 2, t = Math.sqrt(Math.random());
      c.fillStyle = i % 3 ? 'rgba(112,124,144,.20)' : 'rgba(92,104,124,.17)';
      c.beginPath();
      c.ellipse(mx * s + Math.cos(a) * t * mr * s, my * s + Math.sin(a) * t * mr * s * el,
                s * (0.015 + Math.random() * 0.035), s * (0.012 + Math.random() * 0.028), Math.random() * 3, 0, 7);
      c.fill();
    }
  // Plato and Grimaldi — the two dark-floored plains
  for (const [px, py, pr] of [[0.40, 0.16, 0.016], [0.10, 0.44, 0.014]]) {
    c.fillStyle = 'rgba(96,108,126,.5)';
    c.beginPath(); c.ellipse(px * s, py * s, pr * s, pr * s * 0.8, 0.3, 0, 7); c.fill();
  }
  // a crater with a shadowed up-sun wall and a sunlit far rim (sun upper-left)
  function crater(x, y, cr, depth) {
    const g1 = c.createRadialGradient(x - cr * 0.25, y - cr * 0.25, cr * 0.1, x, y, cr);
    g1.addColorStop(0, `rgba(88,98,114,${0.5 * depth})`);
    g1.addColorStop(0.75, `rgba(112,122,138,${0.38 * depth})`);
    g1.addColorStop(1, 'rgba(112,122,138,0)');
    c.fillStyle = g1;
    c.beginPath(); c.arc(x, y, cr, 0, 7); c.fill();
    c.strokeStyle = `rgba(64,74,90,${0.55 * depth})`;
    c.lineWidth = Math.max(1, cr * 0.3);
    c.beginPath(); c.arc(x, y, cr * 0.72, Math.PI * 1.25 - 1.0, Math.PI * 1.25 + 1.0); c.stroke();
    c.strokeStyle = `rgba(248,249,242,${0.6 * depth})`;
    c.lineWidth = Math.max(1, cr * 0.18);
    c.beginPath(); c.arc(x, y, cr * 0.92, Math.PI * 0.25 - 1.1, Math.PI * 0.25 + 1.1); c.stroke();
  }
  for (let i = 0; i < 250; i++) {
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * R * 0.9;
    crater(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr,
           s * (0.004 + Math.random() * Math.random() * 0.022), 0.75 + Math.random() * 0.3);
  }
  // the grand old walled plains: Copernicus, Kepler, Theophilus, Cleomedes
  for (const [px, py, pr] of [[0.34, 0.44, 0.022], [0.23, 0.43, 0.013], [0.55, 0.66, 0.020], [0.68, 0.22, 0.016]])
    crater(px * s, py * s, pr * s, 1);
  // Tycho, low on the disc, and the ray system splashed across half the face
  const tx = s * 0.43, ty = s * 0.78;
  c.strokeStyle = 'rgba(250,250,246,.20)';
  for (let i = 0; i < 15; i++) {
    const a = Math.random() * Math.PI * 2;
    const L = s * (0.10 + Math.random() * 0.30);
    c.lineWidth = s * (0.002 + Math.random() * 0.004);
    c.beginPath();
    c.moveTo(tx + Math.cos(a) * s * 0.02, ty + Math.sin(a) * s * 0.02);
    c.lineTo(tx + Math.cos(a) * L, ty + Math.sin(a) * L);
    c.stroke();
  }
  crater(tx, ty, s * 0.014, 1);
  c.fillStyle = 'rgba(252,252,248,.85)';
  c.beginPath(); c.arc(tx, ty, s * 0.010, 0, 7); c.fill();
  // Aristarchus — the brightest point on the moon
  c.fillStyle = 'rgba(255,255,252,.9)';
  c.beginPath(); c.arc(s * 0.19, s * 0.33, s * 0.007, 0, 7); c.fill();
  // fine regolith speckle
  for (let i = 0; i < 3200; i++) {
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * R;
    c.fillStyle = i % 2 ? 'rgba(255,255,255,.06)' : 'rgba(90,100,116,.06)';
    c.fillRect(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 1.6, 1.6);
  }
  // and the hard falloff right at the limb
  const limb = c.createRadialGradient(cx, cy, R * 0.82, cx, cy, R);
  limb.addColorStop(0, 'rgba(40,50,70,0)');
  limb.addColorStop(1, 'rgba(40,50,70,.38)');
  c.fillStyle = limb;
  c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fill();
});
const puffTex = makeCanvasTex(64, (c, s) => {
  // one soft shapeless blob — a single puff of smoke, billboarded
  const g2 = c.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
  g2.addColorStop(0, 'rgba(255,255,255,.5)');
  g2.addColorStop(0.55, 'rgba(255,255,255,.2)');
  g2.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g2; c.fillRect(0, 0, s, s);
});
const flameTex = makeCanvasTex(64, (c, s) => {
  // a single tongue of flame: white-hot heart, orange body, fading skirt
  const g2 = c.createRadialGradient(s / 2, s * 0.6, 2, s / 2, s * 0.55, s * 0.45);
  g2.addColorStop(0, 'rgba(255,244,200,1)');
  g2.addColorStop(0.35, 'rgba(255,170,60,.9)');
  g2.addColorStop(0.7, 'rgba(255,90,20,.45)');
  g2.addColorStop(1, 'rgba(255,60,10,0)');
  c.fillStyle = g2; c.fillRect(0, 0, s, s);
});
/* particle fire: fast-cycling additive tongues that narrow as they rise —
   overlapping, they read as one living flame instead of painted cones */
window._flameJets = [];
function addFlameJet(parent, x, y, z, scale, count) {
  for (let i = 0; i < count; i++) {
    const m = new THREE.SpriteMaterial({
      map: flameTex, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const spr = new THREE.Sprite(m);
    parent.add(spr);
    window._flameJets.push({ spr, m, x, y, z, scale, phase: i / count, speed: 1.1 + Math.random() * 0.5, jx: Math.random() * 6.28 });
  }
}
/* particle smoke: individual puffs that rise, swell and thin out within a couple
   of feet — animated together in the frame loop */
window._smokePuffs = [];
function addSmokePuffs(parent, x, y, z, color, count, size) {
  for (let i = 0; i < count; i++) {
    const m = new THREE.SpriteMaterial({ map: puffTex, color, transparent: true, opacity: 0, depthWrite: false });
    const spr = new THREE.Sprite(m);
    spr.position.set(x, y, z);
    parent.add(spr);
    window._smokePuffs.push({ spr, m, x, y, z, size, phase: i / count, speed: 0.13 + Math.random() * 0.05, sway: Math.random() * 6.28 });
  }
}
const moonHaloTex = makeCanvasTex(256, (c, s) => {
  const g = c.createRadialGradient(s / 2, s / 2, s * 0.1, s / 2, s / 2, s * 0.5);
  g.addColorStop(0, 'rgba(214,226,240,.55)');
  g.addColorStop(0.4, 'rgba(190,206,228,.22)');
  g.addColorStop(1, 'rgba(180,198,224,0)');
  c.fillStyle = g; c.fillRect(0, 0, s, s);
});

/* photoreal CC0 textures (Poly Haven) swap in over the canvas fallbacks — embedded
   as base64 in assets-data.js, because file:// images taint the WebGL canvas */
let groundMatRef = null, rockMatRef = null;
function texURI(key) {
  return window.ASSETS_TEX && ASSETS_TEX[key] ? 'data:image/jpeg;base64,' + ASSETS_TEX[key] : null;
}
function upgradeTex(tex, key, after) {
  const src = texURI(key);
  if (!src) return; // no embedded data — the canvas texture simply stays
  const img = new Image();
  img.onload = () => { tex.image = img; tex.needsUpdate = true; if (after) after(); };
  img.src = src;
}
upgradeTex(barkTex, 'bark');
upgradeTex(leafTex, 'leaves');
// the ground keeps its painted texture — the photo floor read as pale polka
// dots and threw away the terrain's own greens
if (texURI('rock')) {
  const img = new Image();
  img.onload = () => {
    const t = new THREE.Texture(img);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.encoding = THREE.sRGBEncoding;
    t.anisotropy = ANISO;
    t.needsUpdate = true;
    if (rockMatRef) { rockMatRef.map = t; rockMatRef.needsUpdate = true; }
  };
  img.src = texURI('rock');
}

/* wind sway — injected into foliage materials, driven by one shared clock */
const windTime = { value: 0 };
function addWind(material, strength, freq, byHeight) {
  material.onBeforeCompile = shader => {
    shader.uniforms.uTime = windTime;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        vec3 ipos = vec3(0.0);
        #ifdef USE_INSTANCING
          ipos = vec3(instanceMatrix[3].x, instanceMatrix[3].y, instanceMatrix[3].z);
        #endif
        float sway = sin(uTime * ${freq.toFixed(2)} + ipos.x * 0.35 + ipos.z * 0.27);
        float sway2 = cos(uTime * ${(freq * 0.73).toFixed(2)} + ipos.z * 0.31);
        float amt = ${strength.toFixed(3)} * (0.6 + 0.4 * sin(ipos.x * 1.7))${byHeight ? ' * clamp(transformed.y * 1.5, 0.0, 1.6)' : ''};
        // the slow lean of the whole crown, and a quicker shiver through the foliage
        float fl = sin(uTime * ${(freq * 3.9).toFixed(2)} + transformed.y * 2.7 + ipos.x * 1.3 + ipos.z * 0.9) * amt * 0.35;
        transformed.x += sway * amt + fl;
        transformed.z += sway2 * amt * 0.7 - fl * 0.6;
      }`
    );
  };
  material.customProgramCacheKey = () => 'wind' + strength + '_' + freq + '_' + (byHeight ? 'h' : 'u');
}
/* a clump of tapered, outward-bending grass blades — one merged geometry, instanced */
function makeTuftGeometry(blades) {
  // each blade: four rings tapering to a point, arcing over like real grass —
  // dark moss at the root warming to a pale sun-dried tip, each blade a little
  // brighter or duller than its neighbours so a clump reads as many plants
  const pos = [], col = [], idx = [];
  for (let b = 0; b < blades; b++) {
    const ang = (b / blades) * Math.PI * 2 + rng() * 0.7;
    const lean = 0.35 + rng() * 0.6;   // how far the blade arcs outward
    const h = 0.55 + rng() * 0.6;      // blade height
    const w = 0.035 + rng() * 0.028;   // half-width at the base — thinner than before
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const px = -dz, pz = dx;           // perpendicular, for blade width
    const bx = dx * 0.06, bz = dz * 0.06;
    // the arc: barely out at the knee, more at the shoulder, tip bent right over
    const k1x = bx + dx * lean * h * 0.18, k1z = bz + dz * lean * h * 0.18;
    const k2x = bx + dx * lean * h * 0.55, k2z = bz + dz * lean * h * 0.55;
    const tx = bx + dx * lean * h * 1.05, tz = bz + dz * lean * h * 1.05;
    const base = pos.length / 3;
    pos.push(
      bx - px * w, 0, bz - pz * w,
      bx + px * w, 0, bz + pz * w,
      k1x - px * w * 0.75, h * 0.42, k1z - pz * w * 0.75,
      k1x + px * w * 0.75, h * 0.42, k1z + pz * w * 0.75,
      k2x - px * w * 0.4, h * 0.78, k2z - pz * w * 0.4,
      k2x + px * w * 0.4, h * 0.78, k2z + pz * w * 0.4,
      tx, h * 0.98, tz);
    const v = 0.85 + rng() * 0.3; // per-blade brightness
    col.push(
      0.28 * v, 0.36 * v, 0.23 * v, 0.28 * v, 0.36 * v, 0.23 * v,   // root: deep, mossy shade
      0.5 * v, 0.66 * v, 0.38 * v, 0.5 * v, 0.66 * v, 0.38 * v,     // knee: forest green
      0.72 * v, 0.9 * v, 0.5 * v, 0.72 * v, 0.9 * v, 0.5 * v,       // shoulder: lit green
      1.0 * v, 1.05 * v, 0.62 * v);                                  // tip: catching what light there is
    idx.push(
      base, base + 1, base + 2, base + 1, base + 3, base + 2,
      base + 2, base + 3, base + 4, base + 3, base + 5, base + 4,
      base + 4, base + 5, base + 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function jitter(geo, amt) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++)
    p.setXYZ(i, p.getX(i) + (rng() - 0.5) * amt, p.getY(i) + (rng() - 0.5) * amt, p.getZ(i) + (rng() - 0.5) * amt);
  geo.computeVertexNormals();
  return geo;
}
/* a pine bough tier: a cone whose rim sags and frays, so the silhouette reads as
   hanging branches instead of a clean triangle */
function boughCone(r, h, seg, droop, jit) {
  const g = new THREE.ConeGeometry(r, h, seg, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const rad = Math.min(1, Math.hypot(x, z) / r); // 0 at the spine, 1 at the branch tips
    p.setXYZ(i,
      x + (rng() - 0.5) * jit * (0.3 + rad),
      p.getY(i) - droop * rad * rad * h + (rng() - 0.5) * jit,
      z + (rng() - 0.5) * jit * (0.3 + rad));
  }
  g.computeVertexNormals();
  return g;
}

/* flies that circle every carcass — declared early so map props can use them too */
const flyClusters = [];
const fliesMat = new THREE.PointsMaterial({ color: 0x14120e, size: 1.6, sizeAttenuation: false });

/* ---------------- terrain ---------------- */
function baseHeight(x, z) {
  return Math.sin(x * 0.021) * 1.6 + Math.cos(z * 0.024) * 1.6 +
         Math.sin((x + z) * 0.011) * 2.2 +
         Math.sin(x * 0.07) * 0.35 + Math.cos(z * 0.063) * 0.35;
}
function terrainHeight(x, z) {
  let h = baseHeight(x, z);
  h = lerp(h, 0.3, sstep(30, 12, Math.hypot(x, z)) * 0.9);              // crash clearing
  h = lerp(h, -1.6, sstep(RIVER_HALF + 4, 3, Math.abs(x - RIVER_X)));   // river bed
  // the pond needs a shore that stands above its waterline (-0.55) wherever the
  // map puts it — the ground swells into a low bank first, then drops into the bowl
  const pd = Math.hypot(x - POND.x, z - POND.z);
  h = lerp(h, 0.25, sstep(POND.r + 26, POND.r + 6, pd) * 0.95);
  h = lerp(h, -1.6, sstep(POND.r + 4, 5, pd));
  h += 15 * sstep(62, 10, Math.hypot(x - HILL.x, z - HILL.z));          // the great hill
  // a level pad under the shed so its sills sit true
  h = lerp(h, baseHeight(SHED.x, SHED.z), sstep(14, 5, Math.hypot(x - SHED.x, z - SHED.z)));
  // and one under the cabin: it was built on a slope, and where the ground
  // rose toward the porch the whole building stood sunken and short
  h = lerp(h, baseHeight(CABIN.x, CABIN.z), sstep(17, 8, Math.hypot(x - CABIN.x, z - CABIN.z)));
  // the banks open into a broad, gentle saddle where the footbridge crosses —
  // the old narrow notch cut a sheer trench through the bankside hills
  const bApproach = sstep(12, 3, Math.abs(z - MAPCFG.bridgeZ)) * sstep(30, 12, Math.abs(x - MAPCFG.riverX));
  if (bApproach > 0) h = lerp(h, Math.min(h, 0.35), bApproach);
  return h;
}

/* Heightfield sampled exactly like the rendered mesh, triangle for triangle —
   walking uses THIS, so your feet stay on the ground you can see. */
const TSIZE = WORLD * 2 + 40;
const TSEG = Math.min(220, Math.round(TSIZE / 3.4));
const THALF = TSIZE / 2, TSTEP = TSIZE / TSEG, TROW = TSEG + 1;
const HFIELD = new Float32Array(TROW * TROW);
for (let iz = 0; iz <= TSEG; iz++)
  for (let ix = 0; ix <= TSEG; ix++)
    HFIELD[iz * TROW + ix] = terrainHeight(-THALF + ix * TSTEP, -THALF + iz * TSTEP);
function gridHeight(x, z) {
  let fx = clamp((x + THALF) / TSTEP, 0, TSEG - 1e-6);
  let fz = clamp((z + THALF) / TSTEP, 0, TSEG - 1e-6);
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const u = fx - ix, v = fz - iz;
  const ha = HFIELD[iz * TROW + ix], hd = HFIELD[iz * TROW + ix + 1];
  const hb = HFIELD[(iz + 1) * TROW + ix], hc = HFIELD[(iz + 1) * TROW + ix + 1];
  // PlaneGeometry splits each cell along the same diagonal: (a,b,d) then (b,c,d)
  return (u + v < 1)
    ? ha + (hd - ha) * u + (hb - ha) * v
    : hc + (hb - hc) * (1 - u) + (hd - hc) * (1 - v);
}
function inWater(x, z) {
  return Math.abs(x - RIVER_X) < RIVER_HALF || Math.hypot(x - POND.x, z - POND.z) < POND.r;
}
function nearWater(x, z) {
  return Math.abs(x - RIVER_X) < RIVER_HALF + 3.5 || Math.hypot(x - POND.x, z - POND.z) < POND.r + 3.5;
}
/* the little wooden bridge over the river */
const BRIDGE = { z: MAPCFG.bridgeZ, x1: RIVER_X - 13, x2: RIVER_X + 13, deckY: 0.42, halfW: 1.6 };
function onBridge(x, z) {
  return Math.abs(z - BRIDGE.z) < BRIDGE.halfW && x > BRIDGE.x1 - 0.5 && x < BRIDGE.x2 + 0.5;
}
/* the crash gouge is dug into the ground the mud skirt shows — the walkable height
   follows it down into the trench and up over the berms, so feet meet the mud */
const GOUGE = { x: -2.6, z: 1.5, dx: -0.83, dz: 0.55, len: 11.5 };
function gougeRelief(x, z) {
  const cd = Math.hypot(x, z);
  if (cd > 14) return 0;
  const t = clamp((x - GOUGE.x) * GOUGE.dx + (z - GOUGE.z) * GOUGE.dz, 0, GOUGE.len);
  const d = Math.hypot(x - (GOUGE.x + GOUGE.dx * t), z - (GOUGE.z + GOUGE.dz * t));
  let dy = -0.3 * sstep(1.4, 0.3, d) * sstep(11.5, 4, t);           // the trench floor
  dy += 0.34 * Math.exp(-(d - 1.9) * (d - 1.9) * 2.2) * sstep(11.5, 4, t); // shoved-up berms
  return dy * sstep(13.5, 10, cd) + 0.04;
}
function playerGroundY(x, z) {
  // standing on the watch tower platform
  if (state.onTower) {
    if (Math.abs(x - HILL.x) < 2.9 && Math.abs(z - HILL.z) < 2.9) return TOWER.y;
    state.onTower = false; // stepped off the edge — gravity handles the rest
  }
  // stand on the true ground everywhere, the whole game through — your eyes ride
  // a fixed 1.68m above whatever ground you can see, with no artificial floor
  // lifting you above the low terrain. (a -0.75 clamp once lived here and left you
  // floating over the low ground, standing taller than the cabin porch it sat in.)
  const cdx = x - CABIN.x, cdz = z - CABIN.z;
  let g = gridHeight(x, z);
  if (Math.hypot(x, z) < 14) g += gougeRelief(x, z);
  if (onBridge(x, z)) g = Math.max(g, BRIDGE.deckY);
  // inside the cabin you stand on its plank floor, not the uneven dirt it was
  // built over — the floor hangs from the cabin's base height at its centre
  if (Math.abs(cdx) < 8 && Math.abs(cdz) < 8) {
    const c = Math.cos(0.5), s = Math.sin(0.5);
    const lx = cdx * c - cdz * s, lz = cdx * s + cdz * c;
    if (Math.abs(lx) < 5.2 && Math.abs(lz) < 3.95) g = Math.max(g, CABIN_FLOOR_Y);
  }
  return g;
}
const CABIN_FLOOR_Y = gridHeight(CABIN.x, CABIN.z) + 0.17; // the plank floor's walking surface

{
  const geo = new THREE.PlaneGeometry(TSIZE, TSIZE, TSEG, TSEG);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const cMain = new THREE.Color(0x2b3a25), cLight = new THREE.Color(0x34402a),
        cDark = new THREE.Color(0x1e2a18), cMud = new THREE.Color(0x362e20), tmpC = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const h = terrainHeight(x, z);
    p.setY(i, h);
    // mottled greens, muddier near water
    const n = Math.sin(x * 0.13 + z * 0.07) * Math.cos(z * 0.11 - x * 0.05);
    tmpC.copy(cMain).lerp(n > 0 ? cLight : cDark, Math.abs(n) * 0.8);
    tmpC.lerp(cMud, sstep(0.2, -1.2, h));
    colors[i * 3] = tmpC.r; colors[i * 3 + 1] = tmpC.g; colors[i * 3 + 2] = tmpC.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
    vertexColors: true, shininess: 0, flatShading: true, map: groundTex,
  }));
  groundMatRef = ground.material;
  ground.receiveShadow = true;
  scene.add(ground);
}
let waterObj = null, waterGeoRef = null;
{ // water: river strip + pond disc as ONE surface — waves and true reflections
  function mergeGeoms(list) {
    const pos = [], uv = [], idx = [];
    let off = 0;
    for (const g of list) {
      const p = g.attributes.position, u = g.attributes.uv, ix = g.index;
      for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); uv.push(u.getX(i), u.getY(i)); }
      for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + off);
      off += p.count;
    }
    const m = new THREE.BufferGeometry();
    m.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    m.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    m.setIndex(idx);
    m.computeVertexNormals();
    return m;
  }
  // built in plane-local space (x -> world x, y -> world -z), then rotated flat.
  // segmented so the surface can physically bob with waves
  const riverGeo = new THREE.PlaneGeometry(RIVER_HALF * 2 + 2, WORLD * 2 + 40, 3, 140).translate(RIVER_X, 0, 0);
  const pondGeo = new THREE.CircleGeometry(POND.r + 1.5, 24).translate(POND.x, -POND.z, 0);
  const merged = mergeGeoms([riverGeo, pondGeo]);
  waterGeoRef = merged;

  if (THREE.Water) {
    const normals = new THREE.TextureLoader().load(texURI('waternormals') || 'assets/waternormals.jpg', t => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = ANISO;
    });
    waterObj = new THREE.Water(merged, {
      textureWidth: COARSE ? 256 : 512,  // soft, murky reflections — not a mirror
      textureHeight: COARSE ? 256 : 512,
      waterNormals: normals,
      sunDirection: new THREE.Vector3(0.4, 0.8, 0.2),
      sunColor: 0xaab0a4,
      waterColor: 0x13272a,   // black-green, not holiday blue
      distortionScale: 5.5,   // heavy chop breaks the reflection up
      fog: true,
    });
    waterObj.rotation.x = -Math.PI / 2;
    waterObj.position.y = -0.55;
    waterObj.material.uniforms.size.value = 7; // small, busy ripples
    scene.add(waterObj);
  } else {
    // fallback: the old textured surface
    const wmat = new THREE.MeshPhongMaterial({
      color: 0x51707c, map: waterTex, transparent: true, opacity: 0.88,
      shininess: 80, specular: new THREE.Color(0x99aabb),
    });
    const water = new THREE.Mesh(merged, wmat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.55;
    water.receiveShadow = true;
    scene.add(water);
  }
}
/* one plank has rotted out of the bridge mid-span — until it's replaced, the
   gap is too wide to cross, and the river will not be waded */
const bridgeGap = { x: 0, fixed: false, seg: null, mesh: null };
{ // the wooden footbridge
  const g = new THREE.Group();
  const plank = mat(0x5d4a30, { map: barkTex }), plankD = mat(0x4e3d27, { map: barkTex });
  const span = BRIDGE.x2 - BRIDGE.x1;
  const nPlanks = Math.floor(span / 1.3);
  const gapI = Math.floor(nPlanks / 2);
  for (let i = 0; i < nPlanks; i++) {
    if (i === gapI) { // the missing plank: two splintered stubs and open water below
      bridgeGap.x = BRIDGE.x1 + 0.65 + i * (span / nPlanks);
      for (const s of [1, -1]) {
        const stub = new THREE.Mesh(jitter(new THREE.BoxGeometry(1.24, 0.08, 0.5), 0.05), plankD);
        stub.position.set(bridgeGap.x, BRIDGE.deckY - 0.06, BRIDGE.z + s * 1.25);
        stub.rotation.y = (rng() - 0.5) * 0.1;
        g.add(stub);
      }
      // the replacement, invisible until you fit it
      bridgeGap.mesh = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.08, 2.9), mat(0x6e5a3a, { map: barkTex }));
      bridgeGap.mesh.position.set(bridgeGap.x, BRIDGE.deckY - 0.04, BRIDGE.z);
      bridgeGap.mesh.rotation.y = 0.04;
      bridgeGap.mesh.visible = false;
      g.add(bridgeGap.mesh);
      continue;
    }
    const p = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.09, 3.1), i % 2 ? plank : plankD);
    p.position.set(BRIDGE.x1 + 0.65 + i * (span / nPlanks), BRIDGE.deckY - 0.05, BRIDGE.z);
    p.rotation.y = (rng() - 0.5) * 0.03; // old planks, none quite straight
    g.add(p);
  }
  for (const px of [RIVER_X - 10, RIVER_X - 4, RIVER_X + 2, RIVER_X + 8]) { // legs down into the water
    for (const s of [1, -1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 2.4, 6), plankD);
      leg.position.set(px, BRIDGE.deckY - 1.2, BRIDGE.z + s * 1.35);
      g.add(leg);
    }
  }
  for (const s of [1, -1]) { // handrails
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, span, 6), plank);
    rail.rotation.z = Math.PI / 2;
    rail.position.set((BRIDGE.x1 + BRIDGE.x2) / 2, BRIDGE.deckY + 0.95, BRIDGE.z + s * 1.45);
    g.add(rail);
    for (let px = BRIDGE.x1 + 1; px < BRIDGE.x2; px += 3.2) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.0, 0.09), plankD);
      post.position.set(px, BRIDGE.deckY + 0.48, BRIDGE.z + s * 1.45);
      g.add(post);
    }
  }
  // the gap blocks the crossing until the plank goes in (registered with the
  // collision segments once that list exists, below)
  bridgeGap.seg = { x1: bridgeGap.x, z1: BRIDGE.z - 1.7, x2: bridgeGap.x, z2: BRIDGE.z + 1.7, open: false };
  enableShadows(g);
  scene.add(g);
}

/* ---------------- sky: stars + moon ---------------- */
const skyGroup = new THREE.Group();
scene.add(skyGroup);
let starMat, moonMat, moonHaloMat;
{
  const N = 420, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    // stars keep to the high sky — down near the treeline they read as rain
    const a = rng() * Math.PI * 2, e = 0.5 + rng() * 1.0, r = 330;
    pos[i * 3] = Math.cos(a) * Math.cos(e) * r;
    pos[i * 3 + 1] = Math.sin(e) * r;
    pos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starMat = new THREE.PointsMaterial({ color: 0xcdd6e8, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0, fog: false });
  const stars = new THREE.Points(geo, starMat);
  stars.frustumCulled = false;
  skyGroup.add(stars);

  moonMat = new THREE.MeshBasicMaterial({ map: moonTex, transparent: true, opacity: 0, fog: false });
  const moon = new THREE.Mesh(new THREE.CircleGeometry(10, 64), moonMat);
  moon.position.set(-140, 110, -170);
  skyGroup.add(moon);
  // soft atmospheric glow around the disc
  moonHaloMat = new THREE.MeshBasicMaterial({ map: moonHaloTex, transparent: true, opacity: 0, fog: false, depthWrite: false });
  const halo = new THREE.Mesh(new THREE.CircleGeometry(22, 32), moonHaloMat);
  halo.position.z = -1;
  moon.add(halo);
  window._moon = moon;
}
/* faint blue moonlight while the moon is up */
const moonLight = new THREE.DirectionalLight(0x9db4d8, 0);
scene.add(moonLight);
scene.add(moonLight.target);

/* gradient sky dome — blue days, orange sunsets, black nights */
const skyUniforms = {
  topColor: { value: new THREE.Color(0x4f86c2) },
  horizonColor: { value: new THREE.Color(0xaac6d8) },
};
{
  const dome = new THREE.Mesh(new THREE.SphereGeometry(338, 20, 12), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: skyUniforms,
    vertexShader: 'varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 topColor; uniform vec3 horizonColor; varying vec3 vPos;
      void main(){
        float h = normalize(vPos).y;
        float t = smoothstep(-0.05, 0.5, h);
        gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);
      }`,
  }));
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  skyGroup.add(dome);
}

/* drifting low-poly clouds */
const clouds = [];
const cloudMat = new THREE.MeshPhongMaterial({ color: 0xffffff, flatShading: true, fog: false, transparent: true, opacity: 0.92, shininess: 0 });
{
  const puffGeo = jitter(new THREE.IcosahedronGeometry(1, 1), 0.28);
  for (let i = 0; i < 11; i++) {
    const c = new THREE.Group();
    const n = 4 + Math.floor(rng() * 4);
    for (let j = 0; j < n; j++) {
      const puff = new THREE.Mesh(puffGeo, cloudMat);
      // flat undersides, billowing tops
      puff.position.set(j * 4.6 - n * 2.3 + rng() * 3, rng() * rng() * 3.2, rng() * 8 - 4);
      puff.scale.set(4.5 + rng() * 4.5, 1.5 + rng() * 1.3, 3.2 + rng() * 2.4);
      c.add(puff);
    }
    // a big soft core so the cluster reads as one mass
    const core = new THREE.Mesh(puffGeo, cloudMat);
    core.position.set(0, 0.6, 0);
    core.scale.set(n * 2.4, 1.9, 5.2);
    c.add(core);
    c.position.set((rng() * 2 - 1) * 260, 70 + rng() * 40, (rng() * 2 - 1) * 260);
    c.userData.speed = 0.5 + rng() * 0.9;
    skyGroup.add(c);
    clouds.push(c);
  }
}
function updateClouds(dt) {
  for (const c of clouds) {
    c.position.x += c.userData.speed * dt;
    if (c.position.x > 290) c.position.x = -290;
  }
}

/* ---------------- world props ---------------- */
const interactables = [];   // {mesh, type, label, key, pos, data}
const treeData = [];        // {x, z, harvests}
const rockData = [];        // boulders you can chip pebbles from
const logData = [];         // fallen logs you can pull sticks from
const stumpData = [];       // rotten stumps with grubs inside
const wallSegs = [];        // collision segments: {x1,z1,x2,z2,open}
wallSegs.push(bridgeGap.seg); // the missing plank bars the bridge from the start

/* circle colliders (trees, boulders, the wreck…) in a spatial hash */
const colGrid = new Map();
function addCollider(x, z, r) {
  const key = Math.floor(x / 8) + '_' + Math.floor(z / 8);
  let arr = colGrid.get(key);
  if (!arr) colGrid.set(key, arr = []);
  arr.push({ x, z, r });
}
function hitsCollider(x, z) {
  const cx = Math.floor(x / 8), cz = Math.floor(z / 8);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const arr = colGrid.get((cx + i) + '_' + (cz + j));
    if (!arr) continue;
    for (const c of arr) {
      const rr = c.r + 0.33; // player radius
      const dx = x - c.x, dz = z - c.z;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
  }
  return false;
}
function blockedAt(x, z) { return blockedByWalls(x, z) || hitsCollider(x, z); }

function groundY(x, z) { return gridHeight(x, z); }
function placeOK(x, z, clearCrash = true) {
  if (Math.abs(x) > WORLD - 6 || Math.abs(z) > WORLD - 6) return false;
  if (nearWater(x, z)) return false;
  if (clearCrash && Math.hypot(x, z) < 16) return false;
  if (Math.hypot(x - SHELTER.x, z - SHELTER.z) < 7) return false;
  if (Math.hypot(x - CABIN.x, z - CABIN.z) < 13) return false;
  if (Math.hypot(x - CAMPSITE.x, z - CAMPSITE.z) < 9) return false;
  if (Math.hypot(x - BLIND.x, z - BLIND.z) < 6) return false;
  if (Math.hypot(x - HOLLOW.x, z - HOLLOW.z) < 14) return false;
  if (Math.hypot(x - HILL.x, z - HILL.z) < 10) return false;
  if (Math.hypot(x - GEN.x, z - GEN.z) < 8) return false; // the generator's little clearing
  if (Math.hypot(x - SHED.x, z - SHED.z) < 9) return false; // the shed's clearing
  for (const k in PART_SPOTS)
    if (Math.hypot(x - PART_SPOTS[k].x, z - PART_SPOTS[k].z) < 2.6) return false;
  for (const c of CACHES) if (Math.hypot(x - c.x, z - c.z) < 3) return false;
  if (Math.hypot(x - PLANK_SPOT.x, z - PLANK_SPOT.z) < 3) return false;
  for (const k of ['camp', 'snare', 'cairn'])
    if (Math.hypot(x - SCENE_SPOTS[k].x, z - SCENE_SPOTS[k].z) < 5) return false;
  if (nearTrail(x, z, 2.8)) return false; // nothing grows on the walked path
  if (Math.hypot(x - CABIN_MOUTH.x, z - CABIN_MOUTH.z) < 5.5) return false; // clear the cabin path's mouth
  for (const c of MAP_CLEARINGS) if (Math.hypot(x - c.x, z - c.z) < 16) return false;
  return true;
}
const MAP_CLEARINGS = (MAPCFG.props || []).filter(p => p.type === 'clearing');
function scatterPos(clearCrash = true) {
  for (let i = 0; i < 60; i++) {
    const x = (rng() * 2 - 1) * (WORLD - 10), z = (rng() * 2 - 1) * (WORLD - 10);
    if (placeOK(x, z, clearCrash)) return { x, z };
  }
  return { x: 100, z: 100 };
}

/* ---------------- forest (instanced for density) ---------------- */
const instTmp = new THREE.Object3D();
function makeInstanced(geo, count, matParams) {
  const m = new THREE.InstancedMesh(geo,
    new THREE.MeshPhongMaterial(Object.assign({ color: 0xffffff, shininess: 0, flatShading: true }, matParams || {})),
    count);
  m.frustumCulled = false;
  scene.add(m);
  return m;
}
function setInst(mesh, i, x, y, z, rx, ry, rz, sx, sy, sz, color) {
  instTmp.position.set(x, y, z);
  instTmp.rotation.set(rx, ry, rz);
  instTmp.scale.set(sx, sy, sz);
  instTmp.updateMatrix();
  mesh.setMatrixAt(i, instTmp.matrix);
  if (color) mesh.setColorAt(i, color);
}

{
  const greens = [new THREE.Color(0x233720), new THREE.Color(0x2a4226), new THREE.Color(0x1d2f1a),
                  new THREE.Color(0x304a28), new THREE.Color(0x39522e), new THREE.Color(0x28401f)];
  const browns = [new THREE.Color(0x40311f), new THREE.Color(0x4a3724), new THREE.Color(0x362c1c)];

  /* pines */
  const NP = Math.round(950 * DENS);
  const pines = [];
  // a dense stand pressing right up against the crash clearing
  for (let i = 0; i < 110; i++) {
    const a = rng() * Math.PI * 2, r = 12 + rng() * 18;
    const p = { x: Math.cos(a) * r, z: Math.sin(a) * r };
    if (nearWater(p.x, p.z)) continue;
    if (Math.hypot(p.x - FIRE.x, p.z - FIRE.z) < 8) continue;
    if (nearTrail(p.x, p.z, 2.8)) continue; // the stand parts where the path leaves the clearing
    if (Math.hypot(p.x - CABIN_MOUTH.x, p.z - CABIN_MOUTH.z) < 5.5) continue; // open the cabin path's mouth
    pines.push(p);
    treeData.push({ x: p.x, z: p.z, harvests: 3 });
  }
  for (let i = 0; i < NP; i++) {
    const p = scatterPos();
    if (Math.hypot(p.x - FIRE.x, p.z - FIRE.z) < 9) continue;
    pines.push(p);
    treeData.push({ x: p.x, z: p.z, harvests: 3 });
  }
  // overlapping tiers of sagging, ragged boughs over a tapered trunk — the rim of
  // each cone droops like real branches, and no two crowns are quite the same shape
  const pTrunk = makeInstanced(new THREE.CylinderGeometry(0.24, 0.5, 4.2, 6), pines.length, { map: barkTex });
  const pCan1 = makeInstanced(boughCone(3.1, 2.1, 10, 0.55, 0.42), pines.length, { map: leafTex });
  const pCan2 = makeInstanced(boughCone(2.45, 2.0, 10, 0.5, 0.36), pines.length, { map: leafTex });
  const pCan3 = makeInstanced(boughCone(1.8, 1.9, 9, 0.45, 0.3), pines.length, { map: leafTex });
  const pCan4 = makeInstanced(boughCone(1.05, 2.3, 8, 0.38, 0.24), pines.length, { map: leafTex });
  addWind(pCan1.material, 0.09, 1.0, true);
  addWind(pCan2.material, 0.12, 1.15, true);
  addWind(pCan3.material, 0.15, 1.3, true);
  addWind(pCan4.material, 0.18, 1.45, true);
  for (const m of [pTrunk, pCan1, pCan2, pCan3, pCan4]) m.castShadow = true;
  pines.forEach((p, i) => {
    const y = groundY(p.x, p.z);
    const s = 0.75 + rng() * 0.85, sy = s * (1 + rng() * 0.45), ry = rng() * Math.PI * 2;
    const sx = s * (0.82 + rng() * 0.36), sz = s * (0.82 + rng() * 0.36); // crowns squashed off-round
    const lean = (rng() - 0.5) * 0.08; // and none of them grew quite straight
    const g = greens[i % greens.length], b = browns[i % browns.length];
    setInst(pTrunk, i, p.x, y + 2.1 * sy, p.z, 0, ry, lean, s, sy, s, b);
    setInst(pCan1, i, p.x, y + 3.2 * sy, p.z, 0, ry, lean, sx, sy, sz, g);
    setInst(pCan2, i, p.x, y + 4.55 * sy, p.z, lean, ry + 0.5, 0, sx * 0.95, sy, sz * 1.04, g);
    setInst(pCan3, i, p.x, y + 5.85 * sy, p.z, 0, ry + 1.1, -lean, sx * 1.03, sy, sz * 0.94, g);
    setInst(pCan4, i, p.x, y + 7.1 * sy, p.z, lean, ry + 1.7, lean, sx, sy, sz, g);
    addCollider(p.x, p.z, 0.42 * s);
  });

  /* broadleaf trees */
  const NB = Math.round(450 * DENS);
  const broads = [];
  for (let i = 0; i < NB; i++) {
    const p = scatterPos();
    if (Math.hypot(p.x - FIRE.x, p.z - FIRE.z) < 9) continue;
    broads.push(p);
    treeData.push({ x: p.x, z: p.z, harvests: 3 });
  }
  const bTrunk = makeInstanced(new THREE.CylinderGeometry(0.17, 0.38, 3.0, 6), broads.length, { map: barkTex });
  const bCan = makeInstanced(jitter(new THREE.IcosahedronGeometry(1.9, 1), 0.5), broads.length, { map: leafTex });
  const bCan2 = makeInstanced(jitter(new THREE.IcosahedronGeometry(1.25, 1), 0.42), broads.length, { map: leafTex });
  const bCan3 = makeInstanced(jitter(new THREE.IcosahedronGeometry(1.0, 1), 0.36), broads.length, { map: leafTex });
  addWind(bCan.material, 0.11, 0.85);
  addWind(bCan2.material, 0.13, 1.0);
  addWind(bCan3.material, 0.14, 1.1);
  for (const m of [bTrunk, bCan, bCan2, bCan3]) m.castShadow = true;
  broads.forEach((p, i) => {
    const y = groundY(p.x, p.z);
    const s = 0.7 + rng() * 0.7, ry = rng() * Math.PI * 2;
    const g = greens[i % greens.length];
    setInst(bTrunk, i, p.x, y + 1.5 * s, p.z, 0, ry, (rng() - 0.5) * 0.1, s, s, s, browns[(i + 1) % browns.length]);
    // three lumpy blobs, each thrown a little off the trunk line — a full, uneven crown
    setInst(bCan, i, p.x, y + 3.2 * s, p.z, rng() * 0.25, ry, rng() * 0.25, s * (1.1 + rng() * 0.3), s * (0.85 + rng() * 0.25), s * (1.1 + rng() * 0.3), g);
    setInst(bCan2, i, p.x + Math.sin(ry) * 0.8 * s, y + 4.2 * s, p.z + Math.cos(ry) * 0.8 * s, 0, ry * 2, 0.2, s * (0.9 + rng() * 0.25), s * 0.85, s, g);
    setInst(bCan3, i, p.x - Math.sin(ry) * 0.95 * s, y + 3.4 * s, p.z - Math.cos(ry) * 0.95 * s, 0.2, ry, 0, s * 0.95, s * (0.75 + rng() * 0.25), s * 0.95, g);
    addCollider(p.x, p.z, 0.32 * s);
  });

  /* dead trees — bare, pale, wrong */
  const ND = Math.round(110 * DENS);
  const deads = [];
  for (let i = 0; i < ND; i++) {
    const p = scatterPos();
    deads.push(p);
    treeData.push({ x: p.x, z: p.z, harvests: 2 });
  }
  const dGrey = new THREE.Color(0x5c554a), dGrey2 = new THREE.Color(0x4a453c);
  const dTrunk = makeInstanced(new THREE.CylinderGeometry(0.14, 0.28, 4.8, 5), deads.length, { map: barkTex });
  const dBranch = makeInstanced(new THREE.CylinderGeometry(0.04, 0.08, 1.7, 4), deads.length * 2);
  dTrunk.castShadow = dBranch.castShadow = true;
  deads.forEach((p, i) => {
    const y = groundY(p.x, p.z);
    const s = 0.8 + rng() * 0.6, ry = rng() * Math.PI * 2;
    addCollider(p.x, p.z, 0.26 * s);
    setInst(dTrunk, i, p.x, y + 2.4 * s, p.z, 0, ry, rng() * 0.12 - 0.06, s, s, s, i % 2 ? dGrey : dGrey2);
    for (let k = 0; k < 2; k++) {
      const ba = ry + k * 2.4 + rng();
      setInst(dBranch, i * 2 + k,
        p.x + Math.cos(ba) * 0.55 * s, y + (2.6 + k * 0.8) * s, p.z + Math.sin(ba) * 0.55 * s,
        0, ba, 1 + rng() * 0.4, s, s, s, dGrey);
    }
  });
  dTrunk.castShadow = dBranch.castShadow = true;

  /* undergrowth: ferns, grass, rocks, fallen logs, stumps */
  const NF = Math.round(620 * DENS);
  const fern = makeInstanced(jitter(new THREE.IcosahedronGeometry(0.5, 1), 0.18), NF, { map: leafTex });
  addWind(fern.material, 0.05, 1.7);
  for (let i = 0; i < NF; i++) {
    const p = scatterPos();
    const s = 0.7 + rng() * 0.9;
    setInst(fern, i, p.x, groundY(p.x, p.z) + 0.22 * s, p.z, 0, rng() * 3, 0, s, s * 0.5, s, greens[i % greens.length]);
  }
  // grass — real multi-blade tufts, taller in the meadow patches
  const TALL_GRASS = MAPCFG.tallGrass;
  const NG = Math.round(2800 * DENS);
  const grass = makeInstanced(makeTuftGeometry(14), NG, {
    side: THREE.DoubleSide, vertexColors: true, flatShading: false,
  });
  addWind(grass.material, 0.12, 2.1, true); // tips sway, roots stay planted
  const gCols = [ // deeper forest greens
    new THREE.Color(0x33452a), new THREE.Color(0x3b4f2e), new THREE.Color(0x445634),
    new THREE.Color(0x4c5830), new THREE.Color(0x2c3a1c), new THREE.Color(0x515431),
  ];
  for (let i = 0; i < NG; i++) {
    let p = scatterPos(false);
    if (Math.hypot(p.x - FIRE.x, p.z - FIRE.z) < 3) p = scatterPos();
    let s = 0.6 + rng() * 0.9;
    for (const tg of TALL_GRASS)
      if (Math.hypot(p.x - tg.x, p.z - tg.z) < 14) s *= 1.9 + rng() * 0.6; // waist-high meadow patches
    setInst(grass, i, p.x, groundY(p.x, p.z) + 0.01, p.z, 0, rng() * Math.PI * 2, 0,
      0.9 + rng() * 0.6, s, 0.9 + rng() * 0.6, gCols[i % gCols.length]);
  }
  const NR = Math.round(90 * DENS);
  const rock = makeInstanced(new THREE.DodecahedronGeometry(0.45), NR);
  rockMatRef = rock.material;
  const rCol = new THREE.Color(0x6f6f6f), rCol2 = new THREE.Color(0x7d7a72);
  for (let i = 0; i < NR; i++) {
    const p = scatterPos();
    const s = 0.5 + rng() * 1.2;
    setInst(rock, i, p.x, groundY(p.x, p.z) + 0.18 * s, p.z, rng() * 3, rng() * 3, 0, s, s * 0.8, s, i % 2 ? rCol : rCol2);
    if (s > 0.8) {
      rockData.push({ x: p.x, z: p.z, charges: 2 }); // only the bigger boulders
      addCollider(p.x, p.z, 0.42 * s);
    }
  }
  const NL = Math.round(50 * DENS);
  const log = makeInstanced(new THREE.CylinderGeometry(0.18, 0.23, 2.4, 6), NL);
  const lCol = new THREE.Color(0x4c3d2a), lCol2 = new THREE.Color(0x55462f);
  for (let i = 0; i < NL; i++) {
    const p = scatterPos();
    setInst(log, i, p.x, groundY(p.x, p.z) + 0.2, p.z, 0, rng() * Math.PI * 2, Math.PI / 2, 1, 1, 1, i % 2 ? lCol : lCol2);
    logData.push({ x: p.x, z: p.z, charges: 2 });
  }
  const NS = Math.round(36 * DENS);
  const stump = makeInstanced(new THREE.CylinderGeometry(0.28, 0.4, 0.5, 7), NS);
  for (let i = 0; i < NS; i++) {
    const p = scatterPos();
    setInst(stump, i, p.x, groundY(p.x, p.z) + 0.25, p.z, 0, rng() * 3, 0, 1, 1, 1, browns[i % browns.length]);
    stumpData.push({ x: p.x, z: p.z, charges: 1 });
  }
  rock.castShadow = log.castShadow = stump.castShadow = true;
}

/* crash site — a small high-wing prop plane, broken up where it came down */
{
  // weathered aluminium skin for the fuselage: red trim stripes down both flanks
  // (u = 0 and u = 0.5 face the sides), panel joins ringed with rivets, grime
  const hullTex = makeCanvasTex(256, (c, s) => {
    c.fillStyle = '#d9d6c9'; c.fillRect(0, 0, s, s);
    blotches(c, s, ['#cfccbf', '#e3e0d4', '#c6c3b5'], 90, 6, 24, 0.25);
    c.fillStyle = '#8c2f2f';
    c.fillRect(0, 0, 9, s); c.fillRect(s - 9, 0, 9, s); c.fillRect(s / 2 - 9, 0, 18, s);
    c.fillStyle = '#5f1f1f';
    for (const x of [9, s - 11, s / 2 - 11, s / 2 + 9]) c.fillRect(x, 0, 2, s);
    c.strokeStyle = '#9a978a'; c.lineWidth = 1; c.globalAlpha = 0.55;
    for (const yy of [34, 86, 138, 190, 232]) { c.beginPath(); c.moveTo(0, yy); c.lineTo(s, yy); c.stroke(); }
    c.globalAlpha = 0.8; c.fillStyle = '#8a877b';
    for (const yy of [34, 86, 138, 190, 232])
      for (let x = 4; x < s; x += 7) c.fillRect(x, yy - 3, 1.5, 1.5);
    c.globalAlpha = 0.3; // grime streaking back with the airflow
    for (let i = 0; i < 46; i++) {
      c.fillStyle = i % 3 ? '#7a746a' : '#4f4a43';
      c.fillRect(Math.random() * s, Math.random() * s, 1.5 + Math.random() * 3, 10 + Math.random() * 44);
    }
    c.globalAlpha = 1;
    // mud thrown up the lower flanks where it ploughed in (the belly wraps at x ≈ s/4)
    for (let i = 0; i < 90; i++) {
      const spread = Math.random() * Math.random(); // most of it stays low
      const x = s * 0.25 + (Math.random() < 0.5 ? -1 : 1) * spread * s * 0.21;
      c.fillStyle = i % 3 ? 'rgba(74,58,37,.5)' : (i % 3 === 1 ? 'rgba(56,43,25,.55)' : 'rgba(87,69,44,.4)');
      c.beginPath();
      c.ellipse(x, Math.random() * s, 2 + Math.random() * 7, 1.5 + Math.random() * 4, Math.random() * 3, 0, 7);
      c.fill();
    }
    for (let i = 0; i < 16; i++) { // a few splatter flecks reach higher
      c.fillStyle = 'rgba(66,51,31,.45)';
      c.beginPath();
      c.arc(s * 0.25 + (Math.random() - 0.5) * s * 0.62, Math.random() * s, 1 + Math.random() * 2.5, 0, 7);
      c.fill();
    }
  });
  const hull = new THREE.MeshPhongMaterial({ color: 0xffffff, map: hullTex, shininess: 26 }),
        hullPlain = mat(0xd8d5c8, { flatShading: false, shininess: 20 }),
        stripe = mat(0x8c2f2f, { flatShading: false }),
        glass = new THREE.MeshPhongMaterial({ color: 0x20292e, shininess: 110, specular: 0x8899aa }),
        frameM = mat(0x43494e, { flatShading: false }),
        metal = mat(0x71787e, { flatShading: false, shininess: 40 }),
        rubber = mat(0x1b1b1b);
  const g = new THREE.Group();

  // the plane itself, nose along +X, then yawed to face up the gouge
  const plane = new THREE.Group();
  // fuselage built from tapered sections so it actually reads as an airframe:
  // blunt nose bowl, cowl, cabin, then a long taper away to the tail cone
  const RSEG = 16, AXIS = 1.1;
  function tube(rFwd, rAft, len, cx, m) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(rFwd, rAft, len, RSEG), m || hull);
    t.rotation.z = -Math.PI / 2;
    t.position.set(cx, AXIS, 0);
    plane.add(t);
    return t;
  }
  tube(0.34, 0.14, 0.7, -3.6);   // tail cone
  tube(1.02, 0.34, 3.7, -1.45);  // aft fuselage, tapering away to the tail
  tube(1.06, 1.02, 2.5, 1.65);   // cabin section
  tube(0.92, 1.06, 1.15, 3.48);  // engine cowl
  const noseBowl = new THREE.Mesh(new THREE.SphereGeometry(0.92, RSEG, 10), hullPlain);
  noseBowl.scale.set(0.55, 1, 1);
  noseBowl.position.set(4.06, AXIS, 0);
  plane.add(noseBowl);
  // cowl lip, chin intake, soot-stained exhaust stubs
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.88, 0.06, 6, RSEG), metal);
  lip.rotation.y = Math.PI / 2;
  lip.position.set(4.05, AXIS, 0);
  plane.add(lip);
  const intake = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.28, 0.55), frameM);
  intake.position.set(4.15, 0.25, 0);
  plane.add(intake);
  for (const s of [1, -1]) {
    const exh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.4, 6), mat(0x35322e));
    exh.rotation.x = s * 1.2;
    exh.position.set(3.2, 0.4, s * 0.8);
    plane.add(exh);
  }
  // spinner and the propeller, both blades folded back by the impact
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.55, 10), metal);
  spinner.rotation.z = -Math.PI / 2;
  spinner.position.set(4.75, AXIS, 0);
  plane.add(spinner);
  for (const s of [1, -1]) {
    const root = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.85, 0.26), metal);
    root.position.set(4.62, AXIS + s * 0.4, s * 0.05);
    root.rotation.x = s * 0.2; root.rotation.z = s * 0.18;
    plane.add(root);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.8, 0.22), metal);
    tip.position.set(4.32, AXIS + s * 0.95, s * 0.22);
    tip.rotation.set(s * 0.55, 0, s * 1.05);
    plane.add(tip);
  }
  // raked two-pane windshield wrapping a centre pillar
  for (const s of [1, -1]) {
    const pane = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.66, 0.6), glass);
    pane.position.set(2.62, 1.92, s * 0.33);
    pane.rotation.z = -0.52;
    pane.rotation.y = s * 0.24;
    plane.add(pane);
  }
  const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.07, 0.07), frameM);
  pillar.position.set(2.62, 1.94, 0);
  pillar.rotation.z = -0.52;
  plane.add(pillar);
  // cabin windows, three a side — rounded-corner portholes like the real thing,
  // each in a raised rounded surround rather than a boxy frame
  function roundedRect(w, h, r) {
    const s2 = new THREE.Shape();
    const x0 = -w / 2, y0 = -h / 2;
    s2.moveTo(x0 + r, y0);
    s2.lineTo(x0 + w - r, y0); s2.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
    s2.lineTo(x0 + w, y0 + h - r); s2.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
    s2.lineTo(x0 + r, y0 + h); s2.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
    s2.lineTo(x0, y0 + r); s2.quadraticCurveTo(x0, y0, x0 + r, y0);
    return s2;
  }
  const surround = roundedRect(0.64, 0.48, 0.2);
  surround.holes.push(roundedRect(0.5, 0.34, 0.15));
  const winFrameGeo = new THREE.ExtrudeGeometry(surround, { depth: 0.05, bevelEnabled: false });
  const winGlassGeo = new THREE.ShapeGeometry(roundedRect(0.52, 0.36, 0.16));
  for (const s of [1, -1]) {
    for (let i = 0; i < 3; i++) {
      const fx = 2.0 - i * 0.85;
      const frame = new THREE.Mesh(winFrameGeo, frameM);
      frame.position.set(fx, 1.52, s * 1.0);
      if (s < 0) frame.rotation.y = Math.PI;
      plane.add(frame);
      const win = new THREE.Mesh(winGlassGeo, glass);
      win.position.set(fx, 1.52, s * 1.03);
      if (s < 0) win.rotation.y = Math.PI;
      plane.add(win);
    }
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.6, 0.44), mat(0x5a3c34));
    seat.position.set(1.5, 1.25, s * 0.45);
    plane.add(seat);
  }
  const dash = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.45, 1.3), mat(0x22262a));
  dash.position.set(2.5, 1.45, 0);
  plane.add(dash);
  // high wing: port panels still on, drooping at the break; starboard torn away
  const wingIn = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.16, 2.5), hullPlain);
  wingIn.position.set(0.75, 2.24, -1.3);
  wingIn.rotation.x = -0.06;
  plane.add(wingIn);
  const wingOut = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.13, 2.4), hullPlain);
  wingOut.position.set(0.72, 2.0, -3.55);
  wingOut.rotation.x = -0.2;
  plane.add(wingOut);
  const tipCap = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.14, 0.3), stripe);
  tipCap.position.set(0.72, 1.78, -4.72);
  tipCap.rotation.x = -0.2;
  plane.add(tipCap);
  const aileron = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.08, 1.5), hullPlain);
  aileron.position.set(-0.32, 1.9, -3.6);
  aileron.rotation.set(-0.2, 0, 0.55); // hanging off its broken linkage
  plane.add(aileron);
  // one strut holding, its partner snapped mid-span
  const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.0, 6), metal);
  strut.position.set(1.35, 1.45, -1.35);
  strut.rotation.x = 0.8;
  plane.add(strut);
  const strutSnap = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.0, 6), metal);
  strutSnap.position.set(0.35, 1.85, -1.7);
  strutSnap.rotation.set(0.8, 0, 0.4);
  plane.add(strutSnap);
  // torn starboard stub with the main spar showing
  const wingStub = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.16, 0.9), hullPlain);
  wingStub.position.set(0.75, 2.24, 0.8);
  wingStub.rotation.z = 0.1;
  plane.add(wingStub);
  const spar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.55), metal);
  spar.position.set(0.9, 2.26, 1.4);
  spar.rotation.y = 0.3;
  plane.add(spar);
  // tail: swept fin, rudder knocked askew, one stabiliser kicked up hard
  const fin = new THREE.Mesh(new THREE.BoxGeometry(1.25, 1.7, 0.12), hullPlain);
  fin.position.set(-3.2, 2.15, 0);
  fin.rotation.z = 0.28;
  plane.add(fin);
  const finTip = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.3, 0.13), stripe);
  finTip.position.set(-3.44, 2.94, 0);
  finTip.rotation.z = 0.28;
  plane.add(finTip);
  const rudder = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.5, 0.1), hullPlain);
  rudder.position.set(-4.05, 1.95, 0.12);
  rudder.rotation.set(0.12, 0.35, 0.2);
  plane.add(rudder);
  for (const s of [1, -1]) {
    const stab = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.1, 1.5), hullPlain);
    stab.position.set(-3.35, 1.55 + (s > 0 ? 0.3 : 0), s * 0.85);
    stab.rotation.x = s > 0 ? 0.55 : 0.08;
    plane.add(stab);
  }
  // cabin door hanging open off its lower hinge, window still in it
  const door = new THREE.Group();
  const dpanel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.05, 0.72), hullPlain);
  dpanel.position.y = -0.5;
  door.add(dpanel);
  const dwin = new THREE.Mesh(new THREE.ShapeGeometry(roundedRect(0.5, 0.38, 0.15)), glass);
  dwin.position.set(0.045, -0.35, 0);
  dwin.rotation.y = Math.PI / 2;
  door.add(dwin);
  const dhandle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.16), frameM);
  dhandle.position.set(0.05, -0.75, 0.24);
  door.add(dhandle);
  door.position.set(1.15, 1.3, 1.02);
  door.rotation.x = 0.9;
  plane.add(door);
  // landing gear: port leg splayed with its wheel, starboard sheared to a stump
  const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.9, 6), metal);
  legL.position.set(1.35, 0.5, -0.85);
  legL.rotation.x = -0.9;
  plane.add(legL);
  const wheelL = new THREE.Group();
  wheelL.add(new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.16, 12), rubber));
  wheelL.add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.18, 8), metal));
  wheelL.rotation.set(Math.PI / 2, 0, 0.15);
  wheelL.position.set(1.4, 0.28, -1.22);
  plane.add(wheelL);
  const legR = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.45, 6), metal);
  legR.position.set(1.3, 0.65, 0.6);
  legR.rotation.x = 1.2;
  plane.add(legR);
  const tailWheel = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 8), rubber);
  tailWheel.rotation.x = Math.PI / 2;
  tailWheel.position.set(-3.45, 0.35, 0.1);
  plane.add(tailWheel);
  // skin torn open aft of the door, petals of metal peeled outward
  const tear = new THREE.Mesh(new THREE.CircleGeometry(0.5, 12), new THREE.MeshBasicMaterial({ color: 0x0a0a0a }));
  tear.scale.set(1.25, 0.6, 1);
  tear.position.set(0.42, 1.2, 1.045);
  plane.add(tear);
  for (let i = 0; i < 5; i++) {
    const a = i / 5 * Math.PI * 2 + 0.4;
    const petal = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.32, 4), hullPlain);
    petal.position.set(0.42 + Math.cos(a) * 0.55, 1.2 + Math.sin(a) * 0.33, 1.06);
    petal.rotation.set(Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9);
    petal.scale.z = 0.4;
    plane.add(petal);
  }
  // the airframe shows through the tear: two ribs, and wiring dragged out of the wall
  for (let i = 0; i < 2; i++) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(0.4 - i * 0.08, 0.02, 5, 10, Math.PI * 0.75), metal);
    rib.position.set(0.22 + i * 0.4, 1.15, 0.98);
    rib.rotation.y = Math.PI / 2;
    rib.rotation.z = 0.9;
    plane.add(rib);
  }
  for (let i = 0; i < 4; i++) { // harness wires hanging dead out of the skin
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.45 + i * 0.14, 3),
      i === 1 ? mat(0x7a2a22) : (i === 2 ? mat(0x8a7a3a) : rubber));
    w.position.set(0.18 + i * 0.15, 0.92 - i * 0.05, 1.09);
    w.rotation.x = 0.2 + i * 0.15;
    w.rotation.z = (i - 1.5) * 0.28;
    plane.add(w);
  }
  // cockpit: an instrument panel face and both control yokes, left as they were
  const gaugesTex = makeCanvasTex(64, (c, s) => {
    c.fillStyle = '#181b1e'; c.fillRect(0, 0, s, s);
    for (let i = 0; i < 6; i++) {
      const gx3 = 10 + (i % 3) * 21, gy3 = 18 + Math.floor(i / 3) * 26;
      c.fillStyle = '#0b0d0f';
      c.beginPath(); c.arc(gx3, gy3, 8, 0, 7); c.fill();
      c.strokeStyle = '#b8b4a2'; c.lineWidth = 1;
      c.beginPath(); c.arc(gx3, gy3, 8, 0, 7); c.stroke();
      c.beginPath(); c.moveTo(gx3, gy3); // needles dead where the power died
      c.lineTo(gx3 + Math.cos(2 + i) * 6, gy3 + Math.sin(2 + i) * 6); c.stroke();
    }
  });
  const gauges = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 1.15), new THREE.MeshBasicMaterial({ map: gaugesTex }));
  gauges.position.set(2.34, 1.5, 0);
  gauges.rotation.y = -Math.PI / 2;
  gauges.rotation.z = Math.PI / 2;
  plane.add(gauges);
  for (const s of [1, -1]) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.3, 5), frameM);
    col.position.set(2.28, 1.33, s * 0.45);
    col.rotation.z = 0.7;
    plane.add(col);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.014, 5, 12, Math.PI * 1.35), frameM);
    wheel.position.set(2.17, 1.42, s * 0.45);
    wheel.rotation.y = Math.PI / 2;
    wheel.rotation.z = Math.PI - 0.85;
    plane.add(wheel);
  }
  // torn skin thrown across the clearing — bright metal, some of it striped
  for (let i = 0; i < 12; i++) {
    const shard = new THREE.Mesh(
      jitter(new THREE.BoxGeometry(0.18 + rng() * 0.4, 0.015, 0.1 + rng() * 0.28), 0.03),
      i % 4 ? hullPlain : stripe);
    const a = rng() * Math.PI * 2, d = 2.5 + rng() * 7;
    shard.position.set(Math.cos(a) * d, 0.05 + rng() * 0.05, Math.sin(a) * d);
    shard.rotation.set((rng() - 0.5) * 0.7, rng() * Math.PI, (rng() - 0.5) * 0.7);
    plane.add(shard);
  }
  // aerial mast on the cabin roof, its wire still run back to the fin
  const aerial = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.022, 0.85, 4), metal);
  aerial.position.set(1.0, 2.55, 0);
  aerial.rotation.z = 0.3;
  plane.add(aerial);
  const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 4.5, 3), rubber);
  wire.position.set(-1.15, 2.93, 0);
  wire.rotation.z = 1.57;
  plane.add(wire);
  // registration decals on the fin
  const regTex = makeCanvasTex(128, (c, s) => {
    c.clearRect(0, 0, s, s);
    c.fillStyle = '#2f353a';
    c.font = 'bold 30px monospace';
    c.textAlign = 'center';
    c.fillText('N3417K', s / 2, s / 2 + 10);
  });
  const regMat = new THREE.MeshBasicMaterial({ map: regTex, transparent: true });
  for (const s of [1, -1]) {
    const reg = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), regMat);
    reg.position.set(-3.24, 2.12, s * 0.08);
    reg.rotation.y = s > 0 ? 0 : Math.PI;
    reg.rotation.z = s * 0.28; // sits flush on the swept fin
    plane.add(reg);
  }
  // mud caked on where it ploughed in — low on the flanks, the nose bowl, the gear
  const clumpM = [mat(0x4a3a25), mat(0x382b19)];
  const CLUMPS = [
    [3.9, 0.5, 0.55, 0.16], [4.3, 0.55, -0.4, 0.13], [4.45, 0.35, 0.1, 0.18], // nose, dug in hardest
    [2.4, 0.35, 0.9, 0.13], [1.1, 0.3, -0.95, 0.12], [0.1, 0.4, 0.85, 0.11],
    [-1.2, 0.35, -0.6, 0.1], [1.45, 0.25, -1.2, 0.1],
  ];
  CLUMPS.forEach(([mx, my, mz, mr], i) => {
    const clump = new THREE.Mesh(jitter(new THREE.IcosahedronGeometry(mr, 0), mr * 0.5), clumpM[i % 2]);
    clump.scale.set(1.3, 0.7, 1.1);
    clump.position.set(mx, my, mz);
    clump.rotation.set(rng() * 3, rng() * 3, 0);
    plane.add(clump);
  });
  // the engine is still burning — a low, stubborn fire in the smashed cowl,
  // black oil smoke where the campfire's is pale
  {
    addFlameJet(plane, 3.72, 1.5, 0.15, 0.6, 8);
    addSmokePuffs(plane, 3.72, 2.3, 0.15, 0x3a3833, 5, 0.5); // oily and dark
    const pl = new THREE.PointLight(0xff8830, 0.85, 12, 1.8);
    pl.position.set(3.8, 1.9, 0);
    plane.add(pl);
    window._planeFire = { light: pl };
  }
  plane.rotation.y = 0.45;
  plane.rotation.z = -0.06;
  g.add(plane);

  /* -- the ground it tore up: a conforming skirt of churned mud with a real
        trench dug along the slide, berms shoved up either side, scorched earth
        baked in around the wreck, and a ragged rim that melts into the grass -- */
  const mudTex = makeCanvasTex(1024, (c, s) => {
    c.fillStyle = '#3a2e1e'; c.fillRect(0, 0, s, s);
    blotches(c, s, ['#4a3a25', '#2b2214', '#57452c', '#332816'], 2600, 3, 16, 0.4);
    blotches(c, s, ['#241c11', '#5f4c31'], 1600, 1, 4, 0.5);
    // drag striations running with the gouge
    c.save(); c.translate(s / 2, s / 2); c.rotate(2.69);
    c.globalAlpha = 0.3;
    for (let i = 0; i < 200; i++) {
      c.fillStyle = i % 2 ? '#221a10' : '#5d4a2f';
      c.fillRect(-s / 2 + Math.random() * s, -s / 2 + Math.random() * s, 30 + Math.random() * 120, 2 + Math.random() * 3);
    }
    c.restore(); c.globalAlpha = 1;
    blotches(c, s, ['#1d1710', '#181310'], 90, 4, 10, 0.5); // wet pockets
    // scorched ground where it finally stopped, densest at the centre
    c.globalAlpha = 0.5;
    for (let i = 0; i < 260; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * Math.random() * s * 0.24;
      c.fillStyle = i % 3 ? '#26211a' : '#1b1713';
      c.beginPath(); c.arc(s / 2 + 6 + Math.cos(a) * r, s / 2 + Math.sin(a) * r, 4 + Math.random() * 14, 0, 7);
      c.fill();
    }
    c.globalAlpha = 1;
    // drying cracks — a wandering web of dark seams
    c.strokeStyle = 'rgba(20,15,9,.45)';
    for (let i = 0; i < 70; i++) {
      let x = Math.random() * s, y = Math.random() * s, a = Math.random() * Math.PI * 2;
      c.lineWidth = 1 + Math.random() * 1.5;
      c.beginPath(); c.moveTo(x, y);
      for (let k = 0, n = 4 + Math.random() * 5; k < n; k++) {
        a += (Math.random() - 0.5) * 1.2;
        x += Math.cos(a) * (8 + Math.random() * 18);
        y += Math.sin(a) * (8 + Math.random() * 18);
        c.lineTo(x, y);
      }
      c.stroke();
    }
    // pale glints where the churn stands proud and catches light
    c.globalAlpha = 0.25;
    for (let i = 0; i < 800; i++) {
      c.fillStyle = i % 2 ? '#8a7350' : '#6e5a3d';
      c.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1);
    }
    // and a fine gritty grain over all of it
    c.globalAlpha = 1;
    for (let i = 0; i < 4200; i++) {
      c.fillStyle = i % 2 ? 'rgba(0,0,0,.12)' : 'rgba(150,125,90,.10)';
      c.fillRect(Math.random() * s, Math.random() * s, 1.4, 1.4);
    }
    // fade to nothing at a ragged rim
    const fadeG = c.createRadialGradient(s / 2, s / 2, s * 0.28, s / 2, s / 2, s * 0.5);
    fadeG.addColorStop(0, 'rgba(0,0,0,1)');
    fadeG.addColorStop(0.7, 'rgba(0,0,0,0.85)');
    fadeG.addColorStop(1, 'rgba(0,0,0,0)');
    c.globalCompositeOperation = 'destination-in';
    c.fillStyle = fadeG; c.fillRect(0, 0, s, s);
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2, r = s * (0.34 + Math.random() * 0.17);
      c.globalAlpha = 0.4 + Math.random() * 0.6;
      c.beginPath(); c.arc(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r, 6 + Math.random() * 20, 0, 7);
      c.fill();
    }
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  });
  // the trench runs back from the tail, up the slide it came in on
  const TRAIL = { x: -2.6, z: 1.5, dx: -0.83, dz: 0.55, len: 11.5 };
  const bermAt = (d, t) => 0.34 * Math.exp(-(d - 1.9) * (d - 1.9) * 2.2) * sstep(11.5, 4, t);
  const PR = 14;
  const mudGeo = new THREE.PlaneGeometry(PR * 2, PR * 2, 36, 36);
  mudGeo.rotateX(-Math.PI / 2);
  const mv = mudGeo.attributes.position;
  for (let i = 0; i < mv.count; i++) {
    const vx = mv.getX(i), vz = mv.getZ(i);
    const t = clamp((vx - TRAIL.x) * TRAIL.dx + (vz - TRAIL.z) * TRAIL.dz, 0, TRAIL.len);
    const d = Math.hypot(vx - (TRAIL.x + TRAIL.dx * t), vz - (TRAIL.z + TRAIL.dz * t));
    let dy = -0.3 * sstep(1.4, 0.3, d) * sstep(11.5, 4, t);              // the trench floor
    dy += bermAt(d, t);                                                  // shoved-up berms
    dy += (rng() - 0.5) * 0.09;                                          // churn everywhere else
    mv.setY(i, groundY(vx, vz) + 0.04 + dy * sstep(PR - 0.5, PR - 4, Math.hypot(vx, vz)));
  }
  mudGeo.computeVertexNormals();
  const mud = new THREE.Mesh(mudGeo, new THREE.MeshPhongMaterial({
    color: 0xffffff, map: mudTex, transparent: true, shininess: 26, flatShading: true, depthWrite: false,
  }));
  mud.receiveShadow = true;
  scene.add(mud);
  // clods and torn sod thrown along the berms
  const clodMats = [mat(0x4a3a25), mat(0x382b19), mat(0x55432c)];
  for (let i = 0; i < 26; i++) {
    const t = rng() * TRAIL.len, side = rng() < 0.5 ? -1 : 1, off = 1.2 + rng() * 2.6;
    const cx = TRAIL.x + TRAIL.dx * t - TRAIL.dz * side * off;
    const cz = TRAIL.z + TRAIL.dz * t + TRAIL.dx * side * off;
    const r = 0.09 + rng() * 0.2;
    const clod = new THREE.Mesh(jitter(new THREE.DodecahedronGeometry(r), r * 0.5), clodMats[i % 3]);
    clod.position.set(cx, groundY(cx, cz) + 0.04 + bermAt(off, t) + r * 0.4, cz);
    clod.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    clod.castShadow = true;
    scene.add(clod);
  }
  // standing water pooled in the trench, catching the light
  const puddleM = mat(0x14110c, { flatShading: false, shininess: 120, specular: 0x445566 });
  for (const pt of [2.2, 4.6, 7.4]) {
    const px = TRAIL.x + TRAIL.dx * pt, pz = TRAIL.z + TRAIL.dz * pt;
    const pud = new THREE.Mesh(new THREE.CircleGeometry(0.5 + rng() * 0.4, 10), puddleM);
    pud.rotation.x = -Math.PI / 2;
    pud.position.set(px, groundY(px, pz) + 0.1 - 0.3 * sstep(11.5, 4, pt), pz);
    scene.add(pud);
  }
  // oil bleeding into the soil under the engine
  const oil = new THREE.Mesh(new THREE.CircleGeometry(1.3, 12), new THREE.MeshBasicMaterial({ color: 0x14100c, transparent: true, opacity: 0.85 }));
  oil.rotation.x = -Math.PI / 2;
  oil.position.set(3.4, groundY(3.4, 2.0) + 0.11, 2.0);
  scene.add(oil);

  // torn-off right wing, thrown clear, its spar sticking out of the torn root
  const wingR = new THREE.Group();
  const wr = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.13, 3.4), hullPlain);
  wr.rotation.z = 0.18; wr.rotation.y = 0.9;
  wingR.add(wr);
  const wrTip = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.14, 0.3), stripe);
  wrTip.position.set(-1.45, -0.3, 1.15);
  wrTip.rotation.z = 0.18; wrTip.rotation.y = 0.9;
  wingR.add(wrTip);
  const wrSpar = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.7), metal);
  wrSpar.position.set(1.6, 0.35, -1.3);
  wrSpar.rotation.y = 0.7;
  wingR.add(wrSpar);
  const flap = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 1.2), hullPlain);
  flap.position.set(0.9, 0.25, 0.8);
  flap.rotation.set(0.7, 0.4, 0.5);
  wingR.add(flap);
  wingR.position.set(-3.5, 0.35, 6.5);
  g.add(wingR);

  // detached wheel that rolled away, scattered skin panels
  const wheel2 = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.14, 8), rubber);
  wheel2.rotation.set(Math.PI / 2, 0, 0.5);
  wheel2.position.set(6.2, 0.15, 3.2);
  g.add(wheel2);
  for (let i = 0; i < 5; i++) {
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.5 + rng() * 0.7, 0.04, 0.4 + rng() * 0.5), hullPlain);
    const a = rng() * Math.PI * 2, r = 4 + rng() * 6;
    d.position.set(Math.cos(a) * r, 0.06, Math.sin(a) * r);
    d.rotation.y = rng() * 3;
    d.rotation.x = rng() * 0.3;
    g.add(d);
  }

  const y = groundY(0, 0);
  g.position.y = y;
  enableShadows(g);
  scene.add(g);
  // the fuselage blocks — a row of circles along its length (yawed 0.45)
  for (const t of [-3.2, -1.6, 0, 1.6, 3.2, 4.6]) {
    addCollider(t * Math.cos(0.45), -t * Math.sin(0.45), 1.35);
  }

  // the pilot's briefcase, thrown clear by the door — the first page and the flashlight are in it
  const bc = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.44, 0.16), mat(0x4a3222));
  shell.position.y = 0.22;
  bc.add(shell);
  for (const dx of [-0.18, 0.18]) {
    const clasp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.03), mat(0xa08a4a, { shininess: 60, flatShading: false }));
    clasp.position.set(dx, 0.36, 0.085);
    bc.add(clasp);
  }
  const bcHandle = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.04), mat(0x2a2118));
  bcHandle.position.y = 0.47;
  bc.add(bcHandle);
  const bcPaper = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.34), new THREE.MeshBasicMaterial({ color: 0xd8d2bd, side: THREE.DoubleSide }));
  bcPaper.rotation.set(-Math.PI / 2, 0, 0.4);
  bcPaper.position.set(0.35, 0.06, 0.25);
  bc.add(bcPaper);
  bc.position.set(2.5, groundY(2.5, 3.3), 3.3);
  bc.rotation.set(0, 1.1, -0.12);
  enableShadows(bc);
  scene.add(bc);
  addInteractable(bc, 'search', 'flight case', 'bcase', { luggage: true, pieceIdx: 0 });

  // thrown luggage — seven bags in all; the flight case and four suitcases
  // carry the notes (resolved by index at search time — MAP_PIECES is declared
  // further down), two hold nothing but a stranger's clothes
  const caseM = mat(0x6e5136), caseM2 = mat(0x3f4a52), caseM3 = mat(0x59452e);
  const luggage = [
    { x: 3.4, z: 4.6, m: caseM, pieceIdx: 1 },
    { x: -2.2, z: 3.4, m: caseM2, pieceIdx: 2 },
    { x: 5.8, z: -1.6, m: caseM, pieceIdx: 3 },
    { x: -4.8, z: -1.5, m: caseM3, pieceIdx: 4 },
    { x: 0.5, z: -4.6, m: caseM2 },
    { x: 6.6, z: 3.8, m: caseM3 },
  ];
  for (const L of luggage) {
    const c = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.38, 0.2), L.m);
    box.position.y = 0.19;
    c.add(box);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.04), mat(0x2a2118));
    handle.position.y = 0.41;
    c.add(handle);
    c.position.set(L.x, groundY(L.x, L.z), L.z);
    c.rotation.y = rng() * 3;
    c.rotation.z = rng() * 0.4 - 0.2;
    scene.add(c);
    addInteractable(c, 'search', 'suitcase', 'case', { luggage: true, pieceIdx: L.pieceIdx });
  }
}

/* ---------------- abandoned places ---------------- */
{
  const logM = mat(0x5d4930), logM2 = mat(0x52402a), plankM = mat(0x4a3a28),
        canvasM = mat(0x8a7d5f, { side: THREE.DoubleSide }), stoneM = mat(0x6f6f6f);

  /* the log cabin — big, dark, and locked */
  {
    const y = groundY(CABIN.x, CABIN.z);
    const g = new THREE.Group();
    const W = 10, D = 7.5, ROWS = 7;
    const logBark = mat(0x5d4930, { map: barkTex }), logBark2 = mat(0x52402a, { map: barkTex });
    const stoneM2 = mat(0x7a7a74), shutterM = mat(0x41321f);
    // dry-stone footing: a proper rubble foundation course of close-packed field
    // stones, stacked two rough courses high all round, lifting the sill logs clear
    // of the wet ground — every stone irregular, varied in size and tone, mossed
    // along the shaded north foot. The front leaves a clear span for the doorway.
    {
      const stoneTones = [0x807c72, 0x726e64, 0x8a8579, 0x6a675d, 0x787468, 0x817b6d];
      const edges = [[-5, -3.75, 5, -3.75, false], [-5, 3.75, 5, 3.75, true],
                     [-5, -3.75, -5, 3.75, false], [5, -3.75, 5, 3.75, false]];
      let si = 3;
      for (const [ax, az, bx, bz, isFront] of edges) {
        const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
        const ux = dx / L, uz = dz / L, n = Math.round(L / 0.68);
        for (let k = 0; k <= n; k++) {
          const wx0 = ax + ux * (k / n) * L;
          if (isFront && Math.abs(wx0) < 2.2) continue; // keep the threshold clear
          for (let course = 0; course < 2; course++) {
            const r = 0.24 + rng() * 0.13;
            const along = (k / n) * L + (rng() - 0.5) * 0.16;
            si++;
            const st = new THREE.Mesh(jitter(new THREE.DodecahedronGeometry(r), r * 0.55),
              mat(stoneTones[si % stoneTones.length]));
            st.position.set(ax + ux * along + uz * (rng() - 0.5) * 0.12,
                            0.06 + course * 0.27 + (rng() - 0.5) * 0.05,
                            az + uz * along + ux * (rng() - 0.5) * 0.12);
            st.rotation.set(rng() * 3, rng() * 3, rng() * 3);
            st.scale.set(1, 0.72 + rng() * 0.3, 0.9 + rng() * 0.25);
            st.castShadow = true;
            g.add(st);
          }
        }
      }
      // moss creeping over the shaded north foot of the wall
      for (let m = 0; m < 9; m++) {
        const moss = new THREE.Mesh(new THREE.SphereGeometry(1, 6, 4), mat(m % 2 ? 0x55632f : 0x4c5a2c));
        moss.position.set(-4.6 + rng() * 9.2, 0.1 + rng() * 0.28, -3.98 - rng() * 0.15);
        moss.scale.set(0.13 + rng() * 0.12, 0.05, 0.1 + rng() * 0.08);
        g.add(moss);
      }
    }
    // window openings are cut clean through the courses at these heights, so the
    // glass shows daylight and the forest beyond instead of a wall of logs
    const WIN_BAND = [1.05, 2.34], WIN_HALF = 0.72;
    const winFrontX = [-3.0, 3.0], winBackX = [1.8];
    // subtract a set of [min,max] gaps from a span, returning the surviving runs
    function subtractGaps(min, max, gaps) {
      let segs = [[min, max]];
      for (const [ga, gb] of gaps) {
        const next = [];
        for (const [a, b] of segs) {
          if (gb <= a || ga >= b) { next.push([a, b]); continue; }
          if (ga > a) next.push([a, ga]);
          if (gb < b) next.push([gb, b]);
        }
        segs = next;
      }
      return segs;
    }
    // one log course running along an axis (ends run long past the corners for the
    // saddle notches), broken by any gap intervals for the door and windows
    function logCourse(axis, fixed, ry, rr, rm, gaps) {
      const half = (axis === 'x' ? W : D) / 2 + 0.55;
      for (const [a, b] of subtractGaps(-half, half, gaps || [])) {
        const len = b - a; if (len < 0.06) continue;
        const mid = (a + b) / 2;
        const log = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, len, 7), rm);
        if (axis === 'x') { log.rotation.z = Math.PI / 2; log.position.set(mid, ry, fixed); }
        else { log.rotation.x = Math.PI / 2; log.position.set(fixed, ry + 0.22, mid); }
        g.add(log);
      }
    }
    // stacked log courses on all four walls
    for (let row = 0; row < ROWS; row++) {
      const ry = 0.3 + row * 0.44;
      const rm = row % 2 ? logBark : logBark2;
      const rr = 0.23 + (row % 3) * 0.015; // the logs aren't all the same girth
      const inBand = ry > WIN_BAND[0] && ry < WIN_BAND[1];
      // back wall (z = -D/2), broken by its one window when the course is in band
      logCourse('x', -D / 2, ry, rr, rm,
        inBand ? winBackX.map(wx => [wx - WIN_HALF, wx + WIN_HALF]) : []);
      // side walls (x = ±W/2), unbroken
      for (const s of [-1, 1]) logCourse('z', s * W / 2, ry, rr, row % 2 ? logBark2 : logBark, []);
      // front wall (z = +D/2): the top course runs full as a header; the rest carry
      // the doorway gap, plus its two windows when the course is in band
      if (row === ROWS - 1) {
        logCourse('x', D / 2, ry, rr, rm, []);
      } else {
        const frontGaps = [[-0.85, 0.85]];
        if (inBand) for (const wx of winFrontX) frontGaps.push([wx - WIN_HALF, wx + WIN_HALF]);
        logCourse('x', D / 2, ry, rr, rm, frontGaps);
      }
    }
    // knots and the odd driven peg standing proud of the logs, here and there
    for (let i = 0; i < 18; i++) {
      const face = i % 4, kr = 0.045 + rng() * 0.04;
      const knot = new THREE.Mesh(new THREE.CylinderGeometry(kr, kr * 0.65, 0.07, 6), mat(0x2c2216));
      const hy = 0.45 + rng() * ((ROWS - 1) * 0.44 - 0.2);
      if (face < 2) { // front / back
        const kx = (rng() - 0.5) * (W - 1.6);
        if (face === 0 && Math.abs(kx) < 1.2 && hy < 2.75) continue; // clear of the doorway
        knot.rotation.x = Math.PI / 2;
        knot.position.set(kx, hy, (face ? -1 : 1) * (D / 2 + 0.24));
      } else { // sides
        knot.rotation.z = Math.PI / 2;
        knot.position.set((face === 2 ? -1 : 1) * (W / 2 + 0.24), hy + 0.22, (rng() - 0.5) * (D - 1.4));
      }
      g.add(knot);
    }
    // squared door frame set into the gap
    for (const s of [-1, 1]) {
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.75, 0.3), plankM);
      jamb.position.set(s * 0.93, 1.38, D / 2);
      g.add(jamb);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.18, 0.32), plankM);
    lintel.position.set(0, 2.78, D / 2);
    g.add(lintel);
    // deep-set windows, cut right through the wall: a reveal lining round the sawn
    // log ends, clear glass you can see the forest through, plank frames, cross
    // mullions, a sill and a skewed shutter
    function cabinWindow(wx, wz) {
      const zs = Math.sign(wz);
      // reveal lining, so the opening reads framed and the log ends don't show
      const linM = mat(0x3d2f1d, { map: barkTex });
      const linT = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.1, 0.62), linM);
      linT.position.set(wx, 2.32, wz); g.add(linT);
      const linB = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.12, 0.62), linM);
      linB.position.set(wx, 1.16, wz); g.add(linB);
      for (const dx of [-0.71, 0.71]) {
        const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.28, 0.62), linM);
        jamb.position.set(wx + dx, 1.74, wz); g.add(jamb);
      }
      // the glass — clear now, faintly tinted and reflective, see straight through
      const glassPane = new THREE.Mesh(new THREE.BoxGeometry(1.32, 1.14, 0.04),
        mat(0x2a373d, { transparent: true, opacity: 0.22, shininess: 130 }));
      glassPane.position.set(wx, 1.74, wz);
      g.add(glassPane);
      // outer trim
      for (const dy of [0.62, -0.62]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 0.14), plankM);
        bar.position.set(wx, 1.74 + dy, wz + zs * 0.3);
        g.add(bar);
      }
      for (const dx of [-0.72, 0.72]) {
        const side = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.36, 0.14), plankM);
        side.position.set(wx + dx, 1.74, wz + zs * 0.3);
        g.add(side);
      }
      // a weathered sill sloping the rain outward
      const sill = new THREE.Mesh(new THREE.BoxGeometry(1.68, 0.1, 0.28), plankM);
      sill.position.set(wx, 1.1, wz + zs * 0.34);
      sill.rotation.x = zs * 0.2;
      g.add(sill);
      // cross mullions, set proud on the outer face
      const mullV = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.14, 0.1), plankM);
      mullV.position.set(wx, 1.74, wz + zs * 0.22);
      g.add(mullV);
      const mullH = new THREE.Mesh(new THREE.BoxGeometry(1.32, 0.06, 0.1), plankM);
      mullH.position.set(wx, 1.74, wz + zs * 0.22);
      g.add(mullH);
      const shutter = new THREE.Mesh(new THREE.BoxGeometry(0.66, 1.42, 0.07), shutterM);
      shutter.position.set(wx + 1.12, 1.6, wz + zs * 0.28);
      shutter.rotation.z = zs * 0.08; // hanging off its top hinge
      g.add(shutter);
    }
    cabinWindow(-3.0, D / 2); cabinWindow(3.0, D / 2); cabinWindow(1.8, -D / 2);
    // gable roof — plank slabs pitched UP to a proper ridge, battened in courses
    const wallTop = 0.3 + (ROWS - 1) * 0.44 + 0.22;
    const PITCH = 0.55, HSPAN = D / 2 + 0.9;
    const RISE = HSPAN * Math.tan(PITCH), SLOPE = HSPAN / Math.cos(PITCH);
    for (const s of [-1, 1]) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(W + 2.4, 0.13, SLOPE), plankM);
      slab.position.set(0, wallTop + RISE / 2 + 0.06, s * HSPAN / 2);
      slab.rotation.x = s * PITCH; // ridge high, eaves low
      g.add(slab);
      for (const u of [-1.9, -0.7, 0.5, 1.7]) { // board courses so the slope reads as planks
        const bat = new THREE.Mesh(new THREE.BoxGeometry(W + 2.4, 0.06, 0.14), logM2);
        bat.position.set(0, wallTop + RISE / 2 + 0.13 - s * u * Math.sin(PITCH), s * HSPAN / 2 + u * Math.cos(PITCH));
        bat.rotation.x = s * PITCH;
        g.add(bat);
      }
    }
    const ridge = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, W + 2.6, 6), logBark);
    ridge.rotation.z = Math.PI / 2;
    ridge.position.set(0, wallTop + RISE + 0.1, 0);
    g.add(ridge);
    // gable ends filled with shortening logs right up to the peak
    for (const s of [-1, 1]) {
      for (let i = 0; ; i++) {
        const gy = wallTop + 0.2 + i * 0.38;
        const half = (1 - (gy - wallTop) / RISE) * (D / 2 - 0.1);
        if (half < 0.35) break;
        const gl = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, half * 2, 6), i % 2 ? logBark : logBark2);
        gl.rotation.x = Math.PI / 2;
        gl.position.set(s * (W / 2), gy, 0);
        g.add(gl);
      }
    }
    // a boarded ceiling laid over the tie-beams seals the room off from the roof
    // void, so no eave slot or shingle seam ever shows the interior from outside
    {
      const ceilY = wallTop + 0.44; // above the exposed rafters and purlins
      // wide enough to overrun the front/back eave slots (the gable logs already
      // seal the ends), but kept inside the side walls so no board edge shows out
      const ceilD = D + 0.5, nC = 11, cd = ceilD / nC;
      const ceilTones = [0x3f3120, 0x463726, 0x392c1c];
      for (let i = 0; i < nC; i++) {
        const cb = new THREE.Mesh(new THREE.BoxGeometry(W - 0.2, 0.08, cd - 0.015),
          mat(ceilTones[i % 3], { map: barkTex }));
        cb.position.set(0, ceilY, -ceilD / 2 + cd * (i + 0.5));
        g.add(cb);
      }
    }
    // ridge cap boards straddling the seam where the two slopes meet, closing the apex
    for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(W + 2.8, 0.09, 0.55), plankM);
      cap.position.set(0, wallTop + RISE + 0.05, s * 0.18);
      cap.rotation.x = -s * PITCH * 0.7;
      g.add(cap);
    }
    // fascia boards hung at the eaves, closing the overhang and trimming the line
    for (const s of [-1, 1]) {
      const fascia = new THREE.Mesh(new THREE.BoxGeometry(W + 2.5, 0.3, 0.08), mat(0x35281a, { map: barkTex }));
      fascia.position.set(0, wallTop + RISE / 2 + 0.06 - SLOPE / 2 * Math.sin(PITCH) - 0.05,
        s * (HSPAN / 2 + SLOPE / 2 * Math.cos(PITCH)));
      g.add(fascia);
    }
    // stone chimney climbing the west gable, clear of the ridge
    for (let i = 0; i < 11; i++) {
      const st = new THREE.Mesh(new THREE.BoxGeometry(1.15 - i * 0.045, 0.55, 1.0 - i * 0.04), i % 2 ? stoneM : stoneM2);
      st.position.set(-W / 2 - 0.72, 0.28 + i * 0.53, -0.8);
      st.rotation.y = (i % 2) * 0.09 - 0.045;
      g.add(st);
    }
    const flue = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.45), mat(0x3a3733));
    flue.position.set(-W / 2 - 0.72, 5.95, -0.8);
    g.add(flue);
    // porch: boarded deck, a step, posts with braces, a lean-to roof over the door
    for (let i = 0; i < 5; i++) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.14, 1.9), i % 2 ? plankM : shutterM);
      board.position.set(-1.72 + i * 0.86, 0.12, D / 2 + 1.15);
      g.add(board);
    }
    const step = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.12, 0.45), shutterM);
    step.position.set(0, 0.05, D / 2 + 2.32);
    g.add(step);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 2.5, 6), logBark);
      post.position.set(s * 1.9, 1.35, D / 2 + 1.95);
      g.add(post);
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.8, 0.07), plankM);
      brace.position.set(s * 1.9, 2.4, D / 2 + 1.6);
      brace.rotation.x = -0.7;
      g.add(brace);
    }
    const porchRoof = new THREE.Mesh(new THREE.BoxGeometry(4.9, 0.1, 2.6), plankM);
    porchRoof.position.set(0, 2.85, D / 2 + 1.15);
    porchRoof.rotation.x = 0.26; // high against the wall, sloping down over the posts to shed rain
    g.add(porchRoof);
    // --- exterior yard clutter: a rain barrel fed by a downspout, a split-wood
    // stack under the eave, and a birch broom left leaning by the door ---
    {
      // rain barrel of staved wood, iron-hooped, at the front-east corner
      const bx = W / 2 + 0.55, bz = D / 2 - 0.2;
      const barrelM = mat(0x4a3b26, { map: barkTex });
      for (let k = 0; k < 13; k++) { // staves
        const a2 = k / 13 * Math.PI * 2;
        const stave = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.86, 0.05), barrelM);
        stave.position.set(bx + Math.cos(a2) * 0.36, 0.46, bz + Math.sin(a2) * 0.36);
        stave.rotation.y = -a2;
        g.add(stave);
      }
      for (const hy of [0.12, 0.44, 0.78]) { // iron hoops
        const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.022, 5, 16), mat(0x2b2824));
        hoop.rotation.x = Math.PI / 2;
        hoop.position.set(bx, hy, bz);
        g.add(hoop);
      }
      const water = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.02, 14),
        new THREE.MeshPhongMaterial({ color: 0x2b3a38, shininess: 90, transparent: true, opacity: 0.85 }));
      water.position.set(bx, 0.82, bz);
      g.add(water);
      // a tin downspout running from the eave down the wall into the barrel
      const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.7, 6), mat(0x6a6558));
      spout.position.set(W / 2 + 0.2, 1.85, bz);
      g.add(spout);
      const elbow = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 6), mat(0x6a6558));
      elbow.rotation.z = Math.PI / 2.6;
      elbow.position.set(bx - 0.18, 0.98, bz);
      g.add(elbow);
      // split firewood stacked against the wall under the eave (west of the door)
      for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) {
        const lg = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.08, 1.1, 6),
          (r + c) % 2 ? logBark : logBark2);
        lg.rotation.z = Math.PI / 2;
        lg.rotation.y = (rng() - 0.5) * 0.1;
        lg.position.set(-W / 2 - 0.28, 0.14 + r * 0.16, D / 2 - 1.0 - c * 0.17 + (r % 2) * 0.05);
        g.add(lg);
      }
      // a birch-twig broom leaning by the doorframe
      const broomH = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 1.3, 6), mat(0x8a6a3a));
      broomH.position.set(1.35, 0.75, D / 2 + 0.22);
      broomH.rotation.z = 0.16;
      g.add(broomH);
      const broomHead = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.4, 7), mat(0x7a6a44));
      broomHead.position.set(1.24, 0.2, D / 2 + 0.22);
      broomHead.rotation.z = 0.16;
      g.add(broomHead);
    }
    // inside: plank floor, bunk, the letter table, and the stove Elliott kept feeding
    // a plank floor laid board by board so the seams read — each plank a little
    // off in tone, none laid quite true, over a dark sub-floor so the gaps between
    // them fall into shadow instead of glowing
    const subFloor = new THREE.Mesh(new THREE.BoxGeometry(W - 0.5, 0.1, D - 0.5), mat(0x1c1610));
    subFloor.position.set(0, 0.09, 0);
    g.add(subFloor);
    // a real sawn-board floor: lengthwise wood grain, staggered butt-joints, iron
    // nail heads at the ends, each board a little off in tone and not laid quite true
    const floorTex = makeCanvasTex(128, (c, s) => {
      c.fillStyle = '#5c4829'; c.fillRect(0, 0, s, s);
      for (let i = 0; i < 80; i++) { // grain running the length of the board
        c.strokeStyle = `rgba(${38 + Math.random() * 44 | 0},${28 + Math.random() * 30 | 0},${14 + Math.random() * 18 | 0},${(0.18 + Math.random() * 0.34).toFixed(2)})`;
        c.lineWidth = 0.4 + Math.random() * 1.6;
        let x0 = Math.random() * s;
        c.beginPath(); c.moveTo(x0, 0);
        for (let y = 0; y <= s; y += 7) { x0 += (Math.random() - 0.5) * 3; c.lineTo(x0, y); }
        c.stroke();
      }
      for (let i = 0; i < 3; i++) { // the odd knot
        const kx = Math.random() * s, ky = Math.random() * s;
        c.fillStyle = 'rgba(26,17,8,.55)';
        c.beginPath(); c.ellipse(kx, ky, 1.5 + Math.random() * 2.5, 3 + Math.random() * 4, 0, 0, 7); c.fill();
        c.strokeStyle = 'rgba(26,17,8,.3)'; c.lineWidth = 1;
        c.beginPath(); c.ellipse(kx, ky, 4 + Math.random() * 3, 7 + Math.random() * 4, 0, 0, 7); c.stroke();
      }
    }, 1, 3);
    const floorTones = [0x6b5636, 0x5e4a2b, 0x74603c, 0x574326, 0x655032];
    const floorM = floorTones.map(t => mat(t, { map: floorTex }));
    const nailM = mat(0x2b2620, { shininess: 15 });
    const nBoards = 13, bwF = (W - 0.62) / nBoards, FLZ = D - 0.55;
    for (let i = 0; i < nBoards; i++) {
      const px = -(W - 0.62) / 2 + bwF * (i + 0.5);
      const split = (0.4 + (i % 3) * 0.11) * FLZ; // the butt-joint walks board to board
      const segs = [[-FLZ / 2, -FLZ / 2 + split - 0.015], [-FLZ / 2 + split + 0.015, FLZ / 2]];
      segs.forEach(([za, zb], si) => {
        const plank = new THREE.Mesh(new THREE.BoxGeometry(bwF - 0.03, 0.09, zb - za), floorM[(i + si) % floorM.length]);
        plank.position.set(px, 0.14, (za + zb) / 2);
        plank.rotation.y = (i % 2 ? 1 : -1) * 0.003; // a hair out of parallel, board to board
        g.add(plank);
        for (const nz of [za + 0.06, zb - 0.06]) { // two nail heads set at each board end
          for (const nx of [-bwF * 0.28, bwF * 0.28]) {
            const nail = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.02, 5), nailM);
            nail.position.set(px + nx, 0.185, nz);
            g.add(nail);
          }
        }
      });
    }
    // --- the bed: a hewn-timber frame with turned posts, a sagging mattress, a
    //     quilt thrown back and spilling to the floor, and a dented pillow —
    //     Elliott's bunk, left unmade. Head to the west wall (-x). ---
    {
      const bedG = new THREE.Group();
      const bx = -2.6, bz = -2.2, BL = 2.05, BW = 1.0;
      const frameM = mat(0x4a3a26, { map: barkTex }), postM = mat(0x40311f, { map: barkTex });
      // four corner posts, taller at the head, each capped with a turned knob
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const h = sx < 0 ? 0.98 : 0.6;
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.075, h, 7), postM);
        post.position.set(bx + sx * BL / 2, h / 2, bz + sz * BW / 2);
        bedG.add(post);
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.078, 8, 6), postM);
        knob.position.set(bx + sx * BL / 2, h + 0.02, bz + sz * BW / 2);
        bedG.add(knob);
      }
      // side and end rails
      for (const sz of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(BL, 0.13, 0.06), frameM);
        rail.position.set(bx, 0.42, bz + sz * BW / 2); bedG.add(rail);
      }
      for (const sx of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.13, BW), frameM);
        rail.position.set(bx + sx * BL / 2, 0.42, bz); bedG.add(rail);
      }
      // headboard planks between the head posts
      for (const hy of [0.66, 0.83]) {
        const hb = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, BW - 0.02), frameM);
        hb.position.set(bx - BL / 2, hy, bz); bedG.add(hb);
      }
      // slat base under the mattress
      const base = new THREE.Mesh(new THREE.BoxGeometry(BL - 0.1, 0.05, BW - 0.1), mat(0x2c2419));
      base.position.set(bx, 0.47, bz); bedG.add(base);
      // the mattress — thick, sagging where he slept
      const mattress = new THREE.Mesh(jitter(new THREE.BoxGeometry(BL - 0.14, 0.2, BW - 0.12, 5, 1, 3), 0.022), mat(0x9a9382));
      mattress.position.set(bx, 0.58, bz); bedG.add(mattress);
      // a rumpled quilt thrown back over the foot half, with a turned-down fold and
      // a corner spilling off the side to the floor
      const quiltM = mat(0x5a4636, { map: barkTex });
      const quilt = new THREE.Mesh(jitter(new THREE.BoxGeometry(BL * 0.6, 0.15, BW + 0.06, 5, 1, 3), 0.04), quiltM);
      quilt.position.set(bx + 0.44, 0.67, bz); bedG.add(quilt);
      const fold = new THREE.Mesh(jitter(new THREE.BoxGeometry(0.3, 0.1, BW + 0.04, 3, 1, 2), 0.03), mat(0x6d5a45));
      fold.position.set(bx + 0.02, 0.71, bz); bedG.add(fold);
      const drape = new THREE.Mesh(jitter(new THREE.BoxGeometry(BL * 0.46, 0.34, 0.06, 4, 2, 1), 0.035), quiltM);
      drape.position.set(bx + 0.42, 0.4, bz + BW / 2 + 0.02); bedG.add(drape);
      // a dented pillow at the head
      const pillow = new THREE.Mesh(jitter(new THREE.BoxGeometry(0.52, 0.17, 0.66, 3, 2, 3), 0.035), mat(0xb3a892));
      pillow.position.set(bx - BL / 2 + 0.36, 0.71, bz);
      pillow.rotation.y = 0.12; bedG.add(pillow);
      g.add(bedG);
    }
    const table = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 0.9), plankM);
    table.position.set(1.6, 0.78, -1.5);
    g.add(table);
    for (const [sx, sz] of [[-0.5, -0.3], [0.5, -0.3], [-0.5, 0.3], [0.5, 0.3]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.75, 0.08), plankM);
      leg.position.set(1.6 + sx, 0.4, -1.5 + sz);
      g.add(leg);
    }
    // the lamp that weighs the letter down — still burning, though nobody is left to feed it
    const lampBase = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.1, 8), mat(0x3a352c));
    lampBase.position.set(1.15, 0.87, -1.75);
    g.add(lampBase);
    const lampGlass = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.22, 8),
      new THREE.MeshBasicMaterial({ color: 0xffb96a, transparent: true, opacity: 0.85 }));
    lampGlass.position.set(1.15, 1.02, -1.75);
    g.add(lampGlass);
    const lampIn = new THREE.PointLight(0xff9a4a, 0.45, 9, 2);
    lampIn.position.set(1.15, 1.1, -1.75);
    g.add(lampIn);
    // a lantern hung on the porch, guttering — someone meant to come back to it
    const hang = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 4), mat(0x2c2925));
    hang.position.set(1.5, 2.5, D / 2 + 1.35);
    g.add(hang);
    const lanCap = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.08, 8), mat(0x2c2925));
    lanCap.position.set(1.5, 2.34, D / 2 + 1.35);
    g.add(lanCap);
    const lanGlass = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.18, 8),
      new THREE.MeshBasicMaterial({ color: 0xffb96a, transparent: true, opacity: 0.85 }));
    lanGlass.position.set(1.5, 2.2, D / 2 + 1.35);
    g.add(lanGlass);
    const lanBase = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.03, 8), mat(0x2c2925));
    lanBase.position.set(1.5, 2.1, D / 2 + 1.35);
    g.add(lanBase);
    const lampOut = new THREE.PointLight(0xff9a4a, 0.5, 11, 2);
    lampOut.position.set(1.5, 2.2, D / 2 + 1.45);
    g.add(lampOut);
    window._cabinLamps = [lampIn, lampOut];
    window._cabinLampGlass = [lampGlass, lanGlass];
    const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.5, 7), logBark);
    stool.position.set(2.3, 0.35, -0.7);
    g.add(stool);
    const stove = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.4, 0.8, 10), mat(0x26241f));
    stove.position.set(3.6, 0.55, -2.5);
    g.add(stove);
    const stoveDoor = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, 0.06), mat(0x14110c));
    stoveDoor.position.set(3.6, 0.5, -2.12);
    g.add(stoveDoor);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 4.4, 7), mat(0x26241f));
    pipe.position.set(3.6, 3.1, -2.5); // run up through the roof boards
    g.add(pipe);
    // a sagging sofa against the west wall, facing the room
    const sofaM = mat(0x54453a), cushM = mat(0x6b5c4c);
    const sofaBase = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.4, 2.0), sofaM);
    sofaBase.position.set(-3.9, 0.42, 1.3); g.add(sofaBase);
    const sofaBack = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.85, 2.0), sofaM);
    sofaBack.position.set(-4.32, 0.8, 1.3); sofaBack.rotation.z = -0.1; g.add(sofaBack);
    for (const s of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.3, 0.22), sofaM);
      arm.position.set(-3.9, 0.75, 1.3 + s * 1.05); g.add(arm);
      const cush = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.16, 0.88), cushM);
      cush.position.set(-3.85, 0.68, 1.3 + s * 0.46);
      cush.rotation.y = s * 0.04;
      g.add(cush);
    }
    // a braided oval rug, mid-room — the body came down half across it
    const rugTex = makeCanvasTex(128, (c, s2) => {
      c.clearRect(0, 0, s2, s2);
      const cols = ['#6b4a3a', '#8a7458', '#4a4438', '#7a5a44', '#5c5648'];
      for (let r = 60; r > 4; r -= 5) {
        c.strokeStyle = cols[(r / 5 | 0) % cols.length];
        c.lineWidth = 5;
        c.globalAlpha = 0.92;
        c.beginPath();
        c.ellipse(s2 / 2, s2 / 2, r, r * 0.72, 0, 0, 7);
        c.stroke();
      }
      c.globalAlpha = 0.25; // worn through in the middle
      c.fillStyle = '#3a352c';
      c.beginPath(); c.ellipse(s2 / 2, s2 / 2, 26, 17, 0.3, 0, 7); c.fill();
      c.globalAlpha = 1;
    });
    const rug = new THREE.Mesh(new THREE.CircleGeometry(1.35, 18),
      new THREE.MeshLambertMaterial({ map: rugTex, transparent: true, depthWrite: false }));
    rug.rotation.x = -Math.PI / 2;
    rug.rotation.z = 0.4;
    rug.position.set(0.2, 0.18, 0.5);
    g.add(rug);
    // a bookshelf on the north wall, half its books still standing
    const shelfM2 = mat(0x4c3a26, { map: barkTex });
    for (const sx of [-0.55, 0.55]) {
      const up = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.7, 0.28), shelfM2);
      up.position.set(0.6 + sx, 1.02, -3.35);
      g.add(up);
    }
    const bookCols = [0x5a3a30, 0x3a4a55, 0x6b5a34, 0x44523a, 0x54383f, 0x3c3c46];
    for (let row = 0; row < 3; row++) {
      const sy2 = 0.42 + row * 0.55;
      const board = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.05, 0.3), shelfM2);
      board.position.set(0.6, sy2, -3.35);
      g.add(board);
      let bx3 = 0.12;
      while (bx3 < 1.0) { // spines of unequal heights, a few slumped over
        const bw = 0.05 + rng() * 0.05, bh = 0.2 + rng() * 0.12;
        const book = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.2), mat(bookCols[(rng() * 6) | 0]));
        const slump = row === 1 && bx3 > 0.7;
        book.position.set(0.05 + bx3, sy2 + (slump ? 0.06 : bh / 2 + 0.03), -3.33);
        book.rotation.z = slump ? Math.PI / 2 - 0.15 : (rng() - 0.5) * 0.08;
        g.add(book);
        bx3 += bw + 0.012 + (slump ? 0.1 : 0);
      }
    }
    // two books face-down on the floor where they were knocked from the shelf
    for (const [fx2, fz2] of [[1.3, -2.7], [0.2, -2.9]]) {
      const fb = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.045, 0.16), mat(bookCols[(rng() * 6) | 0]));
      fb.position.set(fx2, 0.2, fz2);
      fb.rotation.y = rng() * 3;
      g.add(fb);
    }
    // firewood stacked by the stove, and the axe still sunk in its splitting round
    for (let i = 0; i < 6; i++) {
      const lw = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.55, 6), logBark2);
      lw.rotation.x = Math.PI / 2;
      lw.position.set(2.75 + (i % 3) * 0.17, 0.25 + Math.floor(i / 3) * 0.15, -3.15);
      g.add(lw);
    }
    const round = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.21, 0.4, 8), logBark);
    round.position.set(2.2, 0.37, -3.1);
    g.add(round);
    const axeH = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.7, 6), mat(0x6a4a2a));
    axeH.position.set(2.2, 0.9, -3.02);
    axeH.rotation.x = -0.5;
    g.add(axeH);
    const axeHead = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.03), mat(0x565b60));
    axeHead.position.set(2.2, 0.6, -3.12);
    g.add(axeHead);
    // a chair on its side between the table and the body — nobody set it right again
    {
      const chM = mat(0x55432c, { map: barkTex });
      const ch = new THREE.Group();
      const seat2 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.42), chM);
      ch.add(seat2);
      const back2 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.05), chM);
      back2.position.set(0, 0.26, -0.2);
      ch.add(back2);
      for (const [lx, lz] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) {
        const leg2 = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.45, 5), chM);
        leg2.position.set(lx, -0.24, lz);
        ch.add(leg2);
      }
      ch.position.set(1.0, 0.42, -0.4);
      ch.rotation.set(Math.PI / 2 - 0.1, 0.7, 0.2); // over on its back
      g.add(ch);
    }
    // the table keeps its clutter: a tipped enamel mug, a plate, a stub of candle in wax
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.11, 8), mat(0x7a8288));
    mug.position.set(1.25, 0.87, -1.3);
    mug.rotation.z = Math.PI / 2 - 0.2; // on its side, long dry
    g.add(mug);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.09, 0.02, 10), mat(0x9aa0a4));
    plate.position.set(2.0, 0.84, -1.7);
    g.add(plate);
    const wax = new THREE.Mesh(jitter(new THREE.CylinderGeometry(0.05, 0.07, 0.03, 8), 0.01), mat(0xd8d2bc));
    wax.position.set(1.15, 0.84, -1.8);
    g.add(wax);
    const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.08, 6), mat(0xe4dfc8));
    candle.position.set(1.15, 0.89, -1.8);
    g.add(candle);
    // a framed photograph on the north wall, knocked crooked
    const photoTex = makeCanvasTex(64, (c, s2) => {
      c.fillStyle = '#3a3128'; c.fillRect(0, 0, s2, s2);           // the frame
      c.fillStyle = '#c9c2ae'; c.fillRect(6, 6, s2 - 12, s2 - 12); // faded albumen
      c.fillStyle = '#8a8272';
      c.fillRect(14, 22, 10, 24); c.fillRect(30, 18, 10, 28);      // two figures, features long gone
      c.beginPath(); c.arc(19, 18, 5, 0, 7); c.fill();
      c.beginPath(); c.arc(35, 14, 5, 0, 7); c.fill();
    });
    const photo = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), new THREE.MeshLambertMaterial({ map: photoTex }));
    photo.position.set(-1.2, 1.75, -3.53);
    photo.rotation.z = -0.14; // crooked, and nobody straightened it
    g.add(photo);
    // a wall shelf of cans and bottles over the kitchen end
    const wallShelf = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.05, 0.24), shelfM2);
    wallShelf.position.set(2.6, 1.5, -3.4);
    g.add(wallShelf);
    for (let i = 0; i < 4; i++) {
      const can = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.13, 8), i % 2 ? mat(0x8a4a3a) : mat(0x7a8060));
      can.position.set(2.2 + i * 0.26, 1.6, -3.4);
      if (i === 3) { can.rotation.z = Math.PI / 2; can.position.y = 1.57; } // one rolled over
      g.add(can);
    }
    const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.24, 8), mat(0x2e4436));
    bottle.position.set(3.05, 1.65, -3.4);
    g.add(bottle);
    // antlers over the door, the way every cabin has and no one remembers hanging
    {
      const plaque = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.05), shelfM2);
      plaque.position.set(0, 2.6, 3.55);
      g.add(plaque);
      const antM = mat(0xcfc4a8);
      for (const s of [1, -1]) {
        const main = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.5, 5), antM);
        main.position.set(s * 0.14, 2.75, 3.5);
        main.rotation.z = s * 0.8;
        g.add(main);
        for (let k = 0; k < 2; k++) {
          const tine = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.2, 4), antM);
          tine.position.set(s * (0.2 + k * 0.12), 2.85 + k * 0.05, 3.5);
          tine.rotation.z = s * (1.5 - k * 0.3);
          g.add(tine);
        }
      }
    }
    // cobwebs in the high corners — grey veils that nobody has walked through in a year
    const webM = new THREE.MeshBasicMaterial({ color: 0xb8b8ae, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    for (const [wx2, wz2, wr] of [[-4.6, -3.45, 0.8], [4.6, -3.45, -0.8], [-4.6, 3.45, 2.4]]) {
      const web = new THREE.Mesh(new THREE.CircleGeometry(0.65, 3), webM);
      web.position.set(wx2, 2.75, wz2);
      web.rotation.set(0.5, wr, 0.3);
      g.add(web);
    }
    // a small kitchen along the east wall: counter, basin, pot, shelf of jars, cupboard
    const counter = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.82, 2.9), plankM);
    counter.position.set(4.0, 0.43, 1.1); g.add(counter);
    const counterTop = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.06, 3.05), shutterM);
    counterTop.position.set(3.98, 0.87, 1.1); g.add(counterTop);
    const basin = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.14, 0.6), mat(0x5a5f63));
    basin.position.set(3.98, 0.95, 1.9); g.add(basin);
    const basinIn = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.13, 0.48), mat(0x24272a));
    basinIn.position.set(3.98, 0.965, 1.9); g.add(basinIn);
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.12, 0.18, 8), mat(0x2c2c2e));
    pot.position.set(3.95, 0.99, 0.5); g.add(pot);
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 2.2), plankM);
    shelf.position.set(4.2, 1.7, 1.0); g.add(shelf);
    for (let i = 0; i < 4; i++) {
      const jar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.2, 7), mat(i % 2 ? 0x7d7460 : 0x5f6b58));
      jar.position.set(4.2, 1.83, 0.25 + i * 0.5);
      g.add(jar);
    }
    const cupboard = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.9, 1.2), logBark2);
    cupboard.position.set(4.15, 2.4, -0.9); g.add(cupboard);

    // --- ceiling rafters: hewn tie-beams across the room, with two purlins running
    // its length, so the roof reads as built and the space feels roofed, not open ---
    for (const rz of [-3.0, -1.5, 0, 1.5, 3.0]) {
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.11, W - 0.2, 6), rz % 3 === 0 ? logBark : logBark2);
      beam.rotation.z = Math.PI / 2;
      beam.position.set(0, 3.02, rz);
      g.add(beam);
    }
    for (const px of [-2.6, 2.6]) {
      const purlin = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, D - 0.2, 6), logBark2);
      purlin.rotation.x = Math.PI / 2;
      purlin.position.set(px, 3.16, 0);
      g.add(purlin);
    }

    // --- a warm hearth: a cast-iron pot on the stove, and embers still breathing
    // behind the stove door, throwing a low orange wash across the planks ---
    const stovePot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.24, 10), mat(0x1f1e1b));
    stovePot.position.set(3.6, 1.07, -2.5); g.add(stovePot);
    const potLid = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.04, 10), mat(0x2a2825));
    potLid.position.set(3.6, 1.21, -2.5); g.add(potLid);
    const emberGlow = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.24, 0.02),
      new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0.85 }));
    emberGlow.position.set(3.6, 0.5, -2.09); g.add(emberGlow);
    const emberLight = new THREE.PointLight(0xff6a24, 0.5, 6, 2);
    emberLight.position.set(3.35, 0.6, -2.3); g.add(emberLight);
    window._cabinEmber = emberLight; // let it flicker with the lamps

    // --- bedding: a heavy fur throw folded over the foot of the bed ---
    const furM = mat(0x4a3a28);
    const throwF = new THREE.Mesh(jitter(new THREE.BoxGeometry(1.1, 0.16, 1.02), 0.03), furM);
    throwF.position.set(-1.95, 0.74, -2.2); g.add(throwF);

    // --- a travelling chest at the foot of the bed, lid shut, iron-banded ---
    const chestBody = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.42, 0.56), mat(0x4a3720, { map: barkTex }));
    chestBody.position.set(-1.2, 0.33, -3.0); g.add(chestBody);
    const chestLid = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.14, 0.58), mat(0x3f2f1b, { map: barkTex }));
    chestLid.position.set(-1.2, 0.6, -3.0); g.add(chestLid);
    for (const bx of [-0.36, 0.36]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.62, 0.6), mat(0x26241f, { shininess: 20 }));
      band.position.set(-1.2 + bx, 0.42, -3.0); g.add(band);
    }
    const latch = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.04), mat(0x2c2a24, { shininess: 30 }));
    latch.position.set(-1.2, 0.5, -2.7); g.add(latch);

    // --- a stretched hide pegged to the west wall, the way a trapper cures one ---
    const hideTex = makeCanvasTex(64, (c, s2) => {
      c.fillStyle = '#6a543a'; c.fillRect(0, 0, s2, s2);
      blotches(c, s2, ['#5a462f', '#7a6146', '#4c3a26'], 26, 3, 8, 0.5);
    });
    const hide = new THREE.Mesh(new THREE.CircleGeometry(0.8, 9),
      new THREE.MeshLambertMaterial({ map: hideTex, side: THREE.DoubleSide }));
    hide.scale.set(1, 1.25, 1);
    hide.position.set(-4.82, 1.75, -0.3);
    hide.rotation.y = Math.PI / 2;
    g.add(hide);
    for (let k = 0; k < 6; k++) { // the pegs it hangs from
      const a2 = k / 6 * Math.PI * 2;
      const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.06, 5), mat(0x2c281f));
      peg.rotation.z = Math.PI / 2;
      peg.position.set(-4.86, 1.75 + Math.sin(a2) * 1.0, -0.3 + Math.cos(a2) * 0.8);
      g.add(peg);
    }

    // --- bundles of dried herbs hung to cure from the kitchen rafter ---
    for (let k = 0; k < 3; k++) {
      const bundle = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.34, 6), mat(k % 2 ? 0x6b6a3a : 0x556138));
      bundle.position.set(3.0, 2.78, -1.3 + k * 0.5);
      bundle.rotation.x = Math.PI; // hung tips-down
      g.add(bundle);
      const tie = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 4), mat(0x2c281f));
      tie.position.set(3.0, 2.95, -1.3 + k * 0.5);
      g.add(tie);
    }

    // --- a heavy coat left on a peg by the door, as if he'd be back for it ---
    const coatPeg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.14, 5), mat(0x2c281f));
    coatPeg.rotation.x = Math.PI / 2;
    coatPeg.position.set(-3.4, 2.0, 3.5); g.add(coatPeg);
    const coatHung = new THREE.Mesh(jitter(new THREE.BoxGeometry(0.6, 1.0, 0.22), 0.03), mat(0x3d3f2a));
    coatHung.position.set(-3.4, 1.45, 3.42); g.add(coatHung);
    // Elliott never left. Face-down between the table and the door, one arm still
    // reaching for it — three long tears raked through the coat and everything under it.
    const bodyG = new THREE.Group();
    // woven fabric so the clothes read as cloth, not painted plastic
    const fabricTex = makeCanvasTex(64, (c, s2) => {
      c.fillStyle = '#8a8a8a'; c.fillRect(0, 0, s2, s2);
      for (let i = 0; i < s2; i += 2) {
        c.fillStyle = i % 4 ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.09)';
        c.fillRect(0, i, s2, 1);
        c.fillRect(i, 0, 1, s2);
      }
      blotches(c, s2, ['#6f6f6f', '#9a9a9a'], 30, 2, 6, 0.25); // wear and grime
    }, 3, 3);
    const coatM = mat(0x4b4335, { map: fabricTex }), coatD = mat(0x3a342a, { map: fabricTex }),
          trouserM = mat(0x35302a, { map: fabricTex }),
          bootM = mat(0x211c17), skinM = mat(0xb1a08a), hairM = mat(0x4a3b28);
    function limbSeg(x1, y1, z1, x2, y2, z2, r1, r2, m) {
      const a = new THREE.Vector3(x1, y1, z1), b = new THREE.Vector3(x2, y2, z2);
      // wrinkled cloth, not a smooth pipe
      const seg = new THREE.Mesh(jitter(new THREE.CylinderGeometry(r2, r1, a.distanceTo(b), 8, 3), 0.012), m);
      seg.position.copy(a).add(b).multiplyScalar(0.5);
      seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      bodyG.add(seg);
      // a knuckle of bunched fabric at each end — the joints bend, they don't butt
      for (const [p, r] of [[a, r1], [b, r2]]) {
        const j = new THREE.Mesh(jitter(new THREE.SphereGeometry(r * 1.18, 8, 6), 0.008), m);
        j.position.copy(p);
        bodyG.add(j);
      }
      return seg;
    }
    // the back: one continuous trunk from shoulders to hips — broad across the
    // shoulders, gathered at the waist — flattened against the boards
    const trunkPts = [
      new THREE.Vector2(0.001, -0.48),
      new THREE.Vector2(0.185, -0.45),
      new THREE.Vector2(0.245, -0.30), // hips
      new THREE.Vector2(0.208, -0.05), // waist
      new THREE.Vector2(0.235, 0.16),  // chest
      new THREE.Vector2(0.25, 0.33),   // shoulders
      new THREE.Vector2(0.175, 0.44),
      new THREE.Vector2(0.001, 0.47),
    ];
    const torso = new THREE.Mesh(jitter(new THREE.LatheGeometry(trunkPts, 14), 0.012), coatM);
    torso.rotation.z = -Math.PI / 2; // shoulders toward the head
    torso.scale.x = 0.62; // local x is world y once he's lying down
    torso.position.set(0, 0.145, 0);
    bodyG.add(torso);
    const shoulders = new THREE.Mesh(jitter(new THREE.SphereGeometry(0.26, 12, 9), 0.015), coatM);
    shoulders.scale.set(0.9, 0.55, 1.05);
    shoulders.position.set(0.42, 0.14, 0);
    bodyG.add(shoulders);
    // the coat's hem breaks over the hips, riding slightly proud of the trousers
    const hem = new THREE.Mesh(jitter(new THREE.CylinderGeometry(0.255, 0.265, 0.2, 12), 0.01), coatD);
    hem.rotation.z = Math.PI / 2;
    hem.scale.x = 0.62;
    hem.position.set(-0.33, 0.148, 0);
    bodyG.add(hem);
    const seat = new THREE.Mesh(jitter(new THREE.SphereGeometry(0.24, 12, 9), 0.015), coatD);
    seat.scale.set(1.0, 0.6, 0.95);
    seat.position.set(-0.44, 0.13, 0);
    bodyG.add(seat);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.04, 6, 10), coatD);
    collar.rotation.y = Math.PI / 2;
    collar.position.set(0.6, 0.16, 0);
    bodyG.add(collar);
    // the neck, so the head belongs to the body
    limbSeg(0.52, 0.125, 0.01, 0.76, 0.1, 0.05, 0.062, 0.052, skinM);
    // the head, turned so one cheek rests on the floor
    const headB = new THREE.Mesh(jitter(new THREE.SphereGeometry(0.135, 12, 9), 0.008), skinM);
    headB.scale.set(1.15, 0.9, 0.92);
    headB.position.set(0.82, 0.11, 0.06);
    headB.rotation.x = 0.55;
    bodyG.add(headB);
    // face down, so it's the back of his head you see: hair from the crown
    // (pointing away down the floor) up over the whole back of the skull
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 6, 0, Math.PI * 2, 0, 2.0), hairM);
    hair.scale.set(1.12, 0.9, 0.92);
    hair.position.set(0.815, 0.11, 0.055);
    hair.rotation.set(0.15, 0, -0.7);
    bodyG.add(hair);
    // right arm flung out toward the door; left arm crumpled at his side
    limbSeg(0.48, 0.13, 0.2, 0.85, 0.08, 0.38, 0.065, 0.055, coatM);
    limbSeg(0.85, 0.08, 0.38, 1.24, 0.05, 0.44, 0.055, 0.042, coatM);
    limbSeg(0.48, 0.13, -0.2, 0.42, 0.07, -0.5, 0.065, 0.055, coatM);
    limbSeg(0.42, 0.07, -0.5, 0.14, 0.05, -0.6, 0.055, 0.042, coatM);
    // hands: a palm, four fingers curled into the boards, a thumb tucked under
    for (const [hx2, hz2, ha] of [[1.32, 0.45, 0.55], [0.06, -0.62, -1.9]]) {
      const hand = new THREE.Group();
      const palm = new THREE.Mesh(jitter(new THREE.SphereGeometry(0.05, 8, 6), 0.006), skinM);
      palm.scale.set(1.5, 0.5, 1.1);
      hand.add(palm);
      for (let f = 0; f < 4; f++) {
        const fin = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.013, 0.09, 5), skinM);
        fin.position.set(0.083, -0.01, -0.034 + f * 0.023);
        fin.rotation.z = -1.3 - f * 0.06; // each finger curled a little tighter
        hand.add(fin);
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.012, 5, 4), skinM);
        tip.position.set(0.12, -0.028, -0.034 + f * 0.023);
        hand.add(tip);
      }
      const thumb = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.07, 5), skinM);
      thumb.position.set(0.015, -0.012, 0.058);
      thumb.rotation.set(0.5, 0, -1.1);
      hand.add(thumb);
      hand.position.set(hx2, 0.04, hz2);
      hand.rotation.y = ha; // fingers reaching on down the line of the arm
      bodyG.add(hand);
    }
    // legs: one nearly straight, one drawn up at the knee
    limbSeg(-0.56, 0.12, 0.1, -1.02, 0.09, 0.2, 0.09, 0.07, trouserM);
    limbSeg(-1.02, 0.09, 0.2, -1.48, 0.06, 0.14, 0.07, 0.05, trouserM);
    limbSeg(-0.56, 0.12, -0.1, -0.92, 0.09, -0.34, 0.09, 0.07, trouserM);
    limbSeg(-0.92, 0.09, -0.34, -1.24, 0.06, -0.2, 0.07, 0.05, trouserM);
    // proper work boots: rubber sole and heel block, rounded toe cap, leather
    // upper, laced instep, the trouser cuff bunched over the shaft — one rolled
    // nearly sole-up, the other fallen onto its side, the way dead feet lie
    const soleM = mat(0x15110d), leatherM = mat(0x2e2117), laceM = mat(0x0d0a07);
    function boot(bx2, bz2, ba, roll) {
      const b2 = new THREE.Group();
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.035, 0.115), soleM);
      sole.position.y = 0.018;
      b2.add(sole);
      const heel = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.032, 0.115), soleM);
      heel.position.set(0.1, 0.048, 0); // the heel block, worn down on one edge
      heel.rotation.z = 0.06;
      b2.add(heel);
      const upper = new THREE.Mesh(jitter(new THREE.BoxGeometry(0.2, 0.1, 0.105), 0.008), leatherM);
      upper.position.set(-0.02, 0.085, 0);
      b2.add(upper);
      const toe = new THREE.Mesh(jitter(new THREE.SphereGeometry(0.058, 8, 6), 0.006), leatherM);
      toe.scale.set(1.5, 0.72, 0.95);
      toe.position.set(-0.115, 0.055, 0);
      b2.add(toe);
      const ankle = new THREE.Mesh(jitter(new THREE.CylinderGeometry(0.056, 0.064, 0.1, 8), 0.008), leatherM);
      ankle.rotation.z = 0.4; // the shaft kinks where the leg lies into it
      ankle.position.set(0.11, 0.12, 0);
      b2.add(ankle);
      for (let i = 0; i < 3; i++) { // laces across the instep, still tied
        const lace = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.1, 4), laceM);
        lace.rotation.x = Math.PI / 2;
        lace.rotation.z = 0.3;
        lace.position.set(-0.01 + i * 0.045, 0.125 - i * 0.006, 0);
        b2.add(lace);
      }
      const cuff = new THREE.Mesh(jitter(new THREE.TorusGeometry(0.058, 0.018, 6, 10), 0.006), trouserM);
      cuff.rotation.y = Math.PI / 2;
      cuff.rotation.z = 0.4;
      cuff.position.set(0.15, 0.14, 0); // trousers bunched over the boot shaft
      b2.add(cuff);
      b2.position.set(bx2, 0.055, bz2);
      b2.rotation.y = ba;
      b2.rotation.x = roll;
      bodyG.add(b2);
    }
    boot(-1.58, 0.13, -0.15, 2.5); // rolled nearly sole-up
    boot(-1.34, -0.16, 0.5, 1.35); // fallen onto its side
    // the wounds are painted onto a thin shell moulded over the back, so the
    // blood-soaked patch and the three claw tears follow the curve of the coat
    const woundTex = makeCanvasTex(256, (c, s2) => {
      c.clearRect(0, 0, s2, s2);
      const g3 = c.createRadialGradient(s2 * 0.5, s2 * 0.42, 6, s2 * 0.5, s2 * 0.42, s2 * 0.26);
      g3.addColorStop(0, 'rgba(58,8,5,.92)');
      g3.addColorStop(0.55, 'rgba(48,7,5,.6)');
      g3.addColorStop(1, 'rgba(40,6,4,0)');
      c.fillStyle = g3;
      c.beginPath(); c.arc(s2 * 0.5, s2 * 0.42, s2 * 0.26, 0, 7); c.fill();
      for (let i = 0; i < 14; i++) { // soaked further along the weave in places
        const a = Math.random() * 7, r = s2 * (0.15 + Math.random() * 0.11);
        c.fillStyle = 'rgba(48,7,5,.35)';
        c.beginPath();
        c.arc(s2 * 0.5 + Math.cos(a) * r * 0.8, s2 * 0.42 + Math.sin(a) * r * 0.7, s2 * (0.03 + Math.random() * 0.06), 0, 7);
        c.fill();
      }
      c.save(); // three ragged tears raked diagonally across the patch
      c.translate(s2 * 0.5, s2 * 0.42);
      c.rotate(-0.45);
      for (let i = 0; i < 3; i++) {
        const oy = (i - 1) * s2 * 0.1, len = s2 * (0.36 - Math.abs(i - 1) * 0.05);
        for (let x = -len / 2; x < len / 2; x++) { // red lips around a near-black core
          const t = (x + len / 2) / len;
          const w = Math.sin(t * Math.PI) * s2 * (0.013 + Math.random() * 0.006);
          c.fillStyle = '#8a1812';
          c.fillRect(x, oy - w, 1, w * 2);
          c.fillStyle = '#210302';
          c.fillRect(x, oy - w * 0.45, 1, w * 0.9);
        }
        c.fillStyle = 'rgba(255,90,66,.5)'; // wet glints along each tear
        for (let k = 0; k < 8; k++) c.fillRect((Math.random() - 0.5) * len * 0.8, oy - 1 + Math.random() * 2, 2, 1);
      }
      c.restore();
    });
    const shellPts = trunkPts.slice(1, 7).map(v => new THREE.Vector2(v.x + 0.02, v.y));
    const shell = new THREE.Mesh(new THREE.LatheGeometry(shellPts, 14, Math.PI, Math.PI),
      new THREE.MeshStandardMaterial({ map: woundTex, transparent: true, roughness: 0.55, depthWrite: false }));
    shell.rotation.z = -Math.PI / 2;
    shell.scale.x = 0.62;
    shell.position.copy(torso.position);
    shell.renderOrder = 1;
    bodyG.add(shell);
    // what came out of him: a splattered pool, and the smear where he dragged himself
    const bloodTex = makeCanvasTex(128, (c, s2) => {
      c.clearRect(0, 0, s2, s2);
      // the pool spread in lobes along the floorboards, dried darker at its rim
      for (let i = 0; i < 7; i++) {
        const a = Math.random() * 7, r = s2 * (0.08 + Math.random() * 0.14);
        c.fillStyle = `rgba(58,16,9,${(0.4 + Math.random() * 0.3).toFixed(2)})`;
        c.beginPath();
        c.ellipse(s2 / 2 + Math.cos(a) * r * 0.8, s2 / 2 + Math.sin(a) * r * 0.7, r * 1.4, r * 0.9, a, 0, 7);
        c.fill();
      }
      c.fillStyle = 'rgba(38,7,4,.92)'; // nearly black at the heart, and still faintly wet
      c.beginPath(); c.ellipse(s2 * 0.5, s2 * 0.5, s2 * 0.26, s2 * 0.2, 0.4, 0, 7); c.fill();
      c.fillStyle = 'rgba(72,14,8,.5)'; // one dull gleam where it pooled deepest
      c.beginPath(); c.ellipse(s2 * 0.46, s2 * 0.47, s2 * 0.09, s2 * 0.05, 0.6, 0, 7); c.fill();
      for (let i = 0; i < 30; i++) { // spatter thrown out along the grain
        const a = Math.random() * Math.PI * 2, r = s2 * (0.24 + Math.random() * 0.24);
        c.fillStyle = `rgba(46,9,6,${(0.3 + Math.random() * 0.5).toFixed(2)})`;
        c.beginPath();
        c.ellipse(s2 * 0.5 + Math.cos(a) * r, s2 * 0.5 + Math.sin(a) * r * 0.75,
          1 + Math.random() * 3, 0.8 + Math.random() * 1.6, a, 0, 7);
        c.fill();
      }
    });
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.2),
      new THREE.MeshBasicMaterial({ map: bloodTex, transparent: true, depthWrite: false }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(-0.05, 0.008, 0.02);
    bodyG.add(pool);
    const smear = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.45),
      new THREE.MeshBasicMaterial({ map: bloodTex, transparent: true, opacity: 0.45, depthWrite: false }));
    smear.rotation.x = -Math.PI / 2;
    smear.rotation.z = 0.3;
    smear.position.set(-1.35, 0.006, -0.18);
    bodyG.add(smear);
    // flies have found him
    const bfGeo = new THREE.BufferGeometry();
    bfGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
    const bodyFlies = new THREE.Points(bfGeo, fliesMat);
    bodyFlies.position.set(0, 0.45, 0.05);
    bodyFlies.frustumCulled = false;
    bodyG.add(bodyFlies);
    flyClusters.push(bodyFlies);
    bodyG.position.set(0.4, 0.17, 0.9);
    bodyG.rotation.y = -0.7;
    g.add(bodyG);
    // pale clay chinking pressed between the log courses — the wall reads as built, not stacked
    const chinkM = mat(0x9a9080);
    for (let row = 0; row < ROWS - 1; row++) {
      const cy3 = 0.52 + row * 0.44;
      const chB = new THREE.Mesh(new THREE.BoxGeometry(W - 0.4, 0.07, 0.1), chinkM);
      chB.position.set(0, cy3, -D / 2 - 0.16);
      g.add(chB);
      for (const s of [-1, 1]) {
        const chS = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, D - 0.4), chinkM);
        chS.position.set(s * (W / 2 + 0.16), cy3 + 0.22, 0);
        g.add(chS);
      }
    }
    // shuttered windows on both side walls, glass catching what light there is
    for (const s of [-1, 1]) {
      const wx3 = s * (W / 2 + 0.28);
      const wFrame = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.05, 1.35), shutterM);
      wFrame.position.set(wx3, 1.75, 1.1);
      g.add(wFrame);
      const wGlass = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.8, 1.1),
        new THREE.MeshPhongMaterial({ color: 0x232c30, shininess: 120, specular: 0x99aabb }));
      wGlass.position.set(wx3 + s * 0.04, 1.75, 1.1);
      g.add(wGlass);
      const mullV = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.82, 0.06), shutterM);
      mullV.position.set(wx3 + s * 0.06, 1.75, 1.1);
      g.add(mullV);
      const mullH = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 1.12), shutterM);
      mullH.position.set(wx3 + s * 0.06, 1.75, 1.1);
      g.add(mullH);
      for (const sh of [-1, 1]) { // shutters — the far one sags off its hinge
        const shut = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.6), plankM);
        shut.position.set(wx3 + s * 0.05, sh > 0 ? 1.66 : 1.72, 1.1 + sh * 1.02);
        shut.rotation.x = sh > 0 ? 0.14 : 0;
        g.add(shut);
      }
    }
    // moss taking the north slope of the roof
    const mossM = mat(0x3f5230);
    for (let i = 0; i < 8; i++) {
      const mos = new THREE.Mesh(jitter(new THREE.SphereGeometry(0.3 + rng() * 0.3, 7, 5), 0.08), mossM);
      mos.scale.y = 0.18;
      const mz3 = -(0.7 + rng() * 2.4);
      mos.position.set(-W / 2 + 1 + rng() * (W - 2),
        wallTop + RISE * Math.max(0.05, 1 - Math.abs(mz3) / HSPAN) + 0.14, mz3);
      g.add(mos);
    }
    // the rain barrel by the porch, still catching what the roof sheds
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.38, 1.0, 10), plankM);
    barrel.position.set(2.9, 0.5, D / 2 + 0.5);
    g.add(barrel);
    for (const hy of [0.25, 0.8]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.025, 5, 12), mat(0x3a352c));
      hoop.rotation.x = Math.PI / 2;
      hoop.position.set(2.9, hy, D / 2 + 0.5);
      g.add(hoop);
    }
    const bWater = new THREE.Mesh(new THREE.CircleGeometry(0.36, 10),
      new THREE.MeshPhongMaterial({ color: 0x1a2320, shininess: 140, specular: 0x667788 }));
    bWater.rotation.x = -Math.PI / 2;
    bWater.position.set(2.9, 1.02, D / 2 + 0.5);
    g.add(bWater);
    // earth banked up against the base all round — the cabin sits IN the ground, not on it
    const mudM2 = mat(0x42341f), mudM3 = mat(0x382b18);
    const under = new THREE.Mesh(new THREE.BoxGeometry(W + 0.8, 1.3, D + 0.8), mudM3);
    under.position.y = -0.5;
    g.add(under);
    for (const [bx, bz, lx, lz, rx, rz] of [
      [0, -D / 2 - 0.6, W + 2.4, 1.6, -0.42, 0],
      [-3.85, D / 2 + 0.6, 2.7, 1.6, 0.42, 0],   // front banks flank the porch
      [3.85, D / 2 + 0.6, 2.7, 1.6, 0.42, 0],
      [-W / 2 - 0.6, 0, 1.6, D + 2.4, 0, 0.42],
      [W / 2 + 0.6, 0, 1.6, D + 2.4, 0, -0.42],
    ]) {
      const bank = new THREE.Mesh(new THREE.BoxGeometry(lx, 0.18, lz), mudM2);
      bank.position.set(bx, 0.16, bz);
      bank.rotation.x = rx;
      bank.rotation.z = rz;
      g.add(bank);
    }
    for (let i = 0; i < 12; i++) { // shovelled clods pressed up against the walls
      const onX = i % 2 === 0;
      let mx = onX ? (rng() * 2 - 1) * (W / 2) : (rng() < 0.5 ? -1 : 1) * (W / 2 + 0.3);
      const mz = onX ? (rng() < 0.5 ? -1 : 1) * (D / 2 + 0.3) : (rng() * 2 - 1) * (D / 2);
      if (mz > 0 && Math.abs(mx) < 2) mx = 2.3 * (mx < 0 ? -1 : 1); // keep the doorway clear
      const mound = new THREE.Mesh(jitter(new THREE.DodecahedronGeometry(0.3 + rng() * 0.25), 0.12), i % 3 ? mudM2 : mudM3);
      mound.position.set(mx, 0.1, mz);
      mound.scale.y = 0.5;
      mound.rotation.y = rng() * 3;
      g.add(mound);
    }
    g.position.set(CABIN.x, y, CABIN.z);
    g.rotation.y = 0.5;
    enableShadows(g);
    scene.add(g);
  }

  /* the mud path from the crash clearing to the cabin: one continuous trodden
     ribbon, wandering the way walked paths do, marked by cairns — with a noose
     and old kills strewn along the way */
  {
    // one trodden mud texture for every walked path: soft grassy edges, churned
    // mottle, TWO worn lines with a beaten strip between them, boot dabs, and
    // standing water catching what light there is
    const ribbonTex = makeCanvasTex(128, (c, s) => {
      c.clearRect(0, 0, s, s);
      const grad = c.createLinearGradient(0, 0, s, 0);
      grad.addColorStop(0, 'rgba(66,52,33,0)');
      grad.addColorStop(0.14, 'rgba(66,52,33,.8)');
      grad.addColorStop(0.5, 'rgba(58,46,29,.95)');
      grad.addColorStop(0.86, 'rgba(66,52,33,.8)');
      grad.addColorStop(1, 'rgba(66,52,33,0)');
      c.fillStyle = grad; c.fillRect(0, 0, s, s);
      for (let i = 0; i < 200; i++) { // churned mottle
        c.fillStyle = i % 2 ? 'rgba(43,34,20,.3)' : 'rgba(87,69,44,.28)';
        c.beginPath();
        c.arc(Math.random() * s, Math.random() * s, 1.5 + Math.random() * 4, 0, 7);
        c.fill();
      }
      for (const cx3 of [0.34, 0.62]) { // two worn lines, the way feet actually fall
        c.globalAlpha = 0.34;
        for (let y = 0; y < s; y += 3) {
          c.fillStyle = '#2b2214';
          c.fillRect(s * cx3 + (Math.random() - 0.3) * s * 0.06, y, 2.5, 2.5);
        }
        c.globalAlpha = 0.22; // boot dabs pressed into each line
        for (let i = 0; i < 8; i++) {
          c.fillStyle = '#241c10';
          c.beginPath();
          c.ellipse(s * cx3 + (Math.random() - 0.5) * s * 0.05, Math.random() * s, 2.2, 4.5, (Math.random() - 0.5) * 0.5, 0, 7);
          c.fill();
        }
      }
      c.globalAlpha = 0.5; // standing water in the deepest ruts
      for (let i = 0; i < 5; i++) {
        c.fillStyle = '#3d4148';
        c.beginPath();
        c.ellipse(s * (0.3 + Math.random() * 0.4), Math.random() * s, 3 + Math.random() * 5, 2 + Math.random() * 3, 0.3, 0, 7);
        c.fill();
      }
      c.globalAlpha = 0.3; // grass creeping back in from both edges
      for (let i = 0; i < 60; i++) {
        const edge = Math.random() < 0.5 ? Math.random() * 0.16 : 1 - Math.random() * 0.16;
        c.fillStyle = '#3c4a2c';
        c.fillRect(s * edge, Math.random() * s, 1.5, 2.5);
      }
      c.globalAlpha = 1;
    });
    const ribbonM = new THREE.MeshLambertMaterial({
      map: ribbonTex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    // a triangle strip hugging the terrain, one per walked leg
    function buildRibbon(A, B) {
      const LEN = Math.hypot(B.x - A.x, B.z - A.z);
      const trailPt = t => {
        const wob = Math.sin(t * 9.2) * Math.min(6, LEN * 0.035) + Math.sin(t * 23) * Math.min(2.5, LEN * 0.015);
        return {
          x: lerp(A.x, B.x, t) + (B.z - A.z) / LEN * wob,
          z: lerp(A.z, B.z, t) - (B.x - A.x) / LEN * wob,
        };
      };
      const SEGS = Math.floor(LEN / 2);
      const pos = new Float32Array((SEGS + 1) * 2 * 3);
      const uv = new Float32Array((SEGS + 1) * 2 * 2);
      const idx = [];
      for (let i = 0; i <= SEGS; i++) {
        const t = i / SEGS;
        const p = trailPt(t);
        const pa = trailPt(Math.max(0, t - 0.004)), pb = trailPt(Math.min(1, t + 0.004));
        let tx2 = pb.x - pa.x, tz2 = pb.z - pa.z;
        const tl = Math.max(1e-5, Math.hypot(tx2, tz2));
        tx2 /= tl; tz2 /= tl;
        const nx2 = -tz2, nz2 = tx2; // sideways across the path
        const halfW = 1.15 + Math.sin(t * 31) * 0.25 + Math.sin(t * 7.3) * 0.2; // width breathes
        for (const [side, sgn] of [[0, 1], [1, -1]]) {
          const vx2 = p.x + nx2 * halfW * sgn, vz2 = p.z + nz2 * halfW * sgn;
          const vi = (i * 2 + side) * 3;
          pos[vi] = vx2;
          pos[vi + 1] = groundY(vx2, vz2) + 0.045;
          pos[vi + 2] = vz2;
          uv[(i * 2 + side) * 2] = side;
          uv[(i * 2 + side) * 2 + 1] = t * LEN / 3.2;
        }
        if (i < SEGS) {
          const a2 = i * 2;
          idx.push(a2, a2 + 2, a2 + 1, a2 + 1, a2 + 2, a2 + 3); // wound so the faces look up
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const ribbon = new THREE.Mesh(geo, ribbonM);
      ribbon.receiveShadow = true;
      scene.add(ribbon);
    }
    for (const L of TRAIL_LEGS) buildRibbon(L.a, L.b);
    // half way along the cabin leg, a dead tree leans over the trail — and a noose hangs from it
    {
      const t = 0.52;
      const wob = Math.sin(t * 9.2) * 6 + Math.sin(t * 23) * 2.5;
      const nx2 = lerp(TRAIL_A.x, TRAIL_B.x, t) + (TRAIL_B.z - TRAIL_A.z) / TRAIL_LEN * (wob + 2.2);
      const nz2 = lerp(TRAIL_A.z, TRAIL_B.z, t) - (TRAIL_B.x - TRAIL_A.x) / TRAIL_LEN * (wob + 2.2);
      const base = groundY(nx2, nz2);
      const deadM = mat(0x574f42, { map: barkTex });
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, 5.2, 6), deadM);
      trunk.position.set(nx2, base + 2.5, nz2);
      trunk.rotation.z = 0.14;
      trunk.castShadow = true;
      scene.add(trunk);
      addCollider(nx2, nz2, 0.3);
      const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, 2.6, 5), deadM);
      branch.position.set(nx2 + 1.4, base + 3.9, nz2);
      branch.rotation.z = Math.PI / 2 - 0.12;
      branch.castShadow = true;
      scene.add(branch);
      const ropeM = mat(0x8a7a58);
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 1.5, 5), ropeM);
      rope.position.set(nx2 + 2.1, base + 3.15, nz2);
      scene.add(rope);
      const knot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), ropeM);
      knot.position.set(nx2 + 2.1, base + 2.42, nz2);
      scene.add(knot);
      const loop = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.03, 6, 12), ropeM);
      loop.position.set(nx2 + 2.1, base + 2.2, nz2);
      loop.rotation.y = 0.4;
      scene.add(loop);
    }
    /* old kills — bones and dark stains, strewn through the woods and thicker near the trail */
    const splatTex = makeCanvasTex(128, (c, s) => {
      c.clearRect(0, 0, s, s);
      // a dried brown rim first — old blood oxidises from the outside in
      for (let i = 0; i < 10; i++) {
        const a = Math.random() * 7, r = s * (0.1 + Math.random() * 0.16);
        c.fillStyle = `rgba(62,26,14,${(0.3 + Math.random() * 0.25).toFixed(2)})`;
        c.beginPath();
        c.ellipse(s / 2 + Math.cos(a) * r * 0.6, s / 2 + Math.sin(a) * r * 0.6, r, r * 0.7, a, 0, 7);
        c.fill();
      }
      // the darker heart of it, still nearly black
      c.fillStyle = 'rgba(34,7,4,.88)';
      c.beginPath(); c.ellipse(s / 2, s / 2, s * 0.17, s * 0.12, 0.4, 0, 7); c.fill();
      c.fillStyle = 'rgba(46,10,6,.7)';
      c.beginPath(); c.ellipse(s / 2 + 4, s / 2 - 3, s * 0.13, s * 0.16, 1.2, 0, 7); c.fill();
      // droplets thrown outward when it happened, tailing off with distance
      for (let i = 0; i < 34; i++) {
        const a = Math.random() * 7, r = s * (0.18 + Math.random() * 0.3);
        c.fillStyle = `rgba(48,12,7,${(0.28 + Math.random() * 0.4).toFixed(2)})`;
        c.beginPath();
        c.ellipse(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r,
          1 + Math.random() * 2.4, 0.7 + Math.random() * 1.4, a, 0, 7);
        c.fill();
      }
    });
    const splatM = new THREE.MeshLambertMaterial({ map: splatTex, transparent: true, depthWrite: false });
    const boneM = mat(0xd8cfb4);
    function gore(x, z, big) {
      const base = groundY(x, z);
      const splat = new THREE.Mesh(new THREE.CircleGeometry(big ? 1.2 : 0.7, 8), splatM);
      splat.rotation.x = -Math.PI / 2;
      splat.rotation.z = rng() * 7;
      splat.position.set(x, base + 0.035, z);
      scene.add(splat);
      const n = big ? 4 + Math.floor(rng() * 3) : 2 + Math.floor(rng() * 2);
      for (let k = 0; k < n; k++) {
        const bone = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.045, 0.35 + rng() * 0.4, 4), boneM);
        const a = rng() * 7, r = rng() * (big ? 0.9 : 0.5);
        bone.position.set(x + Math.cos(a) * r, base + 0.06, z + Math.sin(a) * r);
        bone.rotation.set(Math.PI / 2, 0, rng() * 7);
        bone.castShadow = true;
        scene.add(bone);
      }
      if (big && rng() < 0.6) { // a skull, or most of one
        const sk = new THREE.Mesh(jitter(new THREE.SphereGeometry(0.14, 8, 6), 0.03), boneM);
        sk.scale.set(1.25, 0.85, 0.95);
        sk.position.set(x + 0.3, base + 0.12, z - 0.2);
        sk.castShadow = true;
        scene.add(sk);
      }
    }
    for (let i = 0; i < 20; i++) { // strewn across the whole forest
      const p = scatterPos();
      gore(p.x, p.z, rng() < 0.3);
    }
    for (const L of TRAIL_LEGS) { // and thicker along every walked leg
      const llen = Math.hypot(L.b.x - L.a.x, L.b.z - L.a.z);
      const wobA = Math.min(6, llen * 0.035), wobB = Math.min(2.5, llen * 0.015);
      for (let i = 0, n = clamp(Math.round(llen / 38), 1, 6); i < n; i++) {
        const t = 0.12 + rng() * 0.8;
        const wob = Math.sin(t * 9.2) * wobA + Math.sin(t * 23) * wobB;
        const off = (rng() - 0.5) * 7;
        const gx = lerp(L.a.x, L.b.x, t) + (L.b.z - L.a.z) / llen * (wob + off);
        const gz = lerp(L.a.z, L.b.z, t) - (L.b.x - L.a.x) / llen * (wob + off);
        if (!nearWater(gx, gz)) gore(gx, gz, rng() < 0.45);
      }
      // small cairns where each leg is hardest to see (long legs only)
      for (const ct of (llen < 70 ? [0.55] : [0.3, 0.62, 0.85])) {
        const wob = Math.sin(ct * 9.2) * wobA;
        const cx2 = lerp(L.a.x, L.b.x, ct) + (L.b.z - L.a.z) / llen * wob + 1.6;
        const cz2 = lerp(L.a.z, L.b.z, ct) - (L.b.x - L.a.x) / llen * wob;
        if (nearWater(cx2, cz2)) continue;
        const base = groundY(cx2, cz2);
        for (let k = 0; k < 3; k++) {
          const st = new THREE.Mesh(jitter(new THREE.DodecahedronGeometry(0.16 - k * 0.035), 0.05), mat(0x7d7d78));
          st.position.set(cx2, base + 0.1 + k * 0.17, cz2);
          st.rotation.y = k * 1.2;
          st.castShadow = true;
          scene.add(st);
        }
      }
    }
  }

  /* abandoned campsite — tent, cold fire ring, left in a hurry */
  {
    const y = groundY(CAMPSITE.x, CAMPSITE.z);
    const g = new THREE.Group();
    // A-frame tent, one side sagging
    const t1 = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.8), canvasM);
    t1.position.set(0, 0.75, -0.62);
    t1.rotation.x = -0.62;
    g.add(t1);
    const t2 = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.9), canvasM);
    t2.position.set(0, 0.68, 0.62);
    t2.rotation.x = 0.72;
    t2.rotation.y = 0.06; // sagging off its pole
    g.add(t2);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.7, 5), logM);
    pole.rotation.z = Math.PI / 2;
    pole.position.y = 1.3;
    g.add(pole);
    // cold fire ring + bench log
    for (let i = 0; i < 7; i++) {
      const st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.18), stoneM);
      const a = i / 7 * Math.PI * 2;
      st.position.set(3 + Math.cos(a) * 0.6, 0.1, 1.5 + Math.sin(a) * 0.6);
      g.add(st);
    }
    const ash = new THREE.Mesh(new THREE.CircleGeometry(0.5, 8), mat(0x1e1c1a));
    ash.rotation.x = -Math.PI / 2;
    ash.position.set(3, 0.04, 1.5);
    g.add(ash);
    const bench = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.8, 6), logM2);
    bench.rotation.set(0, 0.4, Math.PI / 2);
    bench.position.set(3.2, 0.16, 3);
    g.add(bench);
    g.position.set(CAMPSITE.x, y, CAMPSITE.z);
    g.rotation.y = -0.4;
    enableShadows(g);
    scene.add(g);
    addCollider(CAMPSITE.x, CAMPSITE.z, 1.2); // the tent
    // the pack they left behind
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.25), mat(0x4a5a40));
    pack.position.set(CAMPSITE.x + 1.2, y + 0.25, CAMPSITE.z + 1.8);
    pack.rotation.set(0.4, 0.8, 0.3); // tipped over
    scene.add(pack);
    addInteractable(pack, 'search', 'abandoned pack', 'pack', {});
  }

  /* the hollow — bare, sunken, wrong. the story ends here */
  {
    const y = groundY(HOLLOW.x, HOLLOW.z);
    const g = new THREE.Group();
    // dead, blackened earth
    const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 18), mat(0x14120e));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.04;
    g.add(floor);
    // a ring of huge dead trees leaning inward
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.42, 7.5, 5), mat(0x453f35, { map: barkTex }));
      trunk.position.set(Math.cos(a) * 10.5, 3.4, Math.sin(a) * 10.5);
      trunk.rotation.z = Math.cos(a) * 0.22;
      trunk.rotation.x = -Math.sin(a) * 0.22; // all of them lean toward the middle
      g.add(trunk);
    }
    // old bones, none of them arranged by accident
    for (let i = 0; i < 10; i++) {
      const bone = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.5 + rng() * 0.6, 4), mat(0xd0c6ac));
      const a = rng() * Math.PI * 2, r = 2 + rng() * 7;
      bone.position.set(Math.cos(a) * r, 0.1, Math.sin(a) * r);
      bone.rotation.set(Math.PI / 2, 0, rng() * Math.PI);
      g.add(bone);
    }
    // his last camp: a cold fire ring and a bedroll, at the lip
    for (let i = 0; i < 6; i++) {
      const st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.16), mat(0x5c5c5c));
      const a = i / 6 * Math.PI * 2;
      st.position.set(8 + Math.cos(a) * 0.5, 0.1, 8 + Math.sin(a) * 0.5);
      g.add(st);
    }
    const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.7, 6), mat(0x4a5240));
    roll.rotation.z = Math.PI / 2;
    roll.position.set(9.4, 0.2, 7.2);
    g.add(roll);
    enableShadows(g);
    g.position.set(HOLLOW.x, y, HOLLOW.z);
    scene.add(g);
  }

  /* hunter's blind — a platform up a tree, ladder half-rotted */
  {
    const y = groundY(BLIND.x, BLIND.z);
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, 5.4, 6), logM2);
    trunk.position.y = 2.7;
    g.add(trunk);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 1.9), plankM);
    deck.position.y = 3.4;
    g.add(deck);
    for (const [sx, sz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 4), logM);
      post.position.set(sx, 3.75, sz);
      g.add(post);
    }
    for (let i = 0; i < 5; i++) { // ladder rungs, a couple missing
      if (i === 2) continue;
      const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 4), logM);
      rung.rotation.z = Math.PI / 2;
      rung.position.set(0.55, 0.5 + i * 0.65, 0.2);
      g.add(rung);
    }
    g.position.set(BLIND.x, y, BLIND.z);
    enableShadows(g);
    scene.add(g);
    addCollider(BLIND.x, BLIND.z, 0.5); // the blind's tree
    // a weatherproof cache strapped to the trunk
    const cache = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.3), mat(0x3f4a52));
    cache.position.set(BLIND.x + 0.6, y + 1.1, BLIND.z - 0.3);
    cache.rotation.y = 0.4;
    scene.add(cache);
    addInteractable(cache, 'search', "hunter's cache", 'cache', {});
  }
}

/* ---------------- editor-placed props ---------------- */
{
  const trunkM = mat(0x4a3a28, { map: barkTex });
  const canopyM = mat(0x2f4828, { map: leafTex });
  addWind(canopyM, 0.1, 1.1, true);
  const clumpCan = boughCone(2.2, 4.2, 8, 0.45, 0.3), clumpTop = boughCone(1.35, 3.2, 8, 0.36, 0.24);
  const deadM = mat(0x5c554a, { map: barkTex });
  const stoneM = mat(0x757168);
  for (const pr of (MAPCFG.props || [])) {
    const bx = pr.x, bz = pr.z;
    const g = new THREE.Group();
    switch (pr.type) {
      case 'trees': { // a tight clump of pines
        for (let i = 0; i < 12; i++) {
          const a = rng() * Math.PI * 2, r = rng() * 9;
          const x = bx + Math.cos(a) * r, z = bz + Math.sin(a) * r;
          const y = groundY(x, z), s = 0.8 + rng() * 0.7;
          const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 3.2, 5), trunkM);
          trunk.position.set(x, y + 1.6 * s, z); trunk.scale.setScalar(s);
          g.add(trunk);
          const can = new THREE.Mesh(clumpCan, canopyM);
          can.position.set(x, y + 3.9 * s, z); can.scale.setScalar(s); can.rotation.y = rng() * 3;
          g.add(can);
          const can2 = new THREE.Mesh(clumpTop, canopyM);
          can2.position.set(x, y + 5.5 * s, z); can2.scale.setScalar(s); can2.rotation.y = rng() * 3;
          g.add(can2);
          addCollider(x, z, 0.38 * s);
        }
        break;
      }
      case 'deadtrees': { // a stand of bare grey trunks
        for (let i = 0; i < 6; i++) {
          const a = rng() * Math.PI * 2, r = rng() * 6;
          const x = bx + Math.cos(a) * r, z = bz + Math.sin(a) * r;
          const y = groundY(x, z), s = 0.8 + rng() * 0.6;
          const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.26, 4.8, 5), deadM);
          trunk.position.set(x, y + 2.4 * s, z);
          trunk.scale.setScalar(s);
          trunk.rotation.z = rng() * 0.16 - 0.08;
          g.add(trunk);
          addCollider(x, z, 0.28 * s);
        }
        break;
      }
      case 'boulders': {
        for (let i = 0; i < 4; i++) {
          const a = rng() * Math.PI * 2, r = rng() * 3.5;
          const x = bx + Math.cos(a) * r, z = bz + Math.sin(a) * r;
          const s = 0.9 + rng() * 1.4;
          const b = new THREE.Mesh(new THREE.DodecahedronGeometry(0.8), stoneM);
          b.position.set(x, groundY(x, z) + 0.35 * s, z);
          b.scale.set(s, s * 0.75, s);
          b.rotation.set(rng() * 3, rng() * 3, 0);
          g.add(b);
          addCollider(x, z, 0.75 * s);
        }
        break;
      }
      case 'berries': { // a wild berry patch — food
        for (let i = 0; i < 3; i++) {
          const a = rng() * Math.PI * 2, r = 1 + rng() * 2.5;
          const x = bx + Math.cos(a) * r, z = bz + Math.sin(a) * r;
          const bg = new THREE.Group();
          const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 0), mat(0x3f5c2e));
          bush.scale.y = 0.8; bg.add(bush);
          for (let b = 0; b < 5; b++) {
            const berry = new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 0), mat(0x6d2438));
            const ba = rng() * Math.PI * 2;
            berry.position.set(Math.cos(ba) * 0.5, 0.15 + rng() * 0.4, Math.sin(ba) * 0.5);
            bg.add(berry);
          }
          bg.position.set(x, groundY(x, z) + 0.45, z);
          scene.add(bg);
          addInteractable(bg, 'resource', 'Berries', 'Berries', { give: { Berries: 2 } });
        }
        break;
      }
      case 'tent': { // an abandoned tent with something left in it
        const t1 = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.8), mat(0x7d7458, { side: THREE.DoubleSide }));
        t1.position.set(bx, groundY(bx, bz) + 0.75, bz - 0.62);
        t1.rotation.x = -0.62;
        g.add(t1);
        const t2 = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.9), mat(0x736a50, { side: THREE.DoubleSide }));
        t2.position.set(bx, groundY(bx, bz) + 0.68, bz + 0.62);
        t2.rotation.x = 0.72;
        g.add(t2);
        const bundle = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.3), mat(0x4a5a40));
        bundle.position.set(bx + 1.6, groundY(bx + 1.6, bz) + 0.15, bz);
        scene.add(bundle);
        addInteractable(bundle, 'search', 'abandoned bundle', 'bundle' + bx, {});
        break;
      }
      case 'ruin': { // the corner of something that used to be a building
        const w1 = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.4, 0.3), mat(0x5d4930, { map: barkTex }));
        w1.position.set(bx, groundY(bx, bz) + 0.7, bz - 1.5);
        g.add(w1);
        const w2 = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.1, 2.6), mat(0x52402a, { map: barkTex }));
        w2.position.set(bx - 1.6, groundY(bx - 1.6, bz) + 0.55, bz);
        g.add(w2);
        const slab = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.12, 2.4), mat(0x4a3a28));
        slab.position.set(bx + 0.4, groundY(bx, bz) + 0.6, bz + 0.4);
        slab.rotation.set(0.5, 0.2, 0.15);
        g.add(slab);
        break;
      }
      case 'carcass': // something died here — same skeletal remains as the story carcasses
        carcass(g, bx, bz, 0.45 + rng() * 0.25, 0x5c3a35);
        break;
      // 'clearing' has no visuals — it just keeps the forest out (see placeOK)
    }
    if (g.children.length) {
      enableShadows(g);
      scene.add(g);
    }
  }
}

/* camp fire — lit from the start; your house gets built around it (B) */
let fireLight;
{
  // fire: stone ring, logs, flame, light
  const fy = groundY(FIRE.x, FIRE.z);
  const fg = new THREE.Group();
  for (let i = 0; i < 8; i++) {
    const st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22), mat(0x6f6f6f));
    const a = i / 8 * Math.PI * 2;
    st.position.set(Math.cos(a) * 0.75, 0.12, Math.sin(a) * 0.75);
    fg.add(st);
  }
  for (let i = 0; i < 3; i++) {
    const lg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1, 5), mat(0x3f3020));
    lg.rotation.z = Math.PI / 2; lg.rotation.y = i * 1.1;
    lg.position.y = 0.14;
    fg.add(lg);
  }
  // the fire itself — a jet of overlapping flame tongues above the logs
  addFlameJet(fg, 0, 0.28, 0, 1, 12);
  // embers drifting up out of the heat
  {
    const N = 22, pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (rng() - 0.5) * 0.3;
      pos[i * 3 + 1] = rng() * 1.5;
      pos[i * 3 + 2] = (rng() - 0.5) * 0.3;
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const embers = new THREE.Points(eg, new THREE.PointsMaterial({
      color: 0xffa040, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    embers.frustumCulled = false;
    fg.add(embers);
    window._embers = embers;
  }
  // a faint drift of smoke that dies out a couple of feet above the flames
  addSmokePuffs(fg, 0, 1.5, 0, 0x9aa096, 6, 0.7);
  fireLight = new THREE.PointLight(0xff8830, 1.3, 22, 1.6);
  fireLight.position.y = 1;
  fg.add(fireLight);
  fg.position.set(FIRE.x, fy, FIRE.z);
  scene.add(fg);
  window._fireGroup = fg;
}
function nearFire() {
  return Math.hypot(state.pos.x - FIRE.x, state.pos.z - FIRE.z) < 6;
}

/* ---------------- resource nodes ---------------- */
function addInteractable(mesh, type, label, key, data) {
  if (type === 'resource') return; // loose sticks, stones, food etc. are scenery now — nothing can be carried
  mesh.updateMatrixWorld();
  const pos = new THREE.Vector3();
  mesh.getWorldPosition(pos);
  interactables.push({ mesh, type, label, key, pos, data: data || {} });
}
function removeInteractable(it) {
  const i = interactables.indexOf(it);
  if (i >= 0) interactables.splice(i, 1);
  if (it.mesh.parent) it.mesh.parent.remove(it.mesh);
}

function spawnResourceNodes() {
  const stickM = mat(0x6b5232), stoneM = mat(0x7d7d7d), mudM = mat(0x4c3b26),
        leafM = mat(0x3f5c2e), berryM = mat(0x6d2438);

  function stick(len, r, item, n) {
    for (let i = 0; i < n; i++) {
      const p = scatterPos();
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.15, len, 5), stickM);
      m.position.set(p.x, groundY(p.x, p.z) + r + 0.03, p.z);
      m.rotation.set(Math.PI / 2, 0, rng() * Math.PI * 2);
      scene.add(m);
      addInteractable(m, 'resource', item, item, { give: { [item]: 1 } });
    }
  }
  stick(0.7, 0.045, 'Small Stick', Math.round(40 * DENS));
  stick(1.1, 0.06, 'Stick', Math.round(30 * DENS));
  stick(1.8, 0.1, 'Branch', Math.round(24 * DENS));

  function rock(sz, item, n) {
    for (let i = 0; i < n; i++) {
      const p = scatterPos();
      const m = new THREE.Mesh(new THREE.DodecahedronGeometry(sz), stoneM);
      m.position.set(p.x, groundY(p.x, p.z) + sz * 0.55, p.z);
      m.rotation.set(rng() * 3, rng() * 3, 0);
      scene.add(m);
      addInteractable(m, 'resource', item, item, { give: { [item]: 1 } });
    }
  }
  rock(0.14, 'Pebble', Math.round(28 * DENS));
  rock(0.3, 'Stone', Math.round(18 * DENS));

  // mud — banks of river/pond only
  for (let i = 0; i < 14; i++) {
    let x, z, tries = 0;
    do {
      if (rng() < 0.7) { x = RIVER_X + (rng() < 0.5 ? -1 : 1) * (RIVER_HALF + 1.2 + rng() * 2); z = (rng() * 2 - 1) * (WORLD - 15); }
      else { const a = rng() * Math.PI * 2; x = POND.x + Math.cos(a) * (POND.r + 1.5); z = POND.z + Math.sin(a) * (POND.r + 1.5); }
    } while (++tries < 20 && Math.abs(x) > WORLD - 6);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.16, 7), mudM);
    m.position.set(x, groundY(x, z) + 0.08, z);
    scene.add(m);
    addInteractable(m, 'resource', 'Mud', 'Mud', { give: { Mud: 1 } });
  }

  // leaf bushes (give 2 leaves) and berry bushes (give 2 berries)
  for (let i = 0; i < Math.round(22 * DENS); i++) {
    const p = scatterPos();
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.65, 0), leafM);
    m.position.set(p.x, groundY(p.x, p.z) + 0.45, p.z);
    m.scale.y = 0.75;
    scene.add(m);
    addInteractable(m, 'resource', 'Leaves', 'Leaves', { give: { Leaves: 2 } });
  }
  for (let i = 0; i < Math.round(15 * DENS); i++) {
    const p = scatterPos();
    const g = new THREE.Group();
    const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 0), leafM);
    bush.scale.y = 0.8; g.add(bush);
    for (let b = 0; b < 5; b++) {
      const berry = new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 0), berryM);
      const a = rng() * Math.PI * 2;
      berry.position.set(Math.cos(a) * 0.5, 0.15 + rng() * 0.4, Math.sin(a) * 0.5);
      g.add(berry);
    }
    g.position.set(p.x, groundY(p.x, p.z) + 0.45, p.z);
    scene.add(g);
    addInteractable(g, 'resource', 'Berries', 'Berries', { give: { Berries: 2 } });
  }
}
spawnResourceNodes();

/* ---------------- animal tracks (set dressing) ---------------- */
{
  const spots = [{ x: 38, z: -32 }, { x: -48, z: -66 }, { x: -30, z: 55 }];
  const trackM = mat(0x33291c);
  for (const s of spots) {
    const g = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const t = new THREE.Mesh(new THREE.CircleGeometry(0.12, 6), trackM);
      t.rotation.x = -Math.PI / 2;
      t.position.set(i * 0.5 - 1.2 + (i % 2) * 0.22, 0.04, (i % 2) * 0.3);
      g.add(t);
    }
    g.position.set(s.x, groundY(s.x, s.z), s.z);
    scene.add(g);
  }
}

/* ============================================================
   STORY — the quest chain
   wreck -> map pieces -> cabin -> key -> body & letter ->
   the great hill -> broken generator -> the encounter -> radio
   ============================================================ */
const noteTex = makeCanvasTex(128, (c, s) => {
  // pale paper with cramped handwriting — unreadable at arm's length, unmistakably writing
  c.fillStyle = '#ddd7c2'; c.fillRect(0, 0, s, s);
  c.fillStyle = 'rgba(150,138,110,.25)';
  c.fillRect(0, 0, s, 3); c.fillRect(0, s - 3, s, 3); // handled edges, a little grubby
  c.strokeStyle = 'rgba(58,50,38,.6)'; c.lineWidth = 1.6;
  for (let y = 20; y < s - 10; y += 10) {
    c.beginPath();
    let px = 12 + Math.random() * 8;
    c.moveTo(px, y);
    const end = s - 12 - Math.random() * 34;
    while (px < end) { px += 5 + Math.random() * 7; c.lineTo(px, y + (Math.random() - 0.5) * 3.4); }
    c.stroke();
  }
});
const paperM = new THREE.MeshBasicMaterial({ map: noteTex, side: THREE.DoubleSide });

const MAP_PIECES = [
  { title: 'A warning, folded small', body:
`There is something in these woods. No one has ever seen it clearly enough to say what. You will know it is near when the birds stop singing.` },
  { x: -34, z: 27, title: 'My diary', body:
`Third night. Something crossed the far side of the pond, upright, and kept crossing it for an hour. I did not light the lamp. Nothing out here is safe after dark.` },
  { x: 42, z: -16, title: 'My diary', body:
`I finally saw it, at the treeline, just before the clouds took the moon. I want to write that it was a man. It stood like one, almost — head and shoulders taller than any man, wrong at the joints, skin the colour of something dug up. It watched me for an hour. It never once breathed.` },
  { x: -15, z: -45, title: 'My diary', body:
`The fire-watch tower on the great hill is the one place it will not go. The lookout kept a radio at the top. If the radio still works, so does hope.` },
  { x: 30, z: 41, title: 'My diary', body:
`Whatever you hear behind you, do not answer it.` },
];

const CABIN_LETTER = { title: 'A letter, weighed down by a lamp', body:
`If you have found this letter, you are in serious danger.

It knows this cabin now. I stayed too long — it learns a place the longer you stay in it.

There is a radio at the top of the fire-watch tower on the great hill, ${compassWord(MAPCFG.hill)} of here, past the river. It still worked two winters ago. Get there, call for help, and be off the ground by dark.

Do not strike out over open ground for it. The only way I trust is the trapper's round — out past his shed, then on to the hill. I have drawn the way as far as his shed on the back of this. Reach the shed first; he kept his own map there, and the rest of the way is marked on it.

If the set is dead, the generator will wake it. It sits at the foot of the hill — follow the power line down from the tower. Take tools. Everything loose walks off out here.

— Elliott James Pluck` };

/* the map itself — the whole forest in one careful hand */
/* a hand-drawn route sketch: only the places asked for, trees everywhere else.
   The view is fitted to the route, the way someone actually sketches a leg of a journey. */
function makeRouteMap(opts) {
  const S = 420;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  // aged paper with stains and handled edges
  g.fillStyle = '#d3cbb0';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 18; i++) {
    g.fillStyle = `rgba(${110 + Math.random() * 30 | 0},${88 + Math.random() * 20 | 0},50,${0.04 + Math.random() * 0.05})`;
    g.beginPath();
    g.arc(Math.random() * S, Math.random() * S, 12 + Math.random() * 40, 0, 7);
    g.fill();
  }
  g.strokeStyle = 'rgba(120,98,60,.35)';
  g.lineWidth = 8;
  g.strokeRect(2, 2, S - 4, S - 4);
  // fit the view to the given places, square, with generous margins
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of opts.spots) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const M = 70;
  minX -= M; maxX += M; minZ -= M; maxZ += M;
  const ext = Math.max(maxX - minX, maxZ - minZ);
  const cx4 = (minX + maxX) / 2, cz4 = (minZ + maxZ) / 2;
  const pad = 34, span = S - pad * 2;
  const px = wx => pad + (wx - (cx4 - ext / 2)) / ext * span;
  const py = wz => pad + (wz - (cz4 - ext / 2)) / ext * span;
  g.strokeStyle = '#4a3b26';
  g.fillStyle = '#4a3b26';
  g.lineCap = 'round';
  const wobble = () => (Math.random() - 0.5) * 3;
  // the river, when the route has to cross it
  if (opts.river) {
    g.lineWidth = 1.6;
    for (const off of [-9, 9]) {
      const rx = px(MAPCFG.riverX + off);
      if (rx < pad - 10 || rx > S - pad + 10) continue;
      g.beginPath();
      g.moveTo(rx + wobble(), pad - 6);
      for (let t = 0; t <= 1.02; t += 0.08) g.lineTo(rx + wobble(), pad + t * span);
      g.stroke();
    }
  }
  // the places themselves
  for (const p of opts.spots) {
    const sx2 = px(p.x), sz2 = py(p.z);
    if (p.type === 'cabin') { // a tiny pitched-roof square
      g.lineWidth = 1.5;
      g.strokeRect(sx2 - 5, sz2 - 4, 10, 8);
      g.beginPath(); g.moveTo(sx2 - 6, sz2 - 4); g.lineTo(sx2, sz2 - 9); g.lineTo(sx2 + 6, sz2 - 4); g.stroke();
    } else if (p.type === 'blind') { // a box up a bare tree
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(sx2, sz2 + 9); g.lineTo(sx2, sz2 - 4); g.stroke();
      g.strokeRect(sx2 - 5, sz2 - 10, 10, 7);
      g.beginPath(); g.moveTo(sx2 - 3, sz2 + 2); g.lineTo(sx2 + 3, sz2 + 5); g.stroke(); // the rotten ladder
    } else if (p.type === 'bridge') { // two little tick marks over the water
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(sx2 - 11, sz2 - 2.5); g.lineTo(sx2 + 11, sz2 - 2.5);
      g.moveTo(sx2 - 11, sz2 + 2.5); g.lineTo(sx2 + 11, sz2 + 2.5);
      g.stroke();
    } else if (p.type === 'tower') { // contour rings, and the tower on top
      g.lineWidth = 1.1;
      for (let r = 26; r > 8; r -= 6) {
        g.beginPath(); g.ellipse(sx2, sz2, r + wobble(), r * 0.8 + wobble(), 0.2, 0, 7); g.stroke();
      }
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(sx2 - 4, sz2 + 5); g.lineTo(sx2, sz2 - 8); g.lineTo(sx2 + 4, sz2 + 5);
      g.moveTo(sx2 - 3, sz2 + 1); g.lineTo(sx2 + 3, sz2 + 1);
      g.stroke();
      g.strokeRect(sx2 - 3, sz2 - 11, 6, 4);
    } else if (p.type === 'pond') { // a wobbly-shored blob, hatched the old way
      g.lineWidth = 1.4;
      const pr = Math.max(9, (p.r || 15) / ext * span);
      g.beginPath();
      for (let a2 = 0; a2 <= 6.6; a2 += 0.45) {
        const rr = pr + wobble();
        const X = sx2 + Math.cos(a2) * rr, Y = sz2 + Math.sin(a2) * rr * 0.72;
        if (a2 === 0) g.moveTo(X, Y); else g.lineTo(X, Y);
      }
      g.closePath(); g.stroke();
      g.lineWidth = 1.0;
      for (let i = -1; i <= 1; i++) {
        g.beginPath();
        g.moveTo(sx2 - pr * 0.5, sz2 + i * pr * 0.28); g.lineTo(sx2 + pr * 0.5, sz2 + i * pr * 0.28);
        g.stroke();
      }
    } else if (p.type === 'shed') { // a squat lean-to square
      g.lineWidth = 1.5;
      g.strokeRect(sx2 - 4, sz2 - 3, 8, 6);
      g.beginPath(); g.moveTo(sx2 - 5, sz2 - 3); g.lineTo(sx2 + 5, sz2 - 6); g.stroke();
      g.beginPath(); g.moveTo(sx2 + 1, sz2 - 1); g.lineTo(sx2 + 1, sz2 + 3); g.stroke(); // the door
    } else if (p.type === 'wreck') { // where it came down, marked with a cross
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(sx2 - 4, sz2 - 4); g.lineTo(sx2 + 4, sz2 + 4);
      g.moveTo(sx2 + 4, sz2 - 4); g.lineTo(sx2 - 4, sz2 + 4);
      g.stroke();
    }
  }
  // treeline scribbles — little humps everywhere the route isn't
  g.lineWidth = 1.0;
  for (let i = 0; i < 120; i++) {
    const tx = pad + Math.random() * span, ty = pad + Math.random() * span;
    if (opts.river && Math.abs(tx - px(MAPCFG.riverX)) < 18) continue;
    if (opts.spots.some(p => Math.hypot(tx - px(p.x), ty - py(p.z)) < (p.type === 'tower' ? 34 : p.type === 'pond' ? 28 : 20))) continue;
    g.beginPath();
    g.arc(tx, ty, 3 + Math.random() * 3, Math.PI, 0);
    g.stroke();
  }
  // the route, dotted the way he drew everything he wasn't sure of
  g.setLineDash([5, 7]);
  g.lineWidth = 1.4;
  for (let i = 0; i + 1 < opts.route.length; i++) {
    const a = opts.route[i], b = opts.route[i + 1];
    const mx2 = (a.x + b.x) / 2, mz2 = (a.z + b.z) / 2;
    const dx2 = b.x - a.x, dz2 = b.z - a.z, dl = Math.hypot(dx2, dz2) || 1;
    g.beginPath();
    g.moveTo(px(a.x), py(a.z));
    g.quadraticCurveTo(px(mx2 - dz2 / dl * ext * 0.06), py(mz2 + dx2 / dl * ext * 0.06), px(b.x), py(b.z));
    g.stroke();
  }
  g.setLineDash([]);
  // handwriting
  g.font = 'italic 14px Georgia';
  for (const p of opts.spots) g.fillText(p.label, px(p.x) - 24, py(p.z) + (p.type === 'tower' ? 42 : 24));
  // north arrow
  g.font = 'bold 14px Georgia';
  g.fillText('N', 14, 24);
  g.beginPath(); g.moveTo(19, 44); g.lineTo(14, 30); g.lineTo(24, 30); g.closePath(); g.fill();
  return c.toDataURL();
}

/* no map at the wreck any more. The cabin letter's map only runs as far as the
   shed — it does NOT give away the tower. That reveal is kept for the trapper's
   own map, found IN the shed, so the walk out to the shed still has a point. */
CABIN_LETTER.img = makeRouteMap({
  river: true,
  spots: [
    { x: CABIN.x, z: CABIN.z, type: 'cabin', label: 'the cabin' },
    { x: MAPCFG.riverX, z: MAPCFG.bridgeZ, type: 'bridge', label: 'the bridge' },
    { x: SHED.x, z: SHED.z, type: 'shed', label: 'the shed' },
  ],
  route: [{ x: CABIN.x, z: CABIN.z }, { x: 0, z: 8 },
          { x: MAPCFG.riverX, z: MAPCFG.bridgeZ }, { x: SHED.x, z: SHED.z }],
});
const BLIND_NOTE = { title: 'A map, weighted with a shell casing', body:
`If the cabin has gone wrong, do not go back for anything.

From the blind: down to the bridge, over the river, and up the great hill to the tower. Keep to the path.

Whatever keeps pace with you in the trees — it stops at the water.` };
BLIND_NOTE.img = makeRouteMap({
  river: true,
  spots: [
    { x: BLIND.x, z: BLIND.z, type: 'blind', label: 'the blind' },
    { x: MAPCFG.riverX, z: MAPCFG.bridgeZ, type: 'bridge', label: 'bridge' },
    { x: HILL.x, z: HILL.z, type: 'tower', label: 'the tower' },
  ],
  route: [{ x: BLIND.x, z: BLIND.z }, { x: MAPCFG.riverX, z: MAPCFG.bridgeZ }, { x: HILL.x, z: HILL.z }],
});
{ // the blind's map, pinned at the foot of its ladder
  const bm = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.75), paperM);
  bm.position.set(BLIND.x + 1.3, groundY(BLIND.x + 1.3, BLIND.z + 1) + 0.03, BLIND.z + 1);
  bm.rotation.x = -Math.PI / 2;
  bm.rotation.z = rng() * Math.PI * 2;
  scene.add(bm);
  addInteractable(bm, 'note', 'Read the marked map', 'blind-map', { note: BLIND_NOTE });
}
/* the notes all travel in the luggage now — five of the seven bags at the
   wreck carry them (assigned by pieceIdx where the bags are built) */
function foundPiece() {
  state.pieces++;
  $('note-count').textContent = `Notes found: ${state.pieces} / 5`;
  if (state.pieces >= 5 && state.quest < 2) {
    state.quest = 2;
    toast(`The pages tell one story — it starts at the cabin, ${compassWord(CABIN)} of here.`);
  } else if (state.quest === 0) {
    state.quest = 1; // found a loose piece before searching the wreck
  }
}

/* ---------------- the log shed, halfway between cabin and crash ---------------- */
const SHED_NOTE = { title: "The trapper's map", body:
`Drew this the winter I cut the shed logs, so I would stop losing my own tracks in the snow.

The cabin, the pond, the shed you are standing in, and the tower on the great hill. The dotted line is the walk I wore between them.

Whatever else you find marked out there — I did not draw it.` };
SHED_NOTE.img = makeRouteMap({
  river: true,
  spots: [
    { x: CABIN.x, z: CABIN.z, type: 'cabin', label: 'the cabin' },
    { x: POND.x, z: POND.z, type: 'pond', r: POND.r, label: 'the pond' },
    { x: HILL.x, z: HILL.z, type: 'tower', label: 'the tower' },
    { x: SHED.x, z: SHED.z, type: 'shed', label: 'my shed' },
    { x: 0, z: 3, type: 'wreck', label: '' },
  ],
  route: [{ x: CABIN.x, z: CABIN.z }, { x: 0, z: 8 }, { x: MAPCFG.riverX, z: MAPCFG.bridgeZ },
          { x: SHED.x, z: SHED.z }, { x: HILL.x, z: HILL.z }],
});
function shedRot(px, pz) { // shed local -> world
  const c = Math.cos(SHED_ROT), s = Math.sin(SHED_ROT);
  return { x: SHED.x + px * c + pz * s, z: SHED.z - px * s + pz * c };
}
{
  const sy = groundY(SHED.x, SHED.z);
  const g = new THREE.Group();
  g.position.set(SHED.x, sy, SHED.z);
  g.rotation.y = SHED_ROT;
  const logA = mat(0x5d4a30, { map: barkTex }), logB = mat(0x4e3d27, { map: barkTex }),
        plankM = mat(0x6a5436, { map: barkTex }), iron = mat(0x3a352c, { shininess: 30 });
  const W = 5.2, D = 4.2, R = 0.12, DOOR = 0.7;
  // stacked-log walls, doorway on the crash-facing side
  for (let r = 0; r < 11; r++) {
    const ry = 0.15 + r * 0.24, rm = r % 2 ? logA : logB;
    for (const s of [-1, 1]) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(R, R, D + 0.3, 7), rm);
      c.rotation.x = Math.PI / 2;
      c.position.set(s * W / 2, ry, 0);
      g.add(c);
    }
    const back = new THREE.Mesh(new THREE.CylinderGeometry(R, R, W + 0.3, 7), rm);
    back.rotation.z = Math.PI / 2;
    back.position.set(0, ry, -D / 2);
    g.add(back);
    if (ry > 2.1) { // header logs carry on over the doorway
      const h = new THREE.Mesh(new THREE.CylinderGeometry(R, R, W + 0.3, 7), rm);
      h.rotation.z = Math.PI / 2;
      h.position.set(0, ry, D / 2);
      g.add(h);
    } else {
      const segLen = W / 2 - DOOR;
      for (const s of [-1, 1]) {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(R, R, segLen, 7), rm);
        c.rotation.z = Math.PI / 2;
        c.position.set(s * (DOOR + segLen / 2), ry, D / 2);
        g.add(c);
      }
    }
  }
  // door jambs, corner posts, a packed plank floor
  for (const s of [-1, 1]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.25, 0.28), plankM);
    jamb.position.set(s * (DOOR + 0.07), 1.12, D / 2);
    g.add(jamb);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 2.85, 7), logB);
    post.position.set(sx * W / 2, 1.35, sz * D / 2);
    g.add(post);
  }
  const floor = new THREE.Mesh(new THREE.BoxGeometry(W - 0.2, 0.08, D - 0.2), mat(0x4a3a24, { map: barkTex }));
  floor.position.y = 0.05;
  g.add(floor);
  // a proper gabled roof: two plank slopes to a ridge log, battened in courses,
  // with plank gables closing the ends (same construction as the cabin's)
  const wallTop = 0.15 + 10 * 0.24 + R;
  const PITCH = 0.45, HSPAN = D / 2 + 0.75;
  const RISE = HSPAN * Math.tan(PITCH), SLOPE = HSPAN / Math.cos(PITCH);
  for (const s of [-1, 1]) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(W + 1.3, 0.12, SLOPE), plankM);
    slab.position.set(0, wallTop + RISE / 2 + 0.05, s * HSPAN / 2);
    slab.rotation.x = s * PITCH; // ridge high, eaves low
    g.add(slab);
    for (const u of [-1.0, 0.1, 1.1]) { // board courses so the slope reads as planks
      const bat = new THREE.Mesh(new THREE.BoxGeometry(W + 1.3, 0.06, 0.14), logB);
      bat.position.set(0, wallTop + RISE / 2 + 0.12 - s * u * Math.sin(PITCH), s * HSPAN / 2 + u * Math.cos(PITCH));
      g.add(bat);
    }
  }
  const ridge = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, W + 1.4, 7), logB);
  ridge.rotation.z = Math.PI / 2;
  ridge.position.set(0, wallTop + RISE + 0.08, 0);
  g.add(ridge);
  { // gable triangles
    const tri = new THREE.Shape();
    tri.moveTo(-HSPAN, 0); tri.lineTo(HSPAN, 0); tri.lineTo(0, RISE);
    tri.closePath();
    const triGeo = new THREE.ShapeGeometry(tri);
    const gableM = mat(0x624c30, { map: barkTex, side: THREE.DoubleSide });
    for (const s of [-1, 1]) {
      const gable = new THREE.Mesh(triGeo, gableM);
      gable.position.set(s * W / 2, wallTop, 0);
      gable.rotation.y = s * Math.PI / 2;
      g.add(gable);
    }
  }
  // the box: a joined plank chest with iron straps, its lid thrown back
  const chest = new THREE.Group();
  chest.position.set(-1.55, 0.09, -1.25);
  chest.rotation.y = 0.35;
  for (let i = 0; i < 3; i++) {
    const bm2 = i % 2 ? plankM : logA;
    for (const s of [-1, 1]) {
      const bd = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.17, 0.045), bm2);
      bd.position.set(0, 0.1 + i * 0.18, s * 0.27);
      chest.add(bd);
    }
    for (const s of [-1, 1]) {
      const bd = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.17, 0.5), bm2);
      bd.position.set(s * 0.42, 0.1 + i * 0.18, 0);
      chest.add(bd);
    }
  }
  const cbase = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.05, 0.56), logB);
  cbase.position.y = 0.03;
  chest.add(cbase);
  for (const s of [-1, 1]) { // iron corner straps and a sprung hasp
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.6), iron);
    strap.position.set(s * 0.36, 0.26, 0);
    chest.add(strap);
  }
  const hasp = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.04), iron);
  hasp.position.set(0, 0.44, 0.3);
  hasp.rotation.x = 0.5; // hanging open
  chest.add(hasp);
  // the lid, thrown back against the wall behind
  const lid = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.58), plankM);
  lid.position.set(0, 0.62, -0.48);
  lid.rotation.x = -1.85;
  chest.add(lid);
  for (const s of [-1, 1]) {
    const lstrap = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.58), iron);
    lstrap.position.set(s * 0.36, 0.645, -0.505);
    lstrap.rotation.x = -1.85;
    chest.add(lstrap);
  }
  const cavity = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.02, 0.48), mat(0x17130d));
  cavity.position.y = 0.3;
  chest.add(cavity);
  // the rolled map, leaning in the open box, tied with a cord
  const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.56, 8), mat(0xc9c0a2));
  roll.position.set(0.08, 0.46, 0.02);
  roll.rotation.set(0.25, 0.4, 1.15);
  chest.add(roll);
  const cord = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 4, 10), mat(0x4a3a26));
  cord.position.set(0.08, 0.46, 0.02);
  cord.rotation.set(0.25 + Math.PI / 2, 0.4, 1.15);
  chest.add(cord);
  g.add(chest);
  // a few stacked spare logs against the outside wall
  [[W / 2 + 0.35, 0.12, 0], [W / 2 + 0.57, 0.12, 0.25], [W / 2 + 0.46, 0.3, 0.1]].forEach(([lx, ly, lz], i) => {
    const spare = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 2.2, 6), i % 2 ? logA : logB);
    spare.rotation.x = Math.PI / 2;
    spare.position.set(lx, ly, lz);
    g.add(spare);
  });

  /* --- the interior: a working trapper's shed, dressed the way a man leaves one --- */
  {
    const steel = mat(0x9297a0, { shininess: 70 }), rust = mat(0x6f4a2c),
          brass = mat(0xb2903c, { shininess: 90 }), leather = mat(0x5b4227),
          tin = mat(0x878d92, { shininess: 40 }), dwood = mat(0x3d2f1d, { map: barkTex }),
          rope2 = mat(0x8a7a58), whet = mat(0x565049),
          glassJar = new THREE.MeshPhongMaterial({ color: 0x5f6f52, transparent: true, opacity: 0.5, shininess: 60 }),
          // the lantern glass, lit — a warm globe to see the place by
          glassGlow = new THREE.MeshPhongMaterial({ color: 0x241804, emissive: 0xffab46, emissiveIntensity: 1.15, transparent: true, opacity: 0.9, shininess: 40 });
    const box = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    const cyl = (rt, rb, h, m, s) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, s || 8), m);
    const tor = (r, t, m, arc, seg) => new THREE.Mesh(new THREE.TorusGeometry(r, t, seg || 6, 12, arc || Math.PI * 2), m);
    const put = (mesh, x, y, z, rx, ry, rz) => { mesh.position.set(x, y, z); mesh.rotation.set(rx || 0, ry || 0, rz || 0); g.add(mesh); return mesh; };
    const sub = (x, y, z, ry, rz) => { const q = new THREE.Group(); q.position.set(x, y, z); q.rotation.set(0, ry || 0, rz || 0); g.add(q); return q; };
    const add2 = (q, mesh, x, y, z, rx, ry, rz) => { mesh.position.set(x || 0, y || 0, z || 0); mesh.rotation.set(rx || 0, ry || 0, rz || 0); q.add(mesh); return mesh; };
    const FL = 0.09; // the plank floor's top face

    // the workbench, run the length of the back wall
    put(box(2.4, 0.08, 0.72, plankM), 1.15, 0.86, -1.6);
    put(box(2.4, 0.14, 0.05, logB), 1.15, 0.73, -1.28);      // front apron
    put(box(2.4, 0.14, 0.05, logB), 1.15, 0.73, -1.92);      // back apron
    for (const lx of [0.05, 2.25]) for (const lz of [-1.32, -1.9]) put(box(0.1, 0.77, 0.1, logB), lx, 0.47, lz);

    // a hand saw left flat across the bench
    { const s = sub(0.5, 0.915, -1.5, 0.55);
      add2(s, box(0.6, 0.004, 0.11, steel));                 // blade
      add2(s, box(0.6, 0.012, 0.012, steel), 0, 0.006, 0.05);// stiffened back
      add2(s, box(0.62, 0.02, 0.012, rust), 0, -0.004, -0.055); // the toothed, rust-flecked edge
      add2(s, box(0.15, 0.12, 0.032, dwood), 0.36, 0.006, 0);// handle plate
      add2(s, tor(0.04, 0.016, dwood, Math.PI * 2, 8), 0.4, 0.006, 0, Math.PI / 2); // the grip hole
      for (const bz of [-0.03, 0.03]) add2(s, cyl(0.008, 0.008, 0.035, brass, 6), 0.31, 0.006, bz, Math.PI / 2);
    }
    // a claw hammer beside it
    { const h = sub(1.4, 0.915, -1.55, 0.3);
      add2(h, box(0.11, 0.055, 0.05, iron), 0, 0.025, 0);    // head
      add2(h, box(0.03, 0.06, 0.05, iron), -0.075, 0.02, 0); // the claw
      add2(h, cyl(0.016, 0.02, 0.34, dwood, 6), 0.22, 0.01, 0, 0, 0, Math.PI / 2); // helve
    }
    // the lantern — lit, sitting at the bench's end, throwing the only real light
    { const l = sub(1.98, 0.90, -1.7, 0.2);
      add2(l, cyl(0.085, 0.095, 0.03, iron, 10), 0, 0.015, 0);   // font base
      add2(l, cyl(0.06, 0.075, 0.06, brass, 10), 0, 0.06, 0);    // fuel font
      add2(l, cyl(0.055, 0.055, 0.15, glassGlow, 10), 0, 0.165, 0); // the glass globe
      for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI * 2; add2(l, box(0.008, 0.16, 0.008, iron), Math.cos(a) * 0.052, 0.165, Math.sin(a) * 0.052); } // wire guards
      add2(l, cyl(0.02, 0.075, 0.06, iron, 10), 0, 0.27, 0);     // vented crown
      add2(l, cyl(0.03, 0.02, 0.03, iron, 8), 0, 0.31, 0);       // chimney cap
      add2(l, tor(0.06, 0.008, iron, Math.PI, 6), 0, 0.30, 0, 0, Math.PI / 2); // the bail
      const lamp = new THREE.PointLight(0xffb14e, 1.5, 8, 2); lamp.position.set(0, 0.17, 0); l.add(lamp);
    }
    // a bench vise clamped over the front edge
    { const v = sub(0.2, 0.90, -1.3, 0);
      add2(v, box(0.12, 0.16, 0.13, rust), 0, 0.05, 0.02);
      add2(v, box(0.15, 0.11, 0.03, steel), 0, 0.11, 0.09);
      add2(v, box(0.15, 0.11, 0.03, steel), 0, 0.11, 0.15);
      add2(v, cyl(0.012, 0.012, 0.24, steel, 6), 0, 0.11, 0.12, Math.PI / 2);
      add2(v, cyl(0.022, 0.022, 0.04, steel, 6), 0.12, 0.11, 0.12, 0, 0, Math.PI / 2);
    }
    // a tin of nails, a whetstone, and a scatter of shavings on the boards
    put(cyl(0.05, 0.045, 0.07, tin, 10), 1.65, 0.94, -1.88);
    for (let i = 0; i < 5; i++) { const a = i * 1.3; put(cyl(0.004, 0.004, 0.09, steel, 4), 1.65 + Math.cos(a) * 0.02, 0.99, -1.88 + Math.sin(a) * 0.02, Math.cos(a) * 0.25, 0, Math.sin(a) * 0.25); }
    put(box(0.16, 0.03, 0.06, whet), 0.95, 0.915, -1.86, 0, 0.3, 0);
    for (let i = 0; i < 4; i++) put(tor(0.03, 0.008, mat(0xcaa96a), Math.PI, 5), 0.72 + i * 0.12, 0.92, -1.38 + (i % 2) * 0.08, Math.PI / 2, i, 0);

    // a sawhorse mid-floor with a half-cut log across it and a heap of sawdust below
    put(box(1.3, 0.09, 0.11, logB), 0.0, 0.62, -0.5);
    for (const dx of [-0.5, 0.5]) for (const dz of [-0.16, 0.16]) put(cyl(0.038, 0.05, 0.68, logB, 6), dx, 0.30, -0.5 + dz, dz > 0 ? 0.2 : -0.2, 0, dx > 0 ? -0.2 : 0.2);
    put(cyl(0.11, 0.115, 0.95, logA, 8), 0.05, 0.73, -0.5, 0, 0, Math.PI / 2);   // the log being sawn
    put(box(0.03, 0.16, 0.16, mat(0x1c150c)), 0.34, 0.73, -0.5);                 // the fresh kerf
    put(cyl(0.3, 0.34, 0.05, mat(0xbfa871), 12), 0.2, FL + 0.02, -0.5);          // sawdust

    // a chopping block by the door, an axe buried in it, split billets stacked alongside
    put(cyl(0.26, 0.29, 0.5, logA, 12), 2.0, FL + 0.25, 0.7);
    { const ax = sub(2.0, FL + 0.5, 0.7, 0.6, 0.35);
      add2(ax, box(0.13, 0.09, 0.035, steel), 0, 0.02, 0);
      add2(ax, box(0.05, 0.11, 0.03, steel), -0.07, 0.02, 0);
      add2(ax, cyl(0.02, 0.024, 0.55, dwood, 6), 0.02, 0.28, 0, 0, 0, -0.12);    // the helve, standing up
    }
    for (let i = 0; i < 4; i++) put(cyl(0.07, 0.08, 0.42, i % 2 ? logA : logB, 6), 2.35 + (i % 2) * 0.16, FL + 0.08 + Math.floor(i / 2) * 0.15, 1.2 - (i % 2) * 0.2, Math.PI / 2, i, 0);

    // a three-legged stool pulled up to the bench
    { const st = sub(0.55, 0, -0.95, 0);
      add2(st, cyl(0.17, 0.18, 0.05, plankM, 12), 0, 0.5, 0);
      for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI * 2 + 0.5; add2(st, cyl(0.022, 0.028, 0.5, logB, 6), Math.cos(a) * 0.12, 0.25, Math.sin(a) * 0.12, Math.cos(a) * 0.12, 0, -Math.sin(a) * 0.12); }
    }

    // the right wall, hung with the tools of the round
    put(box(0.05, 0.1, 2.8, logB), 2.53, 1.75, 0);                               // the peg batten
    put(tor(0.15, 0.045, rope2, Math.PI * 2, 8), 2.42, 1.5, -1.2, 0, Math.PI / 2, 0); // a coil of rope
    { const hx = sub(2.44, 1.5, -0.45, 0);                                       // a hatchet by its head
      add2(hx, box(0.11, 0.075, 0.03, steel), 0, 0, 0, 0, Math.PI / 2);
      add2(hx, cyl(0.017, 0.02, 0.32, dwood, 6), 0, -0.19, 0);
    }
    { const tp = sub(2.45, 1.45, 0.4, 0);                                        // a leg-hold trap and its chain
      add2(tp, tor(0.1, 0.02, rust, Math.PI * 2, 6), 0, 0, 0, 0, Math.PI / 2);
      add2(tp, tor(0.1, 0.012, rust, Math.PI, 6), 0, 0, 0.02, 0, Math.PI / 2);
      for (let i = 0; i < 4; i++) add2(tp, tor(0.02, 0.007, iron, Math.PI * 2, 5), 0, -0.12 - i * 0.045, 0, i % 2 ? 0 : Math.PI / 2, Math.PI / 2, 0);
    }
    { const bs = sub(2.42, 1.6, 1.25, 0);                                        // a bow saw
      add2(bs, tor(0.26, 0.018, dwood, Math.PI, 6), 0, 0, 0, 0, Math.PI / 2, 0);
      add2(bs, box(0.004, 0.5, 0.02, steel), 0, -0.05, 0, 0, 0, Math.PI / 2);
    }
    { const sn = sub(2.46, 1.15, -1.7, 0);                                       // a pair of snowshoes
      for (const o of [-0.06, 0.06]) { const f = tor(0.14, 0.02, dwood, Math.PI * 2, 6); f.scale.set(0.7, 1.5, 1); add2(sn, f, 0, 0, o, 0, Math.PI / 2, 0); }
    }

    // a hide stretched to dry on the back wall, above the bench
    { const p = sub(1.2, 1.85, -2.0, 0);
      add2(p, box(0.92, 1.05, 0.02, leather));
      for (const [ex, ey] of [[-0.46, 0], [0.46, 0], [0, 0.52], [0, -0.52]]) add2(p, cyl(0.015, 0.015, ex ? 1.05 : 0.92, dwood, 5), ex, ey, 0.02, 0, 0, ex ? 0 : Math.PI / 2);
    }
    put(box(0.02, 0.7, 0.5, mat(0x6b4a2c)), -2.55, 1.4, 0.6);                     // a smaller pelt on the left wall

    // a shelf of jars and tins along the left wall
    put(box(0.32, 0.035, 1.8, plankM), -2.4, 1.5, -0.3);
    for (const bz of [-1.05, 0.45]) put(box(0.28, 0.22, 0.04, logB), -2.4, 1.4, bz);
    let jz = -1.0;
    for (const [jr, jh, jm] of [[0.05, 0.13, glassJar], [0.045, 0.1, tin], [0.05, 0.14, glassJar], [0.042, 0.09, tin], [0.048, 0.12, glassJar]]) {
      put(cyl(jr, jr, jh, jm, 10), -2.38, 1.52 + jh / 2, jz);
      put(cyl(jr * 0.9, jr, 0.02, iron, 10), -2.38, 1.52 + jh + 0.01, jz);
      jz += 0.28;
    }
    for (let i = 0; i < 3; i++) put(tor(0.09, 0.018, rust, Math.PI * 2, 6), -2.36, 1.55 + i * 0.05, 0.62, Math.PI / 2, 0, 0); // a stack of spare traps
    { const o = sub(0.4, FL, -1.86, 0.5);                                        // an oil can under the bench
      add2(o, cyl(0.08, 0.09, 0.16, tin, 10), 0, 0.08, 0);
      add2(o, cyl(0.015, 0.015, 0.16, tin, 6), 0.05, 0.2, 0, 0, 0, -0.6);
    }

    // a broom, a water bucket, and cordwood cross-stacked in the near corner
    { const b = sub(-2.25, 0.9, 1.75, 0, 0.22);
      add2(b, cyl(0.02, 0.022, 1.5, dwood, 6));
      add2(b, cyl(0.09, 0.05, 0.26, mat(0xa5894e), 8), 0, -0.85, 0);
    }
    { const bk = sub(-2.3, FL, 1.5, 0);
      add2(bk, cyl(0.16, 0.13, 0.3, plankM, 12), 0, 0.15, 0);
      add2(bk, tor(0.16, 0.012, iron, Math.PI * 2, 6), 0, 0.27, 0, Math.PI / 2, 0, 0);
      add2(bk, tor(0.145, 0.01, iron, Math.PI * 2, 6), 0, 0.05, 0, Math.PI / 2, 0, 0);
    }
    for (let r = 0; r < 3; r++) for (let i = 0; i < 3; i++) {
      const log = cyl(0.06, 0.07, 0.62, (r + i) % 2 ? logA : logB, 6), y = FL + 0.08 + r * 0.13;
      if (r % 2 === 0) put(log, -2.05, y, 0.8 + i * 0.16, 0, 0, Math.PI / 2);     // a course running along the wall
      else put(log, -2.3 + i * 0.16, y, 1.0, Math.PI / 2, 0, 0);                  // the crossed course
    }

    // interior clutter blocks the player the way real furniture does
    for (const [lx, lz, r] of [[0.4, -1.6, 0.55], [1.9, -1.6, 0.55], [0.0, -0.5, 0.7], [2.0, 0.7, 0.35], [0.55, -0.95, 0.25], [-2.1, 1.2, 0.35]]) {
      const w = shedRot(lx, lz); addCollider(w.x, w.z, r);
    }
  }

  enableShadows(g);
  scene.add(g);
  addInteractable(roll, 'note', 'Take the map from the box', 'shed-map', { note: SHED_NOTE, onRead: () => {
    state.shedMapRead = true;
    if (state.quest === 6) toast(`The tower on the great hill, ${compassWord(HILL)} of the wreck. The map knows the way.`);
  } });
  // wall collision, doorway open
  const shedSegs = [
    [-W / 2, -D / 2, W / 2, -D / 2],
    [-W / 2, -D / 2, -W / 2, D / 2],
    [W / 2, -D / 2, W / 2, D / 2],
    [-W / 2, D / 2, -DOOR, D / 2],
    [DOOR, D / 2, W / 2, D / 2],
  ];
  for (const s of shedSegs) {
    const a = shedRot(s[0], s[1]), b = shedRot(s[2], s[3]);
    wallSegs.push({ x1: a.x, z1: a.z, x2: b.x, z2: b.z, open: false });
  }
  addCollider(shedRot(-1.55, -1.25).x, shedRot(-1.55, -1.25).z, 0.55); // the chest blocks
}

/* cabin quest fixtures: locked door, back garden, the body, the letter */
function cabRot(px, pz) { // cabin local -> world (the cabin group is rotated 0.5 rad)
  const c = Math.cos(0.5), s = Math.sin(0.5);
  return { x: CABIN.x + px * c + pz * s, z: CABIN.z - px * s + pz * c };
}
const cabinDoor = { locked: true, mesh: null, seg: null, pos: cabRot(0, 3.75) };
const keyRock = Object.assign({ searched: false }, cabRot(3.0, 6.2));
{
  // collision for the cabin log walls, door gap included (10 x 7.5 footprint)
  const segsLocal = [
    [-5, -3.75, 5, -3.75], [-5, -3.75, -5, 3.75], [5, -3.75, 5, 3.75],
    [-5, 3.75, -0.85, 3.75], [0.85, 3.75, 5, 3.75],
  ];
  for (const s of segsLocal) {
    const a = cabRot(s[0], s[1]), b = cabRot(s[2], s[3]);
    wallSegs.push({ x1: a.x, z1: a.z, x2: b.x, z2: b.z, open: false });
  }
  const da = cabRot(-0.85, 3.75), db = cabRot(0.85, 3.75);
  cabinDoor.seg = { x1: da.x, z1: da.z, x2: db.x, z2: db.z, open: false };
  wallSegs.push(cabinDoor.seg);
  // the door itself — heavy, old, locked: a batten-and-ledge door of six warped
  // vertical boards, Z-braced, hung on hand-forged iron straps, studded with
  // rosehead nails, a rust-pitted lock plate and a ring pull. The whole group
  // hinges on its left edge (local x≈0), so it can still swing open when unlocked.
  const dg = new THREE.Group();
  const doorTones = [0x5a4228, 0x513a24, 0x60482c, 0x4c3720, 0x574026, 0x523d26];
  const ironM = mat(0x2b2824), ironRust = mat(0x4a3524), boltM = mat(0x3a352c);
  const DW = 1.66, DH = 2.55, x0 = 0.03; // door spans local x0..x0+DW, hinge near x=0
  // a thin dark backing so the seams between boards fall into shadow, not daylight
  const backing = new THREE.Mesh(new THREE.BoxGeometry(DW + 0.02, DH, 0.04), mat(0x14100a));
  backing.position.set(x0 + DW / 2, 1.28, -0.02);
  dg.add(backing);
  // six vertical boards, each a hair different in tone and set a touch proud/shy,
  // a couple canted so the door reads warped and hand-hewn
  const nB = 6, bw = DW / nB;
  for (let i = 0; i < nB; i++) {
    const warp = (i % 2 ? 1 : -1) * 0.006;
    const board = new THREE.Mesh(new THREE.BoxGeometry(bw - 0.02, DH, 0.08 + (i % 3) * 0.006),
      mat(doorTones[i % doorTones.length], { map: barkTex }));
    board.position.set(x0 + bw * (i + 0.5), 1.28, (i % 3 - 1) * 0.008);
    board.rotation.z = warp; // a slight lean, board to board
    dg.add(board);
  }
  // Z-brace: two ledges top and bottom, one diagonal running between them
  const braceM = mat(0x41321f, { map: barkTex });
  for (const by of [0.52, 2.02]) {
    const ledge = new THREE.Mesh(new THREE.BoxGeometry(DW - 0.06, 0.19, 0.05), braceM);
    ledge.position.set(x0 + DW / 2, by, 0.075);
    dg.add(ledge);
  }
  const diag = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.17, 0.045), braceM);
  diag.position.set(x0 + DW / 2, 1.27, 0.075);
  diag.rotation.z = Math.atan2(2.02 - 0.52, DW - 0.3); // corner to corner across the ledges
  dg.add(diag);
  // hand-forged strap hinges reaching in from the hinge stile, spreading to points
  for (const hy of [0.55, 1.99]) {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.11, 0.03), ironM);
    strap.position.set(0.42, hy, 0.12);
    dg.add(strap);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.22, 4), ironM);
    tip.rotation.z = -Math.PI / 2;
    tip.position.set(0.83, hy, 0.12); // arrow point at the strap's far end
    dg.add(tip);
    // the pintle knuckle at the jamb end
    const knuckle = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.16, 6), ironM);
    knuckle.position.set(0.04, hy, 0.11);
    dg.add(knuckle);
  }
  // rows of rosehead nail studs down the ledges, straps and diagonal
  const studAt = (sx, sy) => {
    const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.028, 0), boltM);
    s.position.set(sx, sy, 0.13);
    dg.add(s);
  };
  for (const by of [0.52, 2.02]) for (let k = 0; k < 6; k++) studAt(x0 + 0.15 + k * (DW - 0.3) / 5, by);
  for (const hy of [0.55, 1.99]) for (let k = 0; k < 3; k++) studAt(0.2 + k * 0.28, hy);
  for (let k = 0; k < 5; k++) studAt(x0 + 0.25 + k * 0.28, 0.52 + (k + 0.5) * 0.28);
  // rust-pitted lock plate on the latch stile, with a keyhole and a ring pull
  const lockPlate = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.44, 0.03), ironRust);
  lockPlate.position.set(1.46, 1.24, 0.11);
  dg.add(lockPlate);
  const keyholeR = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.04, 6), mat(0x0a0806));
  keyholeR.rotation.x = Math.PI / 2;
  keyholeR.position.set(1.46, 1.26, 0.13);
  dg.add(keyholeR);
  const keyholeSlot = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.08, 0.04), mat(0x0a0806));
  keyholeSlot.position.set(1.46, 1.21, 0.13);
  dg.add(keyholeSlot);
  const ringBoss = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 8), ironM);
  ringBoss.rotation.x = Math.PI / 2;
  ringBoss.position.set(1.44, 1.5, 0.12);
  dg.add(ringBoss);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.022, 6, 12), ironM);
  ring.position.set(1.44, 1.44, 0.14);
  dg.add(ring);
  // an iron kick-plate scuffed along the bottom rail
  const kick = new THREE.Mesh(new THREE.BoxGeometry(DW - 0.1, 0.16, 0.03), ironRust);
  kick.position.set(x0 + DW / 2, 0.16, 0.075);
  dg.add(kick);
  const hp = cabRot(-0.85, 3.75);
  dg.position.set(hp.x, groundY(hp.x, hp.z), hp.z);
  dg.rotation.y = 0.5;
  enableShadows(dg);
  scene.add(dg);
  cabinDoor.mesh = dg;

  // the stone by the porch, sitting a little wrong — a blunt weathered granite
  // boulder, part-sunk and tipped, with a cushion of moss over its crown and
  // shaded face and pale lichen freckling the bare rock
  {
    const krG = new THREE.Group();
    const g1 = mat(0x8f8b80), g2 = mat(0x7c7a6f);
    // the boulder: a dodecahedron softened with a little jitter so it reads as a
    // real rounded rock, not a crystal; flattened, part-sunk and tipped a touch
    const rock = new THREE.Mesh(jitter(new THREE.DodecahedronGeometry(0.48), 0.07), g1);
    rock.scale.set(1.05, 0.8, 0.95);
    rock.rotation.set(0.18, 0.7, 0.12);
    rock.castShadow = true;
    krG.add(rock);
    // a second lump fused low on one side, breaking the outline
    const lump = new THREE.Mesh(jitter(new THREE.DodecahedronGeometry(0.24), 0.05), g2);
    lump.position.set(0.34, -0.12, 0.18);
    lump.rotation.set(0.6, 1.2, 0.3);
    lump.castShadow = true;
    krG.add(lump);
    // a cushion of moss over the crown and shaded north face — several soft mounds
    // in varied greens, clustered so they read as one living crust
    const mossTones = [0x556b2f, 0x47601f, 0x63793a, 0x3f5622];
    const mossSpots = [
      [-0.05, 0.32, -0.05, 0.34], // crown
      [-0.22, 0.22, -0.2, 0.26],  // north shoulder
      [0.14, 0.24, -0.12, 0.24],
      [-0.3, 0.04, 0.02, 0.2],    // creeping down the shaded side
      [0.04, 0.08, -0.3, 0.22],
    ];
    mossSpots.forEach(([mx, my, mz, mr], i) => {
      const moss = new THREE.Mesh(new THREE.SphereGeometry(1, 7, 5), mat(mossTones[i % mossTones.length]));
      moss.position.set(mx, my, mz);
      moss.scale.set(mr, 0.06, mr); // a low, spreading pad
      krG.add(moss);
    });
    // pale lichen freckling the bare rock
    for (const [lx, ly, lz] of [[0.24, 0.16, 0.12], [-0.08, 0.0, 0.3], [0.28, -0.02, -0.16]]) {
      const lichen = new THREE.Mesh(new THREE.SphereGeometry(1, 6, 4), mat(0x9aa47e));
      lichen.position.set(lx, ly, lz);
      lichen.scale.set(0.07, 0.02, 0.06);
      krG.add(lichen);
    }
    krG.position.set(keyRock.x, groundY(keyRock.x, keyRock.z) + 0.14, keyRock.z);
    scene.add(krG);
  }

  // on the table, beside the lamp — anchored to the cabin's own base height, not the
  // terrain under it, so the slope can't sink it into the tabletop
  const lp = cabRot(1.45, -1.55);
  const letter = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.62), paperM);
  letter.position.set(lp.x, groundY(CABIN.x, CABIN.z) + 0.845, lp.z);
  letter.rotation.x = -Math.PI / 2;
  letter.rotation.z = 0.65; // squared to the table, knocked a little askew
  scene.add(letter);
  addInteractable(letter, 'note', 'Read the letter', 'letter', { note: CABIN_LETTER, onRead: () => {
    if (state.quest < 6) {
      state.quest = 6;
      toast(state.shedMapRead
        ? `A watch tower, on the great hill. ${compassWord(HILL)[0].toUpperCase() + compassWord(HILL).slice(1)}.`
        : 'He kept a shed across the river. Cross the bridge to reach it.');
    }
    // it heard you find it. Two seconds of quiet — then it runs the length of the
    // cabin wall and hits it, once, hard. Seven seconds you will not forget.
    if (!state.letterScare) {
      state.letterScare = true;
      setTimeout(() => { if (!state.dead && !state.ended) audio.runPast(); }, 2000);
      setTimeout(() => {
        if (state.dead || state.ended) return;
        audio.bang();
        state.shakeT = 0.5;
        toast('Something hit the wall.');
      }, 5700);
    }
  } });
}

/* the watch tower on the great hill — the radio is at the top */
const SHACK = { radio: { x: HILL.x, z: HILL.z - 1.2 }, ladder: { x: HILL.x, z: HILL.z + 3.3 } };
let shackLight, radioLamp;
{
  const y = groundY(HILL.x, HILL.z);
  const H = 9;
  TOWER.y = y + H + 0.1; // stand on the deck, not in it
  const g = new THREE.Group();
  const plankM = mat(0x5a4a30, { map: barkTex }), plankD = mat(0x4c3e28, { map: barkTex });
  const steelM = mat(0x6a6f74);
  // a strut running exactly from a to b — every joint in the tower meets its member
  function strut(ax, ay, az, bx, by, bz, r, m, seg = 5) {
    const a = new THREE.Vector3(ax, ay, az), b = new THREE.Vector3(bx, by, bz);
    const s = new THREE.Mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), seg), m);
    s.position.copy(a).add(b).multiplyScalar(0.5);
    s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.add(s);
    return s;
  }
  // the four legs splay from a wide footing up to the deck rim; everything else
  // is measured off this line, so girts and braces land ON the timber
  const legXZ = yy => 2.65 - (yy / H) * 0.95;
  const CORN = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [sx, sz] of CORN) {
    strut(sx * legXZ(-0.4), -0.4, sz * legXZ(-0.4), sx * legXZ(H + 0.1), H + 0.1, sz * legXZ(H + 0.1), 0.15, plankD, 7);
    const foot = new THREE.Mesh(jitter(new THREE.DodecahedronGeometry(0.34), 0.12), mat(0x6f6c64));
    foot.position.set(sx * 2.72, 0.1, sz * 2.72); // stone packed around each leg
    g.add(foot);
    addCollider(HILL.x + sx * 2.65, HILL.z + sz * 2.65, 0.32);
  }
  // horizontal girts ring the tower at four heights, X-braces between the bands,
  // every end meeting a leg
  const BANDS = [0.9, 3.4, 5.9, 8.4];
  for (let f = 0; f < 4; f++) {
    const [ax, az] = CORN[f], [bx, bz] = CORN[(f + 1) % 4];
    for (let b = 0; b < BANDS.length; b++) {
      const y1 = BANDS[b], r1 = legXZ(y1);
      strut(ax * r1, y1, az * r1, bx * r1, y1, bz * r1, 0.065, plankM);
      if (b < BANDS.length - 1) {
        const y2 = BANDS[b + 1], r2 = legXZ(y2);
        strut(ax * r1, y1, az * r1, bx * r2, y2, bz * r2, 0.05, plankM);
        strut(bx * r1, y1, bz * r1, ax * r2, y2, az * r2, 0.05, plankM);
      }
    }
  }
  // rim beams bolted across the leg tops carry the deck; bearers span under the boards
  const rimY = H - 0.22, rimR = legXZ(rimY);
  for (let f = 0; f < 4; f++) {
    const [ax, az] = CORN[f], [bx, bz] = CORN[(f + 1) % 4];
    strut(ax * rimR, rimY, az * rimR, bx * rimR, rimY, bz * rimR, 0.09, plankD, 4);
  }
  for (const bz2 of [-1.5, 0, 1.5])
    strut(-rimR, H - 0.08, bz2, rimR, H - 0.08, bz2, 0.07, plankD, 4);
  // the deck: boards laid one by one, a hair of daylight between them
  for (let i = 0; i < 13; i++) {
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.41, 0.07, 5.6), i % 3 ? plankM : plankD);
    board.position.set(-2.58 + i * 0.43, H, 0);
    g.add(board);
  }
  // railing: posts seated on the deck, top and knee rails running post to post,
  // with a gap in the south side where the ladder comes through
  const postAt = (px2, pz2) => strut(px2, H, pz2, px2, H + 1.05, pz2, 0.05, plankD, 4);
  for (const [sx, sz] of CORN) postAt(sx * 2.7, sz * 2.7);
  postAt(0, -2.7); postAt(-2.7, 0); postAt(2.7, 0);
  postAt(-0.55, 2.7); postAt(0.55, 2.7); // framing the ladder gap
  for (const yy of [1.02, 0.55]) {
    strut(-2.7, H + yy, -2.7, 2.7, H + yy, -2.7, 0.045, plankD, 4);  // north
    strut(-2.7, H + yy, -2.7, -2.7, H + yy, 2.7, 0.045, plankD, 4);  // west
    strut(2.7, H + yy, -2.7, 2.7, H + yy, 2.7, 0.045, plankD, 4);    // east
    strut(-2.7, H + yy, 2.7, -0.55, H + yy, 2.7, 0.045, plankD, 4);  // south, up to the gap
    strut(0.55, H + yy, 2.7, 2.7, H + yy, 2.7, 0.045, plankD, 4);
  }
  // a little lookout hut on the north half of the platform
  const hutBack = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.1, 0.12), plankM);
  hutBack.position.set(0, H + 1.05, -2.4); g.add(hutBack);
  for (const s of [1, -1]) {
    const hutSide = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.1, 2.2), plankD);
    hutSide.position.set(s * 1.7, H + 1.05, -1.3); g.add(hutSide);
  }
  const hutRoof = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.12, 2.9), plankD);
  hutRoof.position.set(0, H + 2.2, -1.25);
  hutRoof.rotation.x = 0.12;
  g.add(hutRoof);
  // radio desk inside the hut
  const desk = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.72, 0.7), plankD);
  desk.position.set(0, H + 0.36, -1.9); g.add(desk);
  // the radio set: a field transceiver — steel case, dial faces, knobs with pointer
  // marks, toggle switches, a speaker grille, and the microphone on its hook
  const caseM2 = mat(0x3f453c), panelM = mat(0x2c302a), knobM = mat(0x1d1f1a), brassM = mat(0x8a7a4a);
  const rcase = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.46, 0.42), caseM2);
  rcase.position.set(0, H + 0.98, -2.0); g.add(rcase);
  for (const cx3 of [-0.42, 0.42]) { // carry handles on the case sides
    const hnd = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 5, 8, Math.PI), knobM);
    hnd.position.set(cx3, H + 1.22, -2.0);
    g.add(hnd);
  }
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.38, 0.03), panelM);
  panel.position.set(0, H + 0.98, -1.785); g.add(panel);
  const dialTex = makeCanvasTex(64, (c, s) => { // a marked tuning dial face
    c.fillStyle = '#d8d2b8';
    c.beginPath(); c.arc(s / 2, s / 2, s * 0.46, 0, 7); c.fill();
    c.strokeStyle = '#2a2a22'; c.lineWidth = 2;
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * Math.PI * 2;
      c.beginPath();
      c.moveTo(s / 2 + Math.cos(a) * s * 0.32, s / 2 + Math.sin(a) * s * 0.32);
      c.lineTo(s / 2 + Math.cos(a) * s * (i % 6 ? 0.38 : 0.44), s / 2 + Math.sin(a) * s * (i % 6 ? 0.38 : 0.44));
      c.stroke();
    }
    c.lineWidth = 3; // the needle, resting where he left it
    c.beginPath(); c.moveTo(s / 2, s / 2); c.lineTo(s / 2 + s * 0.3, s / 2 - s * 0.18); c.stroke();
  });
  for (const dxr of [-0.26, 0.0]) {
    const dial = new THREE.Mesh(new THREE.CircleGeometry(0.085, 16), new THREE.MeshBasicMaterial({ map: dialTex }));
    dial.position.set(dxr, H + 1.05, -1.768);
    g.add(dial);
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.088, 0.008, 5, 16), brassM);
    bezel.position.set(dxr, H + 1.05, -1.769);
    g.add(bezel);
  }
  for (let i = 0; i < 4; i++) { // knobs, each pointer left at a different setting
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.035, 8), knobM);
    knob.rotation.x = Math.PI / 2;
    knob.position.set(-0.3 + i * 0.14, H + 0.87, -1.77);
    g.add(knob);
    const tick = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.028, 0.012), brassM);
    tick.position.set(-0.3 + i * 0.14, H + 0.885, -1.756);
    tick.rotation.z = rng() * 2 - 1;
    g.add(tick);
  }
  for (let i = 0; i < 3; i++) { // toggle switches, thrown every which way
    const sw = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.013, 0.05, 5), brassM);
    sw.position.set(0.22 + i * 0.08, H + 0.87, -1.765);
    sw.rotation.x = i % 2 ? 0.5 : -0.5;
    g.add(sw);
  }
  for (let i = 0; i < 5; i++) { // speaker grille slats
    const slat = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.014, 0.012), knobM);
    slat.position.set(0.27, H + 1.0 + i * 0.026, -1.768);
    g.add(slat);
  }
  radioLamp = new THREE.Mesh(new THREE.IcosahedronGeometry(0.035, 0), new THREE.MeshBasicMaterial({ color: 0x1a2a1a }));
  radioLamp.position.set(-0.38, H + 1.12, -1.77);
  g.add(radioLamp);
  // the microphone, hung on a hook at the side of the case, coiled cord and all
  const micM = mat(0x24262a);
  const mic = new THREE.Group();
  const micBody = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.042, 0.12, 8), micM);
  mic.add(micBody);
  const micHead = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.035, 10), knobM);
  micHead.position.y = 0.075;
  mic.add(micHead);
  for (let i = 0; i < 3; i++) { // grille lines across the face
    const gl = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.006, 0.006), brassM);
    gl.position.set(0, 0.075, 0.045);
    gl.rotation.x = -0.3 + i * 0.3;
    mic.add(gl);
  }
  mic.position.set(-0.55, H + 1.02, -1.95);
  mic.rotation.z = 0.22;
  g.add(mic);
  let cordPrev = new THREE.Vector3(-0.55, H + 0.95, -1.95);
  for (let i = 1; i <= 10; i++) { // the coiled cord, looping down and back into the case
    const t = i / 10;
    const cp = new THREE.Vector3(
      -0.55 + Math.sin(t * 9) * 0.03 + t * 0.12,
      H + 0.95 - t * 0.18,
      -1.95 + Math.cos(t * 9) * 0.03);
    const cs = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, cordPrev.distanceTo(cp), 4), micM);
    cs.position.copy(cordPrev).add(cp).multiplyScalar(0.5);
    cs.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), cp.clone().sub(cordPrev).normalize());
    g.add(cs);
    cordPrev = cp;
  }
  // the aerial — a proper radio mast, guyed to the deck corners, lamp at the top
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.07, 6.5, 5), steelM);
  mast.position.set(1.2, H + 5.2, -2.2); g.add(mast);
  for (let i = 0; i < 4; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.0 - i * 0.18, 0.04, 0.04), steelM);
    bar.position.set(1.2, H + 5.0 + i * 0.8, -2.2); g.add(bar);
  }
  const guyM = mat(0x2c2c2c);
  for (const [gx2, gz2] of [[-2.5, -2.5], [2.5, 2.5], [-2.5, 2.4]]) {
    const ga = new THREE.Vector3(1.2, H + 8.2, -2.2), gb = new THREE.Vector3(gx2, H + 0.2, gz2);
    const guy = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, ga.distanceTo(gb), 3), guyM);
    guy.position.copy(ga).add(gb).multiplyScalar(0.5);
    guy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), gb.clone().sub(ga).normalize());
    g.add(guy);
  }
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 5), new THREE.MeshBasicMaterial({ color: 0x5a1512 }));
  beacon.position.set(1.2, H + 8.5, -2.2); g.add(beacon);
  // the ladder, leant into the railing gap and bolted to the rim — the stringers
  // run on past the deck to give you a handhold at the top
  const LADD = { footZ: 3.75, topZ: 2.84 };
  const ladderZ = yy => LADD.footZ + (LADD.topZ - LADD.footZ) * ((yy + 0.05) / (H + 1.2));
  for (const s of [1, -1]) {
    strut(s * 0.35, -0.05, LADD.footZ, s * 0.35, H + 1.15, ladderZ(H + 1.15), 0.05, plankD);
    const bolt = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.22), plankD);
    bolt.position.set(s * 0.35, H - 0.08, 2.88); // where the stringer meets the rim
    g.add(bolt);
  }
  for (let yy = 0.5; yy < H + 0.5; yy += 0.45) {
    const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.72, 5), plankM);
    rung.rotation.z = Math.PI / 2;
    rung.position.set(0, yy, ladderZ(yy));
    g.add(rung);
  }
  shackLight = new THREE.PointLight(0xffd9a0, 0, 12, 1.6);
  shackLight.position.set(0, H + 1.6, -1);
  g.add(shackLight);
  enableShadows(g);
  g.position.set(HILL.x, y, HILL.z);
  scene.add(g);
}

/* the generator, stripped for parts, in its little clearing at the foot of the
   hill — the power line runs down from the tower straight to it */
const GEN_ROT = 0.7; // the panel end faces back up the hill
let genLamp, genPilot, genInstalled;
{
  const gy = groundY(GEN.x, GEN.z);
  const g = new THREE.Group();
  // chipped machine paint over rust — the woods have had years at it
  const paintTex = makeCanvasTex(128, (c, s) => {
    c.fillStyle = '#4a5445'; c.fillRect(0, 0, s, s);
    blotches(c, s, ['#3e483a', '#55604f'], 26, 3, 9, 0.35);           // faded panels
    blotches(c, s, ['#6b4a2a', '#7a4526', '#502f18'], 34, 1, 5, 0.5); // rust bloom
    blotches(c, s, ['#2e2a24'], 12, 1, 3, 0.4);                       // oil grime
  }, 2, 2);
  const bodyM = mat(0x9aa090, { map: paintTex }), steel = mat(0x565b60), dark = mat(0x26282b),
        rubber = mat(0x1f1d1b), brass = mat(0x8a7a4a), redM = mat(0x7a2a22);
  function bar(ax, ay, az, bx, by, bz, r, m) { // a tube run exactly from a to b
    const a = new THREE.Vector3(ax, ay, az), b = new THREE.Vector3(bx, by, bz);
    const s = new THREE.Mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), 6), m);
    s.position.copy(a).add(b).multiplyScalar(0.5);
    s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.add(s);
    return s;
  }
  // oil-black earth underneath it
  const oilTex = makeCanvasTex(64, (c, s) => {
    c.clearRect(0, 0, s, s);
    const rg2 = c.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s * 0.5);
    rg2.addColorStop(0, 'rgba(16,14,10,.7)');
    rg2.addColorStop(1, 'rgba(16,14,10,0)');
    c.fillStyle = rg2; c.fillRect(0, 0, s, s);
  });
  const oil = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.9),
    new THREE.MeshBasicMaterial({ map: oilTex, transparent: true, depthWrite: false }));
  oil.rotation.x = -Math.PI / 2;
  oil.position.y = 0.02;
  g.add(oil);
  // two timber skids keep it off the wet ground
  for (const s of [1, -1]) {
    const skid = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.14, 0.18), mat(0x4c3e28, { map: barkTex }));
    skid.position.set(0, 0.07, s * 0.44);
    g.add(skid);
  }
  // engine block, cylinder head under a stack of cooling fins, valve cover on top
  const block = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.52, 0.6), bodyM);
  block.position.set(-0.32, 0.42, 0); g.add(block);
  for (let i = 0; i < 5; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.022, 0.64), steel);
    fin.position.set(-0.32, 0.7 + i * 0.045, 0); g.add(fin);
  }
  const vcover = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.09, 0.46), bodyM);
  vcover.position.set(-0.32, 0.94, 0); g.add(vcover);
  // recoil starter on the flywheel end, pull-rope hanging slack from its T-handle
  const recoil = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.07, 12), steel);
  recoil.rotation.z = Math.PI / 2;
  recoil.position.set(-0.75, 0.48, 0); g.add(recoil);
  const recoilHub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.09, 8), dark);
  recoilHub.rotation.z = Math.PI / 2;
  recoilHub.position.set(-0.75, 0.48, 0); g.add(recoilHub);
  bar(-0.79, 0.52, 0.05, -0.84, 0.3, 0.17, 0.008, rubber);
  const tHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.1, 5), mat(0x6a4a2a));
  tHandle.rotation.x = Math.PI / 2;
  tHandle.position.set(-0.84, 0.28, 0.18); g.add(tHandle);
  // the spark plug boss — an empty socket until you find the plug
  const plugBoss = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.07, 6), dark);
  plugBoss.rotation.x = 0.6;
  plugBoss.position.set(-0.14, 0.96, 0.2); g.add(plugBoss);
  // alternator drum, and two bare grooved pulleys waiting for their belt
  const alt = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.32, 10), steel);
  alt.rotation.z = Math.PI / 2;
  alt.position.set(0.42, 0.38, -0.08); g.add(alt);
  const altBell = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.18, 0.09, 10), dark);
  altBell.rotation.z = Math.PI / 2;
  altBell.position.set(0.62, 0.38, -0.08); g.add(altBell);
  for (const [pxp, pyp, rr] of [[-0.32, 0.42, 0.09], [0.42, 0.38, 0.13]]) {
    const pul = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, 0.05, 10), dark);
    pul.rotation.x = Math.PI / 2;
    pul.position.set(pxp, pyp, -0.36); g.add(pul);
    const groove = new THREE.Mesh(new THREE.TorusGeometry(rr - 0.015, 0.008, 4, 12), steel);
    groove.position.set(pxp, pyp, -0.385); g.add(groove);
  }
  // battery tray on the near side, its clamp cables flopped over the edge
  const tray = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.3), steel);
  tray.position.set(0.28, 0.19, 0.42); g.add(tray);
  for (const s of [1, -1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.02), steel);
    wall.position.set(0.28, 0.26, 0.42 + s * 0.15); g.add(wall);
  }
  bar(0.1, 0.22, 0.44, -0.02, 0.5, 0.28, 0.014, redM);
  bar(0.16, 0.22, 0.5, 0.04, 0.44, 0.55, 0.014, rubber);
  // fuel tank slung across the top, filler cap to one side
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.9, 10), bodyM);
  tank.rotation.z = Math.PI / 2;
  tank.position.set(0, 1.16, 0.1); g.add(tank);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 7), brass);
  cap.position.set(-0.2, 1.37, 0.1); g.add(cap);
  bar(-0.2, 0.99, 0.16, -0.3, 0.72, 0.24, 0.012, rubber); // fuel line down to the carb
  // exhaust: elbow to a slatted muffler, mouth stained black
  bar(-0.48, 0.68, -0.16, -0.52, 0.84, -0.3, 0.03, dark);
  const muff = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.44, 8), mat(0x3c3c3c));
  muff.rotation.z = Math.PI / 2;
  muff.position.set(-0.52, 0.86, -0.32); g.add(muff);
  for (let i = 0; i < 3; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 0.05), steel);
    slat.position.set(-0.52, 0.97, -0.38 + i * 0.06); g.add(slat);
  }
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.08, 6), mat(0x181818));
  tip.rotation.z = Math.PI / 2;
  tip.position.set(-0.78, 0.86, -0.32); g.add(tip);
  // the welded carry-frame around everything
  const fx = 0.98, fz = 0.58, fy = 1.44;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
    bar(sx * fx, 0.05, sz * fz, sx * fx, fy, sz * fz, 0.035, steel);
  for (const s of [1, -1]) {
    bar(-fx, fy, s * fz, fx, fy, s * fz, 0.035, steel);
    bar(s * fx, fy, -fz, s * fx, fy, fz, 0.035, steel);
  }
  // control panel on the uphill end: gauge, twin outlets, main switch, pilot lamp
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.52, 0.5), bodyM);
  panel.position.set(0.88, 0.62, 0); g.add(panel);
  const gaugeTex = makeCanvasTex(32, (c, s) => {
    c.fillStyle = '#ddd8c2';
    c.beginPath(); c.arc(s / 2, s / 2, s * 0.45, 0, 7); c.fill();
    c.strokeStyle = '#2a2a22'; c.lineWidth = 2;
    for (let i = 0; i < 7; i++) {
      const a = 0.6 + i / 6 * 1.9;
      c.beginPath();
      c.moveTo(s / 2 - Math.cos(a) * s * 0.32, s / 2 - Math.sin(a) * s * 0.32);
      c.lineTo(s / 2 - Math.cos(a) * s * 0.42, s / 2 - Math.sin(a) * s * 0.42);
      c.stroke();
    }
    c.beginPath(); c.moveTo(s / 2, s / 2); c.lineTo(s * 0.2, s * 0.72); c.stroke(); // needle on empty
  });
  const gauge = new THREE.Mesh(new THREE.CircleGeometry(0.07, 12), new THREE.MeshBasicMaterial({ map: gaugeTex }));
  gauge.rotation.y = Math.PI / 2;
  gauge.position.set(0.94, 0.74, -0.13); g.add(gauge);
  const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.007, 5, 14), brass);
  bezel.rotation.y = Math.PI / 2;
  bezel.position.set(0.94, 0.74, -0.13); g.add(bezel);
  for (const oz of [0.08, 0.24]) { // outlets under their rain flaps
    const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 8), dark);
    sock.rotation.z = Math.PI / 2;
    sock.position.set(0.94, 0.58, oz); g.add(sock);
    const flap = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.08), steel);
    flap.position.set(0.95, 0.65, oz); g.add(flap);
  }
  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.14, 0.03), redM);
  lever.position.set(0.95, 0.42, -0.05);
  lever.rotation.x = 0.5; // thrown to OFF
  g.add(lever);
  genPilot = new THREE.Mesh(new THREE.IcosahedronGeometry(0.024, 0), new THREE.MeshBasicMaterial({ color: 0x3a1512 }));
  genPilot.position.set(0.94, 0.85, 0.18); g.add(genPilot);
  // conduit mast the power line drops onto
  bar(0.88, fy, 0, 0.88, 1.78, 0, 0.022, steel);
  const insul0 = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.07, 5), mat(0x7a8a8f));
  insul0.position.set(0.88, 1.8, 0); g.add(insul0);
  // the missing parts, in place and invisible until you fit them
  genInstalled = new THREE.Group();
  const belt = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.022, 5, 22), rubber);
  belt.position.set(0.05, 0.4, -0.36);
  belt.scale.set(1, 0.28, 1);
  genInstalled.add(belt);
  const battB = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.2), mat(0x23262b));
  battB.position.set(0.28, 0.34, 0.42);
  genInstalled.add(battB);
  for (const [tz, tc] of [[-0.06, 0x8a2a22], [0.06, 0x26282b]]) {
    const term = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 6), brass);
    term.position.set(0.18, 0.48, 0.42 + tz);
    genInstalled.add(term);
    const tcap = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.03, 0.045), mat(tc));
    tcap.position.set(0.18, 0.5, 0.42 + tz);
    genInstalled.add(tcap);
  }
  const plugIn = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.09, 6), mat(0xd8d4c8));
  plugIn.rotation.x = 0.6;
  plugIn.position.set(-0.14, 1.02, 0.24);
  genInstalled.add(plugIn);
  genInstalled.visible = false;
  g.add(genInstalled);
  genLamp = new THREE.PointLight(0xffd9a0, 0, 11, 1.7);
  genLamp.position.set(0, 1.9, 0);
  g.add(genLamp);
  enableShadows(g);
  g.position.set(GEN.x, gy, GEN.z);
  g.rotation.y = GEN_ROT;
  scene.add(g);
  addCollider(GEN.x, GEN.z, 1.05);
}

/* the power line: leaning poles marching down the hill, tower to generator */
{
  const g = new THREE.Group();
  const poleM = mat(0x4c3e28, { map: barkTex }), wireM = mat(0x1c1c1c);
  function wire(a, b) { // a span with a sag in the middle
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y -= a.distanceTo(b) * 0.05;
    for (const [p, q] of [[a, mid], [mid, b]]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, p.distanceTo(q), 4), wireM);
      w.position.copy(p).add(q).multiplyScalar(0.5);
      w.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), q.clone().sub(p).normalize());
      g.add(w);
    }
  }
  const a = { x: HILL.x - 2.4, z: HILL.z + 2.4 }; // lashed to the tower's near leg
  const runAng = Math.atan2(GEN.x - HILL.x, GEN.z - HILL.z);
  let prev = new THREE.Vector3(a.x, groundY(HILL.x, HILL.z) + 6.2, a.z);
  const N = 7;
  for (let i = 1; i <= N; i++) {
    const t = i / (N + 1);
    const px2 = a.x + (GEN.x - a.x) * t + Math.sin(i * 2.7) * 1.6; // the run wanders a little
    const pz2 = a.z + (GEN.z - a.z) * t + Math.cos(i * 1.9) * 1.6;
    const py = groundY(px2, pz2);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 3.5, 6), poleM);
    pole.position.set(px2, py + 1.7, pz2);
    pole.rotation.z = Math.sin(i * 12.3) * 0.06; // none of them quite plumb any more
    pole.rotation.x = Math.cos(i * 7.7) * 0.05;
    g.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 0.06), poleM);
    arm.position.set(px2, py + 3.22, pz2);
    arm.rotation.y = runAng + Math.PI / 2;
    g.add(arm);
    const insul = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.07, 5), mat(0x7a8a8f));
    insul.position.set(px2, py + 3.3, pz2);
    g.add(insul);
    const top = new THREE.Vector3(px2, py + 3.32, pz2);
    wire(prev, top);
    prev = top;
  }
  wire(prev, new THREE.Vector3(
    GEN.x + 0.88 * Math.cos(GEN_ROT),
    groundY(GEN.x, GEN.z) + 1.8,
    GEN.z - 0.88 * Math.sin(GEN_ROT)));
  enableShadows(g);
  scene.add(g);
}

/* the stripped parts, each within a short search of the machine */
{
  const weath = mat(0x5a4c36, { map: barkTex });
  // the battery, dumped in a half-rotted crate beside a stump
  {
    const s1 = PART_SPOTS.Battery, y1 = groundY(s1.x, s1.z);
    const bg = new THREE.Group();
    bg.position.set(s1.x, y1, s1.z);
    bg.rotation.y = 0.8;
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.6), weath);
    base.position.y = 0.05; bg.add(base);
    for (const [wx, wz, ry] of [[0.29, 0, 0], [-0.29, 0, 0], [0, -0.29, Math.PI / 2]]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, 0.6), weath);
      wall.position.set(wx, 0.2, wz); wall.rotation.y = ry; bg.add(wall);
    }
    const fallen = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, 0.6), weath);
    fallen.position.set(0.15, 0.03, 0.5); fallen.rotation.set(Math.PI / 2, 0, 0.4); bg.add(fallen);
    const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.5, 7), mat(0x4a3a26, { map: barkTex }));
    stump.position.set(-0.8, 0.25, -0.3); bg.add(stump);
    const batt = new THREE.Group();
    const bb = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.2), mat(0x23262b));
    bb.position.y = 0.12; batt.add(bb);
    for (const [tz, tc] of [[-0.06, 0x8a2a22], [0.06, 0x26282b]]) {
      const term = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.04, 6), mat(0x8a7a4a));
      term.position.set(-0.1, 0.26, tz); batt.add(term);
      const tcap = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.025, 0.045), mat(tc));
      tcap.position.set(-0.1, 0.28, tz); batt.add(tcap);
    }
    const label = new THREE.Mesh(new THREE.BoxGeometry(0.345, 0.08, 0.205), mat(0xb8a23c));
    label.position.y = 0.12; batt.add(label);
    batt.position.set(0, 0.08, 0.05);
    batt.rotation.set(0.08, 0.5, 0.06); // dumped, not placed
    bg.add(batt);
    enableShadows(bg);
    scene.add(bg);
    addInteractable(batt, 'pickup', 'the battery', 'Battery', { item: 'Battery' });
  }
  // the spark plug, wrapped half in a red shop rag on a fallen log
  {
    const s2 = PART_SPOTS['Spark Plug'], y2 = groundY(s2.x, s2.z);
    const pg = new THREE.Group();
    pg.position.set(s2.x, y2, s2.z);
    pg.rotation.y = 2.1;
    const log2 = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.21, 2.0, 7), mat(0x4c3d2a, { map: barkTex }));
    log2.rotation.z = Math.PI / 2;
    log2.rotation.y = 0.2;
    log2.position.y = 0.18; pg.add(log2);
    const rag = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.3, 3, 2), mat(0x7a2020, { side: THREE.DoubleSide }));
    rag.rotation.set(-Math.PI / 2 + 0.15, 0, 0.4);
    rag.position.set(0.1, 0.37, 0.02); pg.add(rag);
    const plug = new THREE.Group();
    const cer = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.07, 6), mat(0xe0dcd0));
    cer.position.y = 0.05; plug.add(cer);
    const hex = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.03, 6), mat(0x8a8f94));
    hex.position.y = 0.01; plug.add(hex);
    const thr = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.04, 6), mat(0x8a5a34));
    thr.position.y = -0.02; plug.add(thr);
    plug.position.set(0.12, 0.4, 0.04);
    plug.rotation.set(Math.PI / 2 - 0.2, 0, 0.9); // lying across the rag
    pg.add(plug);
    enableShadows(pg);
    scene.add(pg);
    addInteractable(plug, 'pickup', 'the spark plug', 'Spark Plug', { item: 'Spark Plug' });
  }
  // the drive belt, hooked over the stub of a snapped sapling
  {
    const s3 = PART_SPOTS['Drive Belt'], y3 = groundY(s3.x, s3.z);
    const sg = new THREE.Group();
    sg.position.set(s3.x, y3, s3.z);
    sg.rotation.y = 4.0;
    const snag = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 1.7, 6), mat(0x574f42, { map: barkTex }));
    snag.position.y = 0.85;
    snag.rotation.z = 0.12; sg.add(snag);
    const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.04, 0.5, 5), mat(0x574f42));
    stub.position.set(0.22, 1.2, 0);
    stub.rotation.z = -1.2; sg.add(stub);
    const beltW = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.024, 5, 20), mat(0x1f1d1b));
    beltW.position.set(0.3, 1.05, 0);
    beltW.rotation.y = 0.3;
    beltW.rotation.z = 0.15; // hanging off the stub
    sg.add(beltW);
    enableShadows(sg);
    scene.add(sg);
    addInteractable(beltW, 'pickup', 'the drive belt', 'Drive Belt', { item: 'Drive Belt' });
  }
}

/* ---------------- scenes along the walking routes ---------------- */
const HUNTER_NOTE = { title: "A hunter's note", body:
`Third day. The elk are gone. Not moved on — gone, all at once, like water out of a cracked bowl.

Something keeps level with me on the ridge at dusk. When I stop, it stops. I have not seen it and I no longer try.

I am leaving the tent and the pans. Weight is life now. If you find this camp, take what you want — but do not stay the night in it.` };
{
  const canvasM2 = mat(0x8a7d5f, { side: THREE.DoubleSide }), poleM2 = mat(0x5f4a2e, { map: barkTex });
  // a one-man camp, folded flat by weather or by something else — off the cabin trail
  {
    const s = SCENE_SPOTS.camp, sy = groundY(s.x, s.z);
    const g = new THREE.Group();
    g.position.set(s.x, sy, s.z);
    g.rotation.y = 1.3;
    for (const [px2, pz2, rz] of [[-0.8, 0, 1.25], [0.8, 0.15, -1.35]]) { // the lean-to, down on its face
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 2.4, 5), poleM2);
      pole.position.set(px2, 0.16, pz2);
      pole.rotation.z = rz;
      g.add(pole);
    }
    const canvas2 = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.7, 4, 3), canvasM2);
    canvas2.rotation.x = -Math.PI / 2 + 0.1;
    canvas2.rotation.z = 0.3;
    canvas2.position.set(0, 0.14, -0.2);
    jitter(canvas2.geometry, 0.16); // slumped over whatever is left underneath
    g.add(canvas2);
    for (let i = 0; i < 6; i++) { // the fire ring, stone-cold
      const a = i / 6 * Math.PI * 2;
      const st = new THREE.Mesh(jitter(new THREE.DodecahedronGeometry(0.14), 0.05), mat(0x6f6f6f));
      st.position.set(1.7 + Math.cos(a) * 0.45, 0.08, 1.2 + Math.sin(a) * 0.45);
      g.add(st);
    }
    const char = new THREE.Mesh(new THREE.CircleGeometry(0.38, 10), new THREE.MeshBasicMaterial({ color: 0x17140f }));
    char.rotation.x = -Math.PI / 2;
    char.position.set(1.7, 0.02, 1.2);
    g.add(char);
    const pot2 = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.16, 8), mat(0x2c2c2e));
    pot2.position.set(2.2, 0.07, 0.9);
    pot2.rotation.z = 1.4; // tipped over, never washed
    g.add(pot2);
    const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.8, 7), mat(0x4a5245));
    roll.rotation.z = Math.PI / 2;
    roll.position.set(-0.4, 0.13, 1.5); // the bedroll, still rolled — he never slept again here
    g.add(roll);
    const pack = new THREE.Mesh(jitter(new THREE.BoxGeometry(0.45, 0.4, 0.3), 0.04), mat(0x54513c));
    pack.position.set(0.5, 0.2, 1.8);
    pack.rotation.y = 0.6;
    g.add(pack);
    enableShadows(g);
    scene.add(g);
    addInteractable(pack, 'search', 'abandoned pack', 'camp-pack', {});
    const noteM = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.68), paperM);
    noteM.position.set(s.x + 1.1, sy + 0.03, s.z + 2.3);
    noteM.rotation.x = -Math.PI / 2;
    noteM.rotation.z = 0.8;
    scene.add(noteM);
    addInteractable(noteM, 'note', 'Read the note', 'hunter-note', { note: HUNTER_NOTE });
  }
  // a snare line on the way to the bridge, checked by no one for a long time
  {
    const s = SCENE_SPOTS.snare, sy = groundY(s.x, s.z);
    const g = new THREE.Group();
    for (const [px2, pz2] of [[-1.6, 0], [1.6, 0.3]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 1.0, 5), poleM2);
      post.position.set(s.x + px2, sy + 0.5, s.z + pz2);
      post.rotation.z = (rng() - 0.5) * 0.2;
      g.add(post);
    }
    const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 3.2, 4), mat(0x3c3c3c));
    wire.rotation.z = Math.PI / 2 + 0.06;
    wire.position.set(s.x, sy + 0.82, s.z + 0.15);
    g.add(wire);
    for (let i = 0; i < 3; i++) { // wire nooses, one of them sprung
      const loop = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.006, 4, 8), mat(0x3c3c3c));
      loop.position.set(s.x - 1 + i, sy + 0.55, s.z + 0.12);
      loop.rotation.y = 0.3;
      g.add(loop);
    }
    enableShadows(g);
    scene.add(g);
    carcass(g, s.x + 0.4, s.z + 0.9, 0.16, 0x555a5f); // what the snare caught, long past mattering
  }
  // past the river: a stand of trees raked to the same height, all facing the hill
  {
    const g = new THREE.Group();
    clawMarks(g, SCENE_SPOTS.claws.x, SCENE_SPOTS.claws.z, 2.6);
    clawMarks(g, SCENE_SPOTS.claws.x + 9, SCENE_SPOTS.claws.z - 6, 2.7);
    clawMarks(g, SCENE_SPOTS.claws.x - 7, SCENE_SPOTS.claws.z - 10, 2.5);
    clawMarks(g, SCENE_SPOTS.claws.x + 3, SCENE_SPOTS.claws.z - 16, 2.8);
    scene.add(g);
  }
  // a ranger's cairn under the hill, knocked flat — the stones thrown, not fallen
  {
    const s = SCENE_SPOTS.cairn, sy = groundY(s.x, s.z);
    const g = new THREE.Group();
    for (let i = 0; i < 7; i++) {
      const st = new THREE.Mesh(jitter(new THREE.DodecahedronGeometry(0.16 + rng() * 0.1), 0.05), i % 2 ? mat(0x7d7a72) : mat(0x6f6f6f));
      const a = rng() * Math.PI * 2, d = 0.5 + rng() * 2.2;
      st.position.set(s.x + Math.cos(a) * d, sy + 0.09, s.z + Math.sin(a) * d);
      g.add(st);
    }
    const base = new THREE.Mesh(jitter(new THREE.DodecahedronGeometry(0.3), 0.08), mat(0x7d7a72));
    base.position.set(s.x, sy + 0.15, s.z); // only the footing stone still seated
    g.add(base);
    enableShadows(g);
    scene.add(g);
  }
  // the bridge's plank, leant against a boulder just off the path — you can't miss it
  {
    const py2 = groundY(PLANK_SPOT.x, PLANK_SPOT.z);
    const rock2 = new THREE.Mesh(jitter(new THREE.DodecahedronGeometry(0.55), 0.15), mat(0x6f6f6f));
    rock2.position.set(PLANK_SPOT.x, py2 + 0.3, PLANK_SPOT.z);
    rock2.scale.y = 0.8;
    scene.add(rock2);
    const plank2 = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.08, 2.9), mat(0x6e5a3a, { map: barkTex }));
    plank2.position.set(PLANK_SPOT.x + 0.5, py2 + 0.5, PLANK_SPOT.z);
    plank2.rotation.set(0, 0.4, -1.1); // leant up where someone left it
    scene.add(plank2);
    addInteractable(plank2, 'pickup', 'the plank', 'Plank', { item: 'Plank' });
  }
  // the caches themselves: small crates under scraps of tarp
  for (const c of CACHES) {
    const cy2 = groundY(c.x, c.z);
    const g = new THREE.Group();
    g.position.set(c.x, cy2, c.z);
    g.rotation.y = rng() * 3;
    const crate2 = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.5, 0.5), mat(0x6e5a3a));
    crate2.position.y = 0.25;
    g.add(crate2);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 0.54), mat(0x5f4c30));
    lid.position.set(0.12, 0.53, 0);
    lid.rotation.z = -0.12; // lid knocked ajar
    g.add(lid);
    const tarp = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.9, 3, 3), canvasM2);
    tarp.rotation.x = -Math.PI / 2 + 0.25;
    tarp.position.set(-0.25, 0.52, 0.1);
    jitter(tarp.geometry, 0.08);
    g.add(tarp);
    enableShadows(g);
    scene.add(g);
    addInteractable(crate2, 'search', 'supply cache', 'cache', { give: c.give });
  }
}

/* the ladder: three seconds of hand-over-hand, up or down */
function startClimb(up) {
  if (state.climb) return;
  state.climb = { t: 0, dur: 3, up, rung: 0 };
  if (!up) state.onTower = false;
  state.pos.x = HILL.x; state.pos.z = HILL.z + 3.4; // on the ladder line
  state.jumpY = 0; state.velY = 0; state.moving = false;
  state.lastGy = null; // hands on the rungs — this is a climb, not a fall
}
function finishClimb() {
  const up = state.climb.up;
  state.climb = null;
  if (up) {
    state.onTower = true;
    state.pos.x = HILL.x; state.pos.z = HILL.z + 1.9;
  } else {
    state.pos.x = SHACK.ladder.x; state.pos.z = SHACK.ladder.z + 0.9;
  }
  state.jumpY = 0; state.velY = 0; state.lastGy = null;
  if (up && chase) { // it will not climb — the pursuit breaks at the foot of the tower
    chase = null;
    audio.shriek();
    setTimeout(() => { if (!state.dead && !state.ended) audio.runPast(); }, 1200);
    toast('It circles the legs of the tower, and stops. It does not climb.');
  }
}

/* the chase — nothing is actually there. It just wants you to run. */
let chase = null;
function startChase() {
  if (chase || state.dead || state.ended || state.onTower || state.quest !== 8) return;
  chase = { t: 0, step: 0.6, beat: 0.2, voice: 2.2 };
  state.stamina = 15; // adrenaline
  audio.silence();
  audio.stinger();
  audio.shriek();
  state.shakeT = 0.7;
  toast('Behind you. RUN.');
}
function updateChase(dt) {
  chase.t += dt;
  // footfalls close behind, quickening the longer it runs you down
  chase.step -= dt;
  if (chase.step <= 0) {
    chase.step = Math.max(0.26, 0.44 - chase.t * 0.004);
    audio.chaseStep();
    if (Math.random() < 0.25) state.shakeT = Math.max(state.shakeT, 0.14);
  }
  chase.beat -= dt;
  if (chase.beat <= 0) { chase.beat = 0.82; audio.heartbeat(); }
  chase.voice -= dt;
  if (chase.voice <= 0) {
    chase.voice = 1.8 + Math.random() * 2.4;
    (Math.random() < 0.55 ? audio.growl : audio.crack)();
  }
  state.fogPulse = Math.max(state.fogPulse, 0.3); // the air stays thick while it's on you
  state.stamina = Math.max(state.stamina, 6);     // terror will not let your legs give out
  if (chase.t > 90) { // failsafe: it loses the scent before you lose your nerve
    chase = null;
    audio.runPast();
    toast('The footfalls veer off into the dark.');
  }
}
/* the generator fix: one long three-second wrench job once you have the parts */
function startGenFix() {
  if (state.fixT > 0 || state.generatorOn) return;
  state.fixT = 3;
  state.moving = false;
  audio.ratchet();
}
function finishGenFix() {
  take({ Battery: 1, 'Spark Plug': 1, 'Drive Belt': 1 });
  genInstalled.visible = true;
  state.generatorOn = true;
  state.quest = 8;
  shackLight.intensity = 1.4;
  genLamp.intensity = 1.0;
  genPilot.material.color.set(0x63e063);
  radioLamp.material.color.set(0x63e063);
  audio.clank();
  audio.hum();
  toast('The generator coughs, catches, holds. Light here — and up on the tower.');
  // the noise carried. Something answers it — first a growl, then claws,
  // and half of you goes with them. Then it runs you home.
  setTimeout(() => { if (!state.dead && !state.ended) audio.growl(0.5); }, 1200);
  setTimeout(() => {
    if (state.dead || state.ended) return;
    audio.scratch();
    audio.shriek();
    hurt(Math.ceil(state.health / 2), 'it');
    state.shakeT = 1.3;
    toast('Claws, out of the dark — and gone. RUN.');
  }, 2300);
  setTimeout(startChase, 4000);
}

/* ---------------- the long walks ----------------
   Between objectives the forest keeps you company: sounds that pick a side and
   keep it, footsteps that are not yours, and — once — something you half see. */
function trailPoint(t) { // a point on the walked trail, wobble and all
  const dx = TRAIL_B.x - TRAIL_A.x, dz = TRAIL_B.z - TRAIL_A.z;
  const wob = Math.sin(t * 9.2) * 6 + Math.sin(t * 23) * 2.5;
  return { x: TRAIL_A.x + dx * t + dz / TRAIL_LEN * wob, z: TRAIL_A.z + dz * t - dx / TRAIL_LEN * wob };
}
const transit = {
  next: 30,        // playSec of the next ambient event
  presence: null,  // {side, until, nextStep} — something pacing you, always the same side
  follower: null,  // {side, until} — a second set of footsteps under yours
  wasMoving: false,
};
function questTarget() {
  switch (state.quest) {
    case 0: case 1: return { x: 0, z: 0 };
    case 2: case 3: case 4: case 5: return CABIN;
    case 6: case 8: return HILL;
    case 7: return GEN;
    default: return null;
  }
}
function inTransit() {
  if (state.quest < 2 || state.onTower || state.climb || state.overlayOpen) return false;
  const t = questTarget();
  if (!t) return false;
  return Math.hypot(state.pos.x - t.x, state.pos.z - t.z) > 55 &&
         Math.hypot(state.pos.x - FIRE.x, state.pos.z - FIRE.z) > 30;
}
function updateTransit(dt) {
  // the fallen tree on the way back cracks once, close, the first time you near it
  if (returnDressing.deadfall && !returnDressing.heard &&
      Math.hypot(state.pos.x - returnDressing.deadfall.x, state.pos.z - returnDressing.deadfall.z) < 28) {
    returnDressing.heard = true;
    audio.crack();
    audio.thud();
    toast('A tree lies across the trail. It was not there this morning. The break is fresh.');
  }
  const active = inTransit();
  // the presence keeps pace off to one side, and never crosses over
  if (transit.presence) {
    if (state.playSec > transit.presence.until || !active) transit.presence = null;
    else if (state.moving && state.playSec > transit.presence.nextStep) {
      transit.presence.nextStep = state.playSec + 1.1 + Math.random() * 1.1;
      (Math.random() < 0.65 ? audio.rustle : audio.crack)(transit.presence.side * (0.55 + Math.random() * 0.3));
    }
  }
  // the follower stops a beat after you do — one step, sometimes two
  if (transit.wasMoving && !state.moving && transit.follower && state.playSec < transit.follower.until) {
    const p = transit.follower.side * 0.45;
    setTimeout(() => { if (!state.dead && !state.ended) audio.stepEcho(p); }, 300 + Math.random() * 130);
    if (Math.random() < 0.7)
      setTimeout(() => { if (!state.dead && !state.ended) audio.stepEcho(p); }, 720 + Math.random() * 220);
  }
  transit.wasMoving = state.moving;
  if (transit.follower && state.playSec > transit.follower.until) transit.follower = null;
  if (!active || state.playSec < transit.next) return;
  transit.next = state.playSec + Math.max(14, 26 + Math.random() * 26 - nightNumber() * 2);
  const side = Math.random() < 0.5 ? -1 : 1;
  const r = Math.random();
  if (r < 0.16) transit.follower = { side, until: state.playSec + 8 + Math.random() * 8 };
  else if (r < 0.3) transit.presence = { side, until: state.playSec + 9 + Math.random() * 7, nextStep: 0 };
  else if (r < 0.42) audio.knock(side * 0.6);
  else if (r < 0.5) audio.creak();
  else if (r < 0.62) {
    audio.rustle(side * 0.65);
    if (Math.random() < 0.5) setTimeout(() => { if (!state.dead && !state.ended) audio.crack(side * 0.65); }, 500);
  }
  else if (r < 0.7 && nightNumber() >= 2) audio.scream();
  else if (r < 0.78) audio.silence();
  else if (r < 0.86 && nightNumber() < 5 && !flock.active) { launchFlock(); audio.scream(); }
  else if (state.quest >= 6) { // the deep woods — and it knows where you are going
    const rr = Math.random();
    if (rr < 0.4) { audio.runPast(); state.shakeT = Math.max(state.shakeT, 0.25); }
    else if (rr < 0.7) { spawnTotem(10 + Math.random() * 8); audio.knock(side * 0.5); }
    else { audio.bang(); state.shakeT = Math.max(state.shakeT, 0.4); audio.heartbeat(); }
  } else audio.growl(side * 0.5);
}
/* the bridge: mid-span, the first time, the planks answer a second weight */
const bridgeScare = { fired: false, crossings: 0 };
function updateBridge() {
  const on = onBridge(state.pos.x, state.pos.z);
  if (!on) { bridgeScare.fired = false; return; }
  if (bridgeScare.fired || Math.abs(state.pos.x - RIVER_X) > 3) return;
  bridgeScare.fired = true;
  bridgeScare.crossings++;
  if (bridgeScare.crossings === 1) {
    audio.silence();
    setTimeout(() => {
      if (state.dead || state.ended) return;
      audio.thud();
      audio.creak();
      state.shakeT = Math.max(state.shakeT, 0.35);
      toast('The planks answer a weight that is not yours.');
    }, 900);
    setTimeout(() => { if (!state.dead && !state.ended) audio.heartbeat(); }, 1600);
  } else if (Math.random() < 0.5) {
    audio.creak();
    setTimeout(() => { if (!state.dead && !state.ended) audio.thud(); }, 400);
  }
}
/* once, far up the path, something crosses. It does not stop. It does not look. */
let crosser = null, crosserDone = false;
function tryCrosser() {
  crosserDone = true;
  const fx2 = -Math.sin(state.yaw), fz2 = -Math.cos(state.yaw); // straight up your line of travel
  const cx2 = state.pos.x + fx2 * 38, cz2 = state.pos.z + fz2 * 38;
  const dir = Math.random() < 0.5 ? 1 : -1;               // left to right, or right to left
  const px2 = -fz2 * dir, pz2 = fx2 * dir;
  const m = new THREE.MeshBasicMaterial({ color: 0x0a0c0d }); // fog does the rest
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.26, 1.8, 6), m);
  body.position.y = 1.35;
  body.rotation.x = 0.35; // it runs bent forward, too low for a man
  g.add(body);
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 0), m);
  head.position.set(0, 2.2, 0.45);
  g.add(head);
  for (const s of [1, -1]) { // limbs too long, caught mid-stride
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.03, 1.3, 5), m);
    leg.position.set(s * 0.12, 0.6, s * 0.3);
    leg.rotation.x = s * 0.55;
    g.add(leg);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.025, 1.1, 5), m);
    arm.position.set(s * 0.24, 1.15, -s * 0.25);
    arm.rotation.x = -s * 0.5;
    g.add(arm);
  }
  g.rotation.y = Math.atan2(px2, pz2); // facing its own line, not yours
  scene.add(g);
  crosser = { g, t: 0, dur: 1.35, fx: cx2 - px2 * 9, fz: cz2 - pz2 * 9, dx: px2 * 18, dz: pz2 * 18 };
  audio.silence();
  audio.stridesFar(-0.6 * dir, 0.6 * dir);
}
function updateCrosser(dt) {
  if (crosser) {
    crosser.t += dt;
    const k = Math.min(1, crosser.t / crosser.dur);
    const x = crosser.fx + crosser.dx * k, z = crosser.fz + crosser.dz * k;
    crosser.g.position.set(x, groundY(x, z) + Math.abs(Math.sin(k * 19)) * 0.14, z);
    if (k >= 1) {
      scene.remove(crosser.g);
      crosser = null;
      setTimeout(() => { if (!state.dead && !state.ended) toast('Something crossed the path ahead. It did not look at you.'); }, 700);
    }
    return;
  }
  if (crosserDone || state.quest !== 6 || !state.moving) return;
  if (Math.hypot(state.pos.x - CABIN.x, state.pos.z - CABIN.z) < 150 ||
      Math.hypot(state.pos.x - HILL.x, state.pos.z - HILL.z) < 150) return;
  if (Math.random() < dt * 0.025) tryCrosser();
}
/* the way back is never the way you came */
const returnDressing = { deadfall: null, heard: false };
function onQuestChange(q) {
  if (q !== 6 || returnDressing.deadfall) return;
  // a fresh deadfall across the trail you walked in on
  const p1 = trailPoint(0.45);
  const ty = groundY(p1.x, p1.z);
  const ang = Math.atan2(TRAIL_B.x - TRAIL_A.x, TRAIL_B.z - TRAIL_A.z);
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 7, 7), mat(0x574f42, { map: barkTex }));
  trunk.rotation.z = Math.PI / 2;
  trunk.position.y = 0.22;
  g.add(trunk);
  for (let i = 0; i < 4; i++) { // snapped branches thrown on the fall side
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 1.2, 5), mat(0x4c4438));
    br.position.set(-2.5 + i * 1.6, 0.35, (rng() - 0.5) * 0.8);
    br.rotation.set(rng() * 2, rng() * 3, rng() * 2);
    g.add(br);
  }
  const stumpB = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.9, 7), mat(0x574f42, { map: barkTex }));
  stumpB.position.set(3.9, 0.45, 0.4); // sheared off its own stump
  stumpB.rotation.z = 0.15;
  g.add(stumpB);
  g.position.set(p1.x, ty, p1.z);
  g.rotation.y = ang; // square across the path
  enableShadows(g);
  scene.add(g);
  returnDressing.deadfall = p1;
  // and a totem, hung at the trail's edge where there was nothing before
  const p2 = trailPoint(0.72);
  const dx = TRAIL_B.x - TRAIL_A.x, dz = TRAIL_B.z - TRAIL_A.z;
  spawnTotem(0, p2.x - dz / TRAIL_LEN * 3, p2.z + dx / TRAIL_LEN * 3);
}

/* quest interactions, checked before everything else */
/* the first bag you open — whichever it is — holds the flashlight; five of the
   seven bags hold the notes, and two were packed by someone with nothing to say */
function searchLuggage(data) {
  let gotSomething = false;
  if (!state.gotKit) {
    state.gotKit = true;
    if (state.quest === 0) state.quest = 1;
    give({ Flashlight: 1 });
    state.held = 'Flashlight';
    rebuildHeld();
    updateInvHUD();
    toast('+ Flashlight — it still works');
    audio.blip();
    gotSomething = true;
  }
  if (data && data.pieceIdx != null) {
    openNote(MAP_PIECES[data.pieceIdx]);
    foundPiece();
    audio.blip();
  } else if (!gotSomething) {
    toast('Clothes, papers — a life packed for somewhere else. Nothing you can use.');
  }
}
function questAction(px, pz) {
  // the cabin door
  if (cabinDoor.locked && Math.hypot(px - cabinDoor.pos.x, pz - cabinDoor.pos.z) < 2.4) {
    if (has({ 'Key': 1 }))
      return { label: 'Unlock the door (Key)', key: 'E', fn: () => {
        take({ 'Key': 1 });
        cabinDoor.locked = false;
        // the door swings in slowly, catching twice on its dry hinges
        cabinDoor.anim = { t: 0, dur: 2, from: cabinDoor.mesh.rotation.y, to: cabinDoor.mesh.rotation.y + 1.5 };
        audio.doorCreak();
        if (state.quest < 5) { state.quest = 5; toast('The door creaks in on darkness.'); }
      } };
    return { label: 'Try the cabin door', key: 'E', fn: () => {
      audio.rattle(); // the knob works against the lock, and holds
      toast('Locked. By the porch, one stone sits a little wrong.');
      if (state.quest >= 1 && state.quest <= 2) state.quest = 3;
    } };
  }
  // the pale stone
  if (state.quest >= 3 && cabinDoor.locked && !has({ 'Key': 1 }) && !keyRock.searched &&
      Math.hypot(px - keyRock.x, pz - keyRock.z) < 2.2)
    return { label: 'Look under the stone', key: 'E', fn: () => {
      keyRock.searched = true;
      state.stoneT = 3; // knees in the mud, working it loose
      state.moving = false;
      audio.rustle();
      setTimeout(() => { if (!state.dead && !state.ended) { audio.crack(); audio.rustle(); } }, 1100); // it tips over
      setTimeout(() => { if (!state.dead && !state.ended) audio.rustle(); }, 2200); // fingers in the cold earth
    } };
  // hands full, head down
  if (state.stoneT > 0) return { label: 'Turning the stone over…' };
  if (state.fixT > 0) return { label: 'Fixing the generator…' };
  // the gap in the bridge
  if (!bridgeGap.fixed && Math.hypot(px - bridgeGap.x, pz - BRIDGE.z) < 2.6) {
    if (has({ Plank: 1 }))
      return { label: 'Lay the plank across the gap (Plank)', key: 'E', fn: () => {
        take({ Plank: 1 });
        bridgeGap.fixed = true;
        bridgeGap.seg.open = true;
        bridgeGap.mesh.visible = true;
        audio.knock();
        setTimeout(() => { if (!state.dead && !state.ended) audio.clank(); }, 500);
        toast('The plank drops in and sits true. It will hold.');
      } };
    return { label: 'A plank is missing — the gap is too wide to cross' };
  }
  // the tower ladder
  if (!state.onTower && Math.hypot(px - SHACK.ladder.x, pz - SHACK.ladder.z) < 2.2)
    return { label: 'Climb the ladder', key: 'E', fn: () => startClimb(true) };
  if (state.onTower && pz - HILL.z > 1.5 && Math.abs(px - HILL.x) < 1.6)
    return { label: 'Climb back down', key: 'E', fn: () => startClimb(false) };
  // the radio, up on the platform
  if (state.onTower && Math.hypot(px - SHACK.radio.x, pz - SHACK.radio.z) < 2.2) {
    if (state.quest >= 6 && state.quest < 7)
      return { label: 'Try the radio', key: 'E', fn: () => {
        state.quest = 7;
        toast('Dead. No power. A line runs from the tower down the hill — the generator is at the end of it.');
        audio.crack();
      } };
    if (state.quest === 8)
      return { label: 'Call for help', key: 'E', fn: () => {
        state.quest = 9;
        audio.radioFX();
        setTimeout(triggerEnding, 2600);
      } };
  }
  // the generator — stripped for parts; it runs again once you've found them all
  if (state.quest === 7 && !state.generatorOn && Math.hypot(px - GEN.x, pz - GEN.z) < 2.8) {
    const missing = GEN_PARTS.filter(k => !has({ [k]: 1 }));
    if (missing.length)
      return { label: `Stripped. Still missing: ${missing.join(', ').toLowerCase()}` };
    return { label: 'Fix the generator', key: 'E', fn: startGenFix };
  }
  return null;
}

/* ---------------- horror props (revealed by day) ---------------- */
const dayProps = [];
function propGroup(day, builder) {
  const g = new THREE.Group();
  builder(g);
  g.visible = false;
  scene.add(g);
  dayProps.push({ day, group: g });
}
/* the remains of an animal — spine, ribcage, skull and one outstretched leg:
   enough left to know exactly what it was and what happened to it */
function furTex(color) { // matted, directional fur over the base hide colour
  const cache = furTex.cache = furTex.cache || {}; // carcasses spawn before this line runs — no TDZ
  if (cache[color]) return cache[color];
  const base = new THREE.Color(color);
  return cache[color] = makeCanvasTex(64, (c, s) => {
    c.fillStyle = '#' + base.getHexString();
    c.fillRect(0, 0, s, s);
    for (let i = 0; i < 500; i++) { // short strokes, all lying the same rough way
      const shade = 0.6 + Math.random() * 0.75;
      c.strokeStyle = `rgba(${base.r * 255 * shade | 0},${base.g * 255 * shade | 0},${base.b * 255 * shade | 0},.5)`;
      c.lineWidth = 1;
      const x2 = Math.random() * s, y2 = Math.random() * s, a = 0.9 + (Math.random() - 0.5) * 0.7;
      c.beginPath();
      c.moveTo(x2, y2);
      c.lineTo(x2 + Math.cos(a) * (2 + Math.random() * 3), y2 + Math.sin(a) * (2 + Math.random() * 3));
      c.stroke();
    }
    blotches(c, s, ['#241a10'], 8, 2, 6, 0.3); // matted dark patches
  }, 2, 2);
}
function carcass(g, x, z, size, color) {
  const gy = groundY(x, z);
  const boneM = mat(0xd8cfb8), boneD = mat(0xc2b79c), hideM = mat(color, { map: furTex(color) }), hoofM = mat(0x2a231c);
  const fleshM = mat(0x6e2019), sinewM = mat(0x4a1610);
  const c = new THREE.Group();
  c.position.set(x, gy, z);
  c.rotation.y = rng() * Math.PI * 2; // lies along a random heading, nose at +x
  // spine: a sagging run of vertebrae from pelvis to skull
  for (let i = 0; i < 7; i++) {
    const v = new THREE.Mesh(new THREE.BoxGeometry(size * 0.24, size * 0.16, size * 0.2), i % 2 ? boneM : boneD);
    v.position.set((i - 3) * size * 0.34, size * (0.5 - Math.abs(i - 3) * 0.05), (rng() - 0.5) * size * 0.08);
    v.rotation.y = (rng() - 0.5) * 0.3;
    c.add(v);
  }
  // ribcage: hoops arching over the front half, a couple knocked loose — not
  // picked quite clean: dried flesh still webs some of the gaps
  const ARC = Math.PI * 1.15;
  for (let i = 0; i < 5; i++) {
    const rr = size * (0.52 - Math.abs(i - 2) * 0.055);
    const rib = new THREE.Mesh(new THREE.TorusGeometry(rr, size * 0.035, 5, 10, ARC), i % 2 ? boneM : boneD);
    rib.position.set((i - 0.6) * size * 0.3, size * 0.4, 0);
    rib.rotation.set((rng() - 0.5) * (i > 3 ? 0.9 : 0.25), Math.PI / 2, Math.PI / 2 - ARC / 2);
    c.add(rib);
    if (i < 4 && rng() < 0.6) { // a ragged web of dried meat between this rib and the next
      const web = new THREE.Mesh(jitter(new THREE.PlaneGeometry(size * 0.26, rr * 1.1, 2, 3), size * 0.06),
        new THREE.MeshLambertMaterial({ color: 0x571a12, side: THREE.DoubleSide }));
      web.position.set((i - 0.45) * size * 0.3, size * 0.42, (rng() - 0.5) * size * 0.2);
      web.rotation.set(0.2 + rng() * 0.4, 0.15, 1.57);
      c.add(web);
    }
  }
  // sinew strands still lashing the spine to the cage
  for (let i = 0; i < 3; i++) {
    const sn = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.012, size * 0.012, size * 0.34, 4), sinewM);
    sn.position.set((i - 1) * size * 0.35, size * 0.42, (rng() - 0.5) * size * 0.16);
    sn.rotation.set(0.6 + rng() * 0.5, rng(), 0.4);
    c.add(sn);
  }
  // pelvis at the tail end
  const pelvis = new THREE.Mesh(new THREE.IcosahedronGeometry(size * 0.28, 0), boneD);
  pelvis.scale.set(1.1, 0.6, 1.3);
  pelvis.position.set(-size * 1.2, size * 0.3, 0);
  c.add(pelvis);
  // what's left of the hide, collapsed over the haunches
  const hide = new THREE.Mesh(jitter(new THREE.IcosahedronGeometry(size * 0.55, 0), size * 0.18), hideM);
  hide.scale.set(1.5, 0.5, 1.0);
  hide.position.set(-size * 0.9, size * 0.22, -size * 0.15);
  hide.rotation.y = 0.3;
  c.add(hide);
  // torn-open flank under the ribs — ragged, dark, and glistening faintly
  const wound = new THREE.Mesh(jitter(new THREE.IcosahedronGeometry(size * 0.38, 1), size * 0.09),
    new THREE.MeshPhongMaterial({ color: 0x571812, shininess: 30, flatShading: true }));
  wound.scale.set(1.3, 0.5, 0.8);
  wound.position.set(size * 0.1, size * 0.24, size * 0.12);
  c.add(wound);
  // the skull, long-snouted, twisted back against the ground — sockets, teeth,
  // the lower jaw dropped a hand's width from where it should be
  const skull = new THREE.Mesh(jitter(new THREE.IcosahedronGeometry(size * 0.22, 1), size * 0.03), boneM);
  skull.scale.set(1.35, 0.85, 0.8);
  skull.position.set(size * 1.35, size * 0.18, size * 0.1);
  skull.rotation.set(0.5, 0.7, 0);
  c.add(skull);
  const snout = new THREE.Mesh(new THREE.BoxGeometry(size * 0.34, size * 0.11, size * 0.11), boneD);
  snout.position.set(size * 1.58, size * 0.13, size * 0.22);
  snout.rotation.y = 0.7;
  c.add(snout);
  for (const s of [1, -1]) { // the sockets, staring at nothing in two directions
    const socket = new THREE.Mesh(new THREE.SphereGeometry(size * 0.05, 6, 5), mat(0x14100c));
    socket.position.set(size * (1.38 + s * 0.05), size * 0.24, size * (0.1 + s * 0.14));
    c.add(socket);
  }
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(size * 0.3, size * 0.05, size * 0.08), boneD);
  jaw.position.set(size * 1.5, size * 0.04, size * 0.38); // dropped clear of the skull
  jaw.rotation.y = 1.1;
  c.add(jaw);
  for (let i = 0; i < 4; i++) { // a row of teeth still seated in it
    const tooth = new THREE.Mesh(new THREE.ConeGeometry(size * 0.012, size * 0.035, 4), boneM);
    tooth.position.set(size * (1.42 + i * 0.045), size * 0.075, size * (0.42 - i * 0.02));
    c.add(tooth);
  }
  // loose vertebrae scattered where something worried at the spine
  for (let i = 0; i < 3; i++) {
    const lv = new THREE.Mesh(new THREE.BoxGeometry(size * 0.14, size * 0.1, size * 0.12), i % 2 ? boneM : boneD);
    lv.position.set((rng() - 0.3) * size * 1.6, size * 0.06, (rng() > 0.5 ? 1 : -1) * size * (0.5 + rng() * 0.5));
    lv.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    c.add(lv);
  }
  if (size >= 0.4) { // big enough to be a deer — forked antlers still on the skull
    for (const s of [1, -1]) {
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.025, size * 0.035, size * 0.85, 5), boneD);
      beam.position.set(size * 1.3, size * 0.5, size * (0.1 + s * 0.16));
      beam.rotation.set(s * 0.55, 0, -0.5);
      c.add(beam);
      const tine = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.018, size * 0.025, size * 0.4, 5), boneD);
      tine.position.set(size * 1.42, size * 0.75, size * (0.1 + s * 0.28));
      tine.rotation.set(s * 0.9, 0, 0.35);
      c.add(tine);
    }
  }
  // one hind leg stretched out stiff: femur, shin, and a dark hoof
  const femur = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.07, size * 0.09, size * 0.75, 6), hideM);
  femur.position.set(-size * 1.1, size * 0.24, size * 0.5);
  femur.rotation.x = 1.25;
  c.add(femur);
  const shin = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.04, size * 0.055, size * 0.8, 6), boneD);
  shin.position.set(-size * 1.15, size * 0.11, size * 1.2);
  shin.rotation.x = 1.72;
  c.add(shin);
  const hoof = new THREE.Mesh(new THREE.BoxGeometry(size * 0.14, size * 0.1, size * 0.18), hoofM);
  hoof.position.set(-size * 1.16, size * 0.07, size * 1.62);
  c.add(hoof);
  // a foreleg bone flung a little way off
  const stray = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.035, size * 0.05, size * 0.7, 5), boneM);
  stray.position.set(size * (0.6 + rng() * 0.6), size * 0.06, -size * (0.8 + rng() * 0.5));
  stray.rotation.set(Math.PI / 2, 0, rng() * 3);
  c.add(stray);
  g.add(c);
  // blood, smeared not circular
  const bm = new THREE.MeshBasicMaterial({ color: 0x3d0d0f, transparent: true, opacity: 0.88 });
  for (let i = 0; i < 4; i++) {
    const stain = new THREE.Mesh(new THREE.CircleGeometry(size * (0.7 + rng() * 1.1), 7), bm);
    stain.rotation.x = -Math.PI / 2;
    stain.rotation.z = rng() * 3;
    stain.scale.x = 0.6 + rng() * 0.9;
    stain.position.set(x + (rng() - 0.5) * size * 1.6, groundY(x, z) + 0.035 + i * 0.003, z + (rng() - 0.5) * size * 1.6);
    g.add(stain);
  }
  // flies circling over it
  const fgeo = new THREE.BufferGeometry();
  fgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
  const flies = new THREE.Points(fgeo, fliesMat);
  flies.position.set(x, groundY(x, z) + size + 0.35, z);
  flies.frustumCulled = false;
  g.add(flies);
  flyClusters.push(flies);
}
function clawMarks(g, x, z, height) {
  // find nearest tree, put marks on its trunk side
  let best = null, bd = 1e9;
  for (const t of treeData) {
    const d = Math.hypot(t.x - x, t.z - z);
    if (d < bd) { bd = d; best = t; }
  }
  const bx = best ? best.x : x, bz = best ? best.z : z;
  const by = groundY(bx, bz);
  const markM = new THREE.MeshBasicMaterial({ color: 0xd6c9a8 });
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.1, 0.05), markM);
    const a = rng() * Math.PI * 2;
    s.position.set(bx + Math.cos(a) * 0.4, by + height + i * 0.12, bz + Math.sin(a) * 0.4);
    s.rotation.z = 0.15 - i * 0.1;
    g.add(s);
  }
}
propGroup(1, g => carcass(g, 6, 7, 0.18, 0x555a5f));                          // dead bird near crash
propGroup(3, g => {                                                            // marks closer + small cluster
  clawMarks(g, 30, 25, 2.6); clawMarks(g, -25, 30, 2.8);
  carcass(g, 40, -25, 0.3, 0x5c3a35);
});
propGroup(4, g => {                                                            // cluster escalates
  carcass(g, 41, -27, 0.35, 0x5c3a35); carcass(g, 39, -23, 0.3, 0x5c3a35);
  carcass(g, 43, -24, 0.28, 0x555a5f);
  clawMarks(g, 42, -25, 3.2);
});
propGroup(5, g => {                                                            // shelter perimeter marks
  clawMarks(g, SHELTER.x + 12, SHELTER.z + 4, 3.0);
  clawMarks(g, SHELTER.x - 10, SHELTER.z - 8, 3.2);
  clawMarks(g, SHELTER.x + 3, SHELTER.z + 13, 3.4);
});
propGroup(6, g => carcass(g, 7, 20, 0.85, 0x4d2f2c));                          // large carcass on the path
propGroup(7, g => {                                                            // ring around the shelter
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    clawMarks(g, SHELTER.x + Math.cos(a) * 9, SHELTER.z + Math.sin(a) * 9, 3.2 + rng() * 0.5);
  }
});
function revealProps() {
  for (const p of dayProps) if (p.day <= state.day) p.group.visible = true;
}

/* ---------------- the unseen ---------------- */
/* Nothing in these woods is ever shown. The scares are sound, stillness, and the
   things it leaves behind — and they get worse night by night. */

/* stick totems — crude figures of lashed sticks, hung at head height. You never
   see one arrive. You only find them. */
const totems = [];
function spawnTotem(dist, atX, atZ) {
  if (totems.length > 14) {
    const old = totems.shift();
    scene.remove(old.g);
  }
  const ang = state.yaw + (rng() - 0.5) * 1.1;
  const d = dist || 16 + rng() * 12;
  const x = atX !== undefined ? atX : clamp(state.pos.x - Math.sin(ang) * d, -WORLD, WORLD);
  const z = atZ !== undefined ? atZ : clamp(state.pos.z - Math.cos(ang) * d, -WORLD, WORLD);
  const stickM = mat(0x6b5232, { map: barkTex });
  const gr = new THREE.Group();
  const fig = new THREE.Group();
  function stick(len, r) {
    return new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.25, len, 5), stickM);
  }
  const spine = stick(0.85, 0.018);
  spine.position.y = -0.1;
  fig.add(spine);
  const arms = stick(0.66, 0.015);
  arms.rotation.z = Math.PI / 2;
  arms.position.y = 0.1;
  fig.add(arms);
  for (const s of [-1, 1]) {
    const leg = stick(0.5, 0.014);
    leg.position.set(s * 0.1, -0.56, 0);
    leg.rotation.z = s * 0.35;
    fig.add(leg);
    const drop = stick(0.34, 0.011); // forearms hanging from the crossbar
    drop.position.set(s * 0.3, -0.1, 0);
    drop.rotation.z = s * 0.12;
    fig.add(drop);
  }
  const head = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.018, 5, 9), mat(0x8a7c5c));
  head.position.y = 0.36;
  fig.add(head);
  const twine = stick(1.15, 0.005); // strung up from somewhere overhead
  twine.position.y = 0.98;
  fig.add(twine);
  fig.position.y = 1.75;
  gr.add(fig);
  gr.position.set(x, groundY(x, z), z);
  gr.rotation.y = rng() * Math.PI * 2;
  enableShadows(gr);
  scene.add(gr);
  totems.push({ g: gr, fig, ph: rng() * 7 });
}
function updateTotems(now) {
  for (const t of totems) { // they turn, slowly, on their strings
    t.fig.rotation.y = Math.sin(now * 0.00021 + t.ph) * 1.2;
    t.fig.rotation.z = Math.sin(now * 0.0011 + t.ph) * 0.05;
  }
}

/* one scare, escalating with the night — sounds first, then closer, then physical */
function triggerScare() {
  const n = clamp(nightNumber(), 1, 7);
  const roll = rng();
  if (n >= 4 && roll > 0.8) {          // late nights: it touches the world
    audio.bang();
    state.shakeT = Math.max(state.shakeT, 0.45);
    audio.heartbeat();
    spawnTotem(9 + rng() * 6);
  } else if (n >= 3 && roll > 0.62) {  // something runs straight past you in the dark
    audio.runPast();
    state.shakeT = Math.max(state.shakeT, 0.2);
    drainSanity(6);
  } else if (n >= 2 && roll > 0.45) {
    audio.scream();
    drainSanity(4);
  } else if (roll > 0.3) {
    audio.knock();
  } else if (roll > 0.15) {
    audio.crack();
    audio.rustle();
  } else {
    audio.silence(); // the worst sound of all
  }
}

/* daytime unease — and the things you find where nothing should be */
function runDayGlimpses() {
  // the quiet-hours glimpses — the endless night has no lulls, only pauses
  if (state.absHours < state.nextGlimpse) return;
  const roll = rng();
  if (roll < 0.3) { audio.silence(); drainSanity(2); }
  else if (roll < 0.52) { audio.crack(); drainSanity(2); }
  else if (roll < 0.7) { audio.knock(); drainSanity(3); } // knocking, from nothing
  else if (roll < 0.9) spawnTotem(18 + rng() * 14);       // it was here. Recently.
  else { audio.rustle(); audio.scream(); drainSanity(3); }
  // more frequent as the nights stack up — and much worse on the road to the tower
  let gap = (0.6 + rng() * 1.1) * Math.max(0.45, 1.35 - nightNumber() * 0.13);
  if (state.quest === 6 || state.quest === 7) gap *= 0.35;
  state.nextGlimpse = state.absHours + gap;
}

/* the hollow knows when you step into it after dark */
function checkHollow() {
  const d = Math.hypot(state.pos.x - HOLLOW.x, state.pos.z - HOLLOW.z);
  if (d > 12) return;
  if (!state.hollowWarned) {
    state.hollowWarned = true;
    audio.silence();
    toast(isNight() ? 'You should not be here.' : 'Nothing grows here. Nothing sings.');
  }
  if (isNight() && state.playSec > (state.hollowScareCd || 0)) {
    state.hollowScareCd = state.playSec + 120;
    audio.silence();
    setTimeout(() => { if (!state.dead && !state.ended) { audio.runPast(); state.shakeT = 0.35; } }, 1500);
    setTimeout(() => { if (!state.dead && !state.ended) { audio.shriek(); state.shakeT = 0.7; spawnTotem(6); } }, 5200);
  }
}

/* ---------------- weather: storms that build, break, and pass ---------------- */
const weather = {
  phase: 'clear',            // clear -> building -> storm -> clear
  until: 0, buildUntil: 0,
  nextCheck: START_HOUR + 3,
  flash: 0, nextBolt: 0, nextRumble: 0,
  intensity: 0,              // 0 clear sky .. 1 full storm; eases between states
};
function stormActive() { return weather.phase === 'storm'; }
function startStorm(hours) {
  if (weather.phase !== 'clear') { weather.until = Math.max(weather.until, state.absHours + hours); return; }
  weather.phase = 'building';
  weather.buildUntil = state.absHours + 0.5 + rng() * 0.4; // half an hour of gathering clouds first
  weather.until = state.absHours + hours;
  weather.nextRumble = 8;
  toast('The light changes. Clouds are stacking on the horizon.');
}
function updateWeather(dt) {
  weather.flash = Math.max(0, weather.flash - dt * 2.2);
  // sky conditions ease in and out rather than snapping
  const target = weather.phase === 'storm' ? 1 : weather.phase === 'building' ? 0.55 : 0;
  weather.intensity += (target - weather.intensity) * Math.min(1, dt * 0.12);

  if (weather.phase === 'building') {
    weather.nextRumble -= dt;
    if (weather.nextRumble <= 0) {
      weather.nextRumble = 14 + Math.random() * 20;
      audio.thunderFar(0.5 + Math.random()); // still a long way off
    }
    if (state.absHours >= weather.buildUntil) {
      weather.phase = 'storm';
      weather.nextBolt = 12 + Math.random() * 10; // even then, the first strike takes its time
      audio.setStorm(true);
      toast('The rain arrives all at once.');
    }
  } else if (weather.phase === 'storm') {
    if (state.absHours >= weather.until) {
      weather.phase = 'clear';
      audio.setStorm(false);
      toast('The storm moves off, grumbling.');
    } else {
      weather.nextBolt -= dt;
      if (weather.nextBolt <= 0) {
        weather.nextBolt = 6 + Math.random() * 16;
        weather.flash = 1;
        audio.thunder(0.4 + Math.random() * 1.8);
      }
    }
  } else if (state.absHours >= weather.nextCheck) {
    // roll for fresh weather a few times an in-game hour
    weather.nextCheck = state.absHours + 0.75;
    if (rng() < 0.14) startStorm(1 + rng() * 1.5);
  }
}

/* rain particles */
const particles = (() => {
  const N = 1200, R = 34;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (rng() * 2 - 1) * R;
    pos[i * 3 + 1] = rng() * 14;
    pos[i * 3 + 2] = (rng() * 2 - 1) * R;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xb6c3d2, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.55,
  }));
  pts.visible = false;
  scene.add(pts);
  return { pts, geo, N, R };
})();
function updateParticles(dt) {
  particles.pts.visible = stormActive(); // driven rain only when a storm is on
  if (!particles.pts.visible) return;
  particles.pts.material.opacity = 0.6;
  particles.pts.position.set(state.pos.x, 0, state.pos.z);
  const p = particles.geo.attributes.position;
  for (let i = 0; i < particles.N; i++) {
    let x = p.getX(i) + dt * 3, y = p.getY(i) - dt * (13 + (i % 5) * 2.2), z = p.getZ(i) + dt * 1.2;
    if (x > particles.R) x = -particles.R;
    if (z > particles.R) z = -particles.R;
    if (y < 0) y = 14;
    p.setXYZ(i, x, y, z);
  }
  p.needsUpdate = true;
}

/* ---------------- animals ---------------- */
const animals = [];
function buildSnake() {
  const g = new THREE.Group();
  const m = mat(0x5a6b2f, { map: leafTex });
  const segs = [];
  for (let i = 0; i < 8; i++) { // tapers toward the tail
    const r = i === 0 ? 0.11 : Math.max(0.03, 0.1 - i * 0.011);
    const s = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), i === 0 ? mat(0x6b7a38) : m);
    s.position.set(0, 0.07, -i * 0.15);
    g.add(s); segs.push(s);
  }
  const eyeL = new THREE.Mesh(new THREE.IcosahedronGeometry(0.018, 0), mat(0x0d0d0d));
  eyeL.position.set(-0.05, 0.12, 0.06); g.add(eyeL);
  const eyeR = eyeL.clone(); eyeR.position.x = 0.05; g.add(eyeR);
  g.userData.segs = segs;
  return g;
}
function buildRabbit() {
  const g = new THREE.Group();
  const m = mat(0x8a7a63);
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 0), m);
  body.scale.set(0.9, 1, 1.3); body.position.y = 0.26;
  g.add(body);
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 0), m);
  head.position.set(0, 0.42, 0.22);
  g.add(head);
  for (const sx of [-0.05, 0.05]) {
    const ear = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.24, 0.06), m);
    ear.position.set(sx, 0.6, 0.18); ear.rotation.x = -0.2;
    g.add(ear);
  }
  for (const [sx, sz] of [[-0.09, 0.14], [0.09, 0.14], [-0.1, -0.14], [0.1, -0.14]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.06), m);
    leg.position.set(sx, 0.08, sz);
    g.add(leg);
  }
  const tail = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06, 0), mat(0xd8d2c4));
  tail.position.set(0, 0.3, -0.28);
  g.add(tail);
  return g;
}
function buildGroundBird() {
  const g = new THREE.Group();
  const m = mat(0x4a4a52), m2 = mat(0x3c3c44);
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), m);
  body.scale.set(0.9, 0.9, 1.5); body.position.y = 0.12;
  g.add(body);
  for (const s of [1, -1]) { // folded wings
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.18), m2);
    wing.position.set(s * 0.09, 0.15, -0.01);
    wing.rotation.x = 0.15;
    g.add(wing);
  }
  const tailF = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, 0.14), m2);
  tailF.position.set(0, 0.14, -0.19);
  tailF.rotation.x = -0.35;
  g.add(tailF);
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06, 0), m);
  head.position.set(0, 0.23, 0.12);
  g.add(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.08, 4), mat(0xcc9933));
  beak.rotation.x = Math.PI / 2; beak.position.set(0, 0.23, 0.2);
  g.add(beak);
  return g;
}
function buildSpider() {
  const g = new THREE.Group();
  const m = mat(0x1e1a16);
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), m);
  body.position.y = 0.08;
  g.add(body);
  for (let i = 0; i < 4; i++) for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.2), m);
    leg.position.set(s * 0.12, 0.05, -0.1 + i * 0.07);
    leg.rotation.y = s * 0.7;
    g.add(leg);
  }
  return g;
}
function buildBear() {
  const g = new THREE.Group();
  const m = mat(0x4a3626), m2 = mat(0x3c2c1e);
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), m);
  body.scale.set(1.05, 0.95, 1.6); body.position.y = 0.78;
  g.add(body);
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), m);
  head.position.set(0, 1.1, 0.9);
  g.add(head);
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.24), m2);
  snout.position.set(0, 1.02, 1.18);
  g.add(snout);
  for (const sx of [-0.16, 0.16]) {
    const ear = new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 0), m2);
    ear.position.set(sx, 1.34, 0.82);
    g.add(ear);
  }
  for (const [sx, sz] of [[-0.32, 0.55], [0.32, 0.55], [-0.32, -0.55], [0.32, -0.55]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.55, 0.24), m2);
    leg.position.set(sx, 0.28, sz);
    g.add(leg);
  }
  return g;
}
function buildWolf() {
  const g = new THREE.Group();
  const m = mat(0x5a5c60), m2 = mat(0x4a4c50);
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 0), m);
  body.scale.set(0.85, 0.9, 1.7); body.position.y = 0.52;
  g.add(body);
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 0), m);
  head.position.set(0, 0.68, 0.62);
  g.add(head);
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, 0.2), m2);
  snout.position.set(0, 0.63, 0.82);
  g.add(snout);
  for (const sx of [-0.07, 0.07]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.12, 4), m2);
    ear.position.set(sx, 0.82, 0.56);
    g.add(ear);
  }
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.4), m2);
  tail.position.set(0, 0.58, -0.62);
  tail.rotation.x = -0.5;
  g.add(tail);
  for (const [sx, sz] of [[-0.15, 0.35], [0.15, 0.35], [-0.15, -0.35], [0.15, -0.35]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.1), m2);
    leg.position.set(sx, 0.25, sz);
    g.add(leg);
  }
  return g;
}
const ANIMAL_HP = { snake: 1, rabbit: 1, bird: 1, spider: 1, wolf: 4, bear: 8 };
function spawnAnimal(type, fx, fz) {
  let p;
  if (fx !== undefined) p = { x: fx, z: fz };
  else {
    p = scatterPos();
    if (type === 'wolf' || type === 'bear') {
      // predators start well away from the crash site
      for (let i = 0; i < 30 && Math.hypot(p.x, p.z) < 80; i++) p = scatterPos();
    }
  }
  const builders = { snake: buildSnake, rabbit: buildRabbit, bird: buildGroundBird, spider: buildSpider, bear: buildBear, wolf: buildWolf };
  const g = builders[type]();
  g.position.set(p.x, groundY(p.x, p.z), p.z);
  if (type === 'bear' || type === 'wolf') enableShadows(g);
  scene.add(g);
  animals.push({ type, g, x: p.x, z: p.z, hx: p.x, hz: p.z, heading: rng() * Math.PI * 2,
    state: 'idle', t: rng() * 4, alarm: 0, fleeT: 0, alive: true, deadT: 0, flyY: 0,
    hp: ANIMAL_HP[type], atkCd: 0, staggerT: 0, rageT: 0 });
}
/* only the small things live here now — anything bigger left, or was taken.
   birds and spiders stay; bears, wolves, snakes and rabbits are gone. */
for (let i = 0; i < Math.round(12 * DENS); i++) spawnAnimal('bird');
for (let i = 0; i < Math.round(10 * DENS); i++) spawnAnimal('spider');

function updateAnimals(dt, now) {
  const px = state.pos.x, pz = state.pos.z;
  for (const a of animals) {
    if (!a.alive) {
      a.deadT += dt;
      if (a.deadT > 25) { // gone; something new turns up elsewhere later
        const p = scatterPos();
        a.x = a.hx = p.x; a.z = a.hz = p.z;
        a.alive = true; a.state = 'idle'; a.alarm = 0; a.flyY = 0;
        a.hp = ANIMAL_HP[a.type]; a.rageT = 0; a.atkCd = 0;
        a.g.rotation.z = 0; a.g.scale.y = 1;
      } else continue;
    }
    a.t += dt;
    a.atkCd = Math.max(0, a.atkCd - dt);
    a.rageT = Math.max(0, a.rageT - dt);
    if (a.staggerT > 0) a.staggerT -= dt;
    const d = Math.hypot(px - a.x, pz - a.z);
    const playerSafe = nearFire(); // everything out here fears the fire
    let speed = 0;
    if (a.type === 'snake') {
      // slow wander around home; doesn't flee — and it bites if you stand over it
      if (a.t > 4) { a.t = 0; a.heading = Math.atan2(a.hx - a.x, a.hz - a.z) + (rng() - 0.5) * 2.4; }
      speed = 0.5;
      if (d < 2.2 && Math.random() < dt * 0.5) audio.hiss();
      if (d < 1.1 && a.atkCd <= 0) { a.atkCd = 2; hurt(6, 'snakebite'); audio.hiss(); }
    } else if (a.type === 'bear') {
      const aggro = !playerSafe && (d < 16 || a.rageT > 0) && d < 34;
      if (a.staggerT > 0) speed = 0;
      else if (aggro) {
        a.heading = Math.atan2(px - a.x, pz - a.z);
        speed = d > 8 ? 2.1 : 5.6; // closes ground, then charges
        if (Math.random() < dt * 0.25) audio.growl();
        if (d < 2.0 && a.atkCd <= 0) { a.atkCd = 1.5; hurt(20, 'bear'); audio.growl(); }
      } else {
        // heavy wander around its territory; backs off from firelight
        if (playerSafe && d < 12) { a.heading = Math.atan2(a.x - px, a.z - pz); speed = 2.5; }
        else {
          if (a.t > 5) { a.t = 0; a.heading = Math.atan2(a.hx - a.x, a.hz - a.z) + (rng() - 0.5) * 2; }
          speed = 0.8;
        }
      }
    } else if (a.type === 'wolf') {
      const hunting = nightNumber() >= 2;
      const wantsYou = !playerSafe && (hunting && d < 26 || a.rageT > 0);
      if (a.staggerT > 0) speed = 0;
      else if (playerSafe && d < 9) { a.heading = Math.atan2(a.x - px, a.z - pz); speed = 4.5; }
      else if (wantsYou) {
        // circles in, then commits
        const toPlayer = Math.atan2(px - a.x, pz - a.z);
        a.heading = d > 6 ? toPlayer + Math.sin(a.t * 0.8) * 0.5 : toPlayer;
        speed = 4.8;
        if (d < 1.7 && a.atkCd <= 0) { a.atkCd = 1.2; hurt(12, 'wolf'); audio.squeak(true); }
      } else {
        if (d < 7 && !hunting) { a.heading = Math.atan2(a.x - px, a.z - pz); speed = 3.5; } // shy by day
        else { if (a.t > 4) { a.t = 0; a.heading = rng() * Math.PI * 2; } speed = 1.1; }
      }
    } else if (a.type === 'rabbit') {
      if (d < 5) a.alarm += dt; else if (d > 7) a.alarm = 0;
      if (a.alarm > 0.4 && a.state !== 'flee') { a.state = 'flee'; a.fleeT = 0; }
      if (a.state === 'flee') {
        a.fleeT += dt;
        a.heading = Math.atan2(a.x - px, a.z - pz);
        speed = (a.fleeT % 2.1) < 1.2 ? 5.5 : 0;   // flees in bursts, pauses winded
        if (d > 13) { a.state = 'idle'; a.alarm = 0; }
      } else {
        if (a.t > 3) { a.t = 0; a.heading = rng() * Math.PI * 2; }
        speed = (a.t % 3) < 0.8 ? 1.2 : 0;
      }
    } else if (a.type === 'bird') {
      if (d < (state.moving ? 4.5 : 2.0)) a.alarm += dt; else a.alarm = Math.max(0, a.alarm - dt);
      if (a.alarm > 0.7 && a.state !== 'fly') { a.state = 'fly'; a.t = 0; a.heading = Math.atan2(a.x - px, a.z - pz); }
      if (a.state === 'fly') {
        speed = 6.5;
        a.flyY = Math.min(a.flyY + dt * 3.5, 10);
        if (a.t > 3.5) { // lands somewhere far off
          const p = scatterPos();
          a.x = p.x; a.z = p.z; a.flyY = 0; a.state = 'idle'; a.t = 0; a.alarm = 0;
        }
      } else {
        if (a.t > 2.5) { a.t = 0; a.heading = rng() * Math.PI * 2; }
        speed = (a.t % 2.5) < 0.4 ? 0.8 : 0;
        a.g.children[1].position.y = 0.23 - (Math.sin(a.t * 5) > 0.6 ? 0.09 : 0); // pecking
      }
    } else { // spider — ambient creep, scuttles away from you
      if (d < 2.5) { a.heading = Math.atan2(a.x - px, a.z - pz); speed = 2.2; }
      else if (a.t > 2) { a.t = 0; a.heading = rng() * Math.PI * 2; }
      else speed = 0.35;
    }
    if (speed) {
      const nx = a.x + Math.sin(a.heading) * speed * dt;
      const nz = a.z + Math.cos(a.heading) * speed * dt;
      if (a.state === 'fly' || !inWater(nx, nz)) {
        a.x = clamp(nx, -WORLD, WORLD);
        a.z = clamp(nz, -WORLD, WORLD);
      } else a.heading += Math.PI / 2; // turned by the water's edge
      a.g.rotation.y = a.heading;
    }
    let y = groundY(a.x, a.z) + a.flyY;
    if (a.type === 'rabbit' && speed > 0 && !a.isFox) y += Math.abs(Math.sin(a.t * 11)) * 0.22; // hopping
    a.g.position.set(a.x, y, a.z);
    // the fox model switches between its real idle and run animations
    if (a.isFox && a.actRun) {
      const running = speed > 0.4;
      if (running && !a.wasRunning) { a.actIdle.stop(); a.actRun.play(); a.wasRunning = true; }
      else if (!running && a.wasRunning) { a.actRun.stop(); a.actIdle.play(); a.wasRunning = false; }
    }
    if (a.type === 'snake') {
      const segs = a.g.userData.segs;
      for (let i = 1; i < segs.length; i++)
        segs[i].position.x = Math.sin(now * 0.006 + i * 1.3) * 0.05 * i;
    }
  }
}

/* birds crossing the sky in a loose flock (days 1-4; after that the birds leave) */
const flock = (() => {
  const g = new THREE.Group();
  const birds = [];
  const m = new THREE.MeshBasicMaterial({ color: 0x2a2d33, side: THREE.DoubleSide });
  const wingL = new THREE.PlaneGeometry(0.5, 0.2); wingL.rotateX(-Math.PI / 2); wingL.translate(-0.28, 0, 0);
  const wingR = new THREE.PlaneGeometry(0.5, 0.2); wingR.rotateX(-Math.PI / 2); wingR.translate(0.28, 0, 0);
  for (let i = 0; i < 7; i++) {
    const b = new THREE.Group();
    b.add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.35), m));
    const wl = new THREE.Mesh(wingL, m), wr = new THREE.Mesh(wingR, m);
    b.add(wl); b.add(wr);
    b.userData.wings = [wl, wr];
    // loose V formation
    b.position.set((i - 3) * 1.3, (i % 3) * 0.4, Math.abs(i - 3) * 1.5);
    g.add(b); birds.push(b);
  }
  g.visible = false;
  scene.add(g);
  return { g, birds, active: false, t: 0, dir: new THREE.Vector3() };
})();
function launchFlock() {
  flock.active = true;
  flock.t = 0;
  const a = rng() * Math.PI * 2;
  flock.g.position.set(state.pos.x + Math.cos(a) * 110, 26 + rng() * 8, state.pos.z + Math.sin(a) * 110);
  flock.dir.set(-Math.cos(a), 0, -Math.sin(a));
  flock.g.rotation.y = Math.atan2(flock.dir.x, flock.dir.z);
  flock.g.visible = true;
}
function updateFlock(dt, now) {
  if (!flock.active) return;
  flock.t += dt;
  flock.g.position.addScaledVector(flock.dir, 9 * dt);
  for (let i = 0; i < flock.birds.length; i++) {
    const w = flock.birds[i].userData.wings;
    const f = Math.sin(now * 0.014 + i * 1.1) * 0.7;
    w[0].rotation.z = -f;
    w[1].rotation.z = f;
  }
  if (flock.t > 28) { flock.active = false; flock.g.visible = false; }
}

/* fireflies at night, near the pond and the clearing's edge */
const fireflies = (() => {
  const N = 60, base = new Float32Array(N * 3);
  const zones = [{ x: POND.x - 10, z: POND.z + 10 }, { x: -12, z: -16 }];
  for (let i = 0; i < N; i++) {
    const zn = zones[i % 2];
    const x = zn.x + (rng() * 2 - 1) * 9, z = zn.z + (rng() * 2 - 1) * 9;
    base[i * 3] = x;
    base[i * 3 + 1] = terrainHeight(x, z) + 0.6 + rng() * 1.2;
    base[i * 3 + 2] = z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3));
  const m = new THREE.PointsMaterial({ color: 0xd8e07a, size: 2.0, sizeAttenuation: false, transparent: true, opacity: 0 });
  const pts = new THREE.Points(geo, m);
  pts.frustumCulled = false;
  scene.add(pts);
  return { pts, geo, base, m, N };
})();
function updateFireflies(now, dark) {
  fireflies.m.opacity = dark * 0.85;
  fireflies.pts.visible = dark > 0.05;
  if (!fireflies.pts.visible) return;
  const p = fireflies.geo.attributes.position;
  for (let i = 0; i < fireflies.N; i++) {
    p.setXYZ(i,
      fireflies.base[i * 3] + Math.sin(now * 0.0006 + i * 2.1) * 0.8,
      fireflies.base[i * 3 + 1] + Math.sin(now * 0.0009 + i * 1.3) * 0.4,
      fireflies.base[i * 3 + 2] + Math.cos(now * 0.0007 + i * 1.7) * 0.8);
  }
  p.needsUpdate = true;
}
function updateFlies(now) {
  for (const f of flyClusters) {
    if (!f.parent.visible) continue;
    const p = f.geometry.attributes.position;
    for (let i = 0; i < 6; i++) {
      const a = now * (0.004 + i * 0.0007) + i * 2.2;
      p.setXYZ(i, Math.cos(a) * 0.28, Math.sin(a * 1.7) * 0.12, Math.sin(a) * 0.28);
    }
    p.needsUpdate = true;
  }
}

/* ---------------- audio (all procedural WebAudio) ---------------- */
const audio = (() => {
  let ctx = null, master, windGain, windFilter, droneOsc, droneGain, silenceUntil = 0, stormy = false, nighty = false;
  let rsGain = null;   // the radio's broken-static channel
  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);

    // wind: looped noise through lowpass
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass'; windFilter.frequency.value = 300; windFilter.Q.value = 0.6;
    windGain = ctx.createGain(); windGain.gain.value = 0.062;
    src.connect(windFilter).connect(windGain).connect(master);
    src.start();
    // slow LFO on wind volume
    const lfo = ctx.createOscillator(), lfoG = ctx.createGain();
    lfo.frequency.value = 0.07; lfoG.gain.value = 0.02;
    lfo.connect(lfoG).connect(windGain.gain);
    lfo.start();

    // low dread drone, gain driven by sanity
    droneOsc = ctx.createOscillator();
    droneOsc.type = 'sine'; droneOsc.frequency.value = 52;
    droneGain = ctx.createGain(); droneGain.gain.value = 0;
    droneOsc.connect(droneGain).connect(master);
    droneOsc.start();
  }
  function outTo(pan) { // route a sound to one side of the head, or straight ahead
    if (!pan || !ctx.createStereoPanner) return master;
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    p.connect(master);
    return p;
  }
  function noiseBurst(dur, freq, q, gain, delay = 0, pan = 0) {
    if (!ctx) return;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(f).connect(g).connect(outTo(pan));
    src.start(ctx.currentTime + delay);
  }
  // a soft pitched thump — the weight of a footfall rather than its texture
  function thud(f0, dur, gain, delay = 0, pan = 0) {
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(28, f0 * 0.5), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0004, t0 + dur);
    o.connect(g).connect(outTo(pan));
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }
  return {
    init,
    tick() {
      if (!ctx) return;
      const windBase = stormy ? 0.17 : 0.062;
      const filterBase = stormy ? 620 : 300;
      windFilter.frequency.setTargetAtTime(filterBase, ctx.currentTime, 0.5);
      // a low pressure under everything after dark
      droneGain.gain.setTargetAtTime(nighty && !silenceUntil ? 0.024 : 0.0001, ctx.currentTime, 2.5);
      droneOsc.detune.setTargetAtTime(Math.sin(ctx.currentTime * 0.23) * 22, ctx.currentTime, 0.4);
      if (!silenceUntil) windGain.gain.setTargetAtTime(windBase, ctx.currentTime, 1.5);
      else if (ctx.currentTime > silenceUntil) {
        windGain.gain.setTargetAtTime(windBase, ctx.currentTime, 1.2);
        silenceUntil = 0;
      }
    },
    setStorm(v) { stormy = v; },
    setNight(v) { nighty = v; },
    creak() { // wood groaning where no wood should be
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      const t0 = ctx.currentTime;
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(88, t0);
      o.frequency.linearRampToValueAtTime(56, t0 + 0.7);
      o.frequency.linearRampToValueAtTime(70, t0 + 1.1);
      f.type = 'lowpass'; f.frequency.value = 150; f.Q.value = 3;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.15);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.2);
      o.connect(f).connect(g).connect(master);
      o.start(); o.stop(t0 + 1.3);
    },
    thunder(delay) {
      noiseBurst(1.6, 100, 0.7, 0.6, delay);
      noiseBurst(1.1, 55, 0.5, 0.55, delay + 0.18);
      noiseBurst(0.4, 220, 1, 0.3, delay + 0.05);
    },
    thunderFar(delay) { // a storm still miles out
      noiseBurst(2.2, 75, 0.5, 0.2, delay);
      noiseBurst(1.4, 120, 0.7, 0.1, delay + 0.4);
    },
    growl(pan = 0) {
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(65, ctx.currentTime);
      o.frequency.linearRampToValueAtTime(45, ctx.currentTime + 0.8);
      f.type = 'lowpass'; f.frequency.value = 220;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.11, ctx.currentTime + 0.1);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
      o.connect(f).connect(g).connect(outTo(pan));
      o.start(); o.stop(ctx.currentTime + 1);
      noiseBurst(0.5, 160, 1, 0.15, 0, pan);
    },
    howl() {
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      const t0 = ctx.currentTime;
      o.type = 'sine';
      o.frequency.setValueAtTime(320, t0);
      o.frequency.linearRampToValueAtTime(640, t0 + 0.5);
      o.frequency.setValueAtTime(640, t0 + 1.0);
      o.frequency.linearRampToValueAtTime(260, t0 + 1.9);
      f.type = 'lowpass'; f.frequency.value = 900;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.035, t0 + 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2);
      o.connect(f).connect(g).connect(master);
      o.start(); o.stop(t0 + 2.1);
    },
    thud() { noiseBurst(0.12, 180, 0.8, 0.5); noiseBurst(0.3, 70, 0.6, 0.4, 0.02); },
    heartbeat() { // your own pulse — lub-dub, low and close
      noiseBurst(0.09, 55, 0.8, 0.42);
      noiseBurst(0.07, 46, 0.9, 0.26, 0.16);
    },
    runPast() { // heavy strides pounding past, fast, quickening — louder with every step
      for (let i = 0; i < 12; i++) {
        const d = i * 0.3 - i * i * 0.004;
        const v = 0.1 + (i / 11) * 0.75;
        noiseBurst(0.07, 110 - i * 4, 0.9, v, d);
        noiseBurst(0.3, 48, 0.6, v * 0.9, d + 0.02); // the weight landing under each stride
      }
    },
    rattle() { // a hand on the knob: a slow try, a slower one, then a weary shake
      // first try — the knob turns a little and meets the bolt, dead
      noiseBurst(0.04, 900, 4, 0.09, 0);        // the grip settling
      noiseBurst(0.09, 1450, 6, 0.13, 0.3);     // the mechanism taking up its slack
      noiseBurst(0.06, 470, 3, 0.16, 0.6);      // stopped hard against the lock
      // second try, slower still, as if the first might have been a mistake
      noiseBurst(0.04, 840, 4, 0.08, 1.6);
      noiseBurst(0.1, 1380, 6, 0.12, 1.9);
      noiseBurst(0.06, 450, 3, 0.15, 2.25);
      // then the shake — loose metal knocking in the old door, unhurried
      for (let i = 0; i < 5; i++) {
        noiseBurst(0.025, 1900 + Math.random() * 700, 5, 0.09, 3.0 + i * 0.17);
        noiseBurst(0.03, 620, 2.5, 0.07, 3.03 + i * 0.17);
      }
      noiseBurst(0.06, 380, 2, 0.11, 4.0); // and the knob clunks back to rest
    },
    doorCreak() { // two seconds of dry hinges: a squeal that sticks, slips, and wanders
      if (!ctx) return;
      const t0 = ctx.currentTime;
      const bends = [[0, 310], [0.25, 425], [0.5, 360], [0.8, 520], [1.1, 465], [1.5, 645], [1.9, 560]];
      // the hinge sings in two voices — a thin squeal and its lower partner
      for (const [mult, band, q, vol] of [[1, 1250, 9, 0.045], [0.52, 640, 7, 0.026]]) {
        const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
        o.type = 'sawtooth';
        for (const [tt, ff] of bends)
          o.frequency[tt ? 'linearRampToValueAtTime' : 'setValueAtTime'](ff * mult, t0 + tt);
        f.type = 'bandpass'; f.frequency.value = band; f.Q.value = q;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(vol, t0 + 0.14);
        g.gain.setValueAtTime(vol, t0 + 0.6);          // it catches —
        g.gain.linearRampToValueAtTime(vol * 0.2, t0 + 0.7);
        g.gain.linearRampToValueAtTime(vol, t0 + 0.85);  // — and slips on
        g.gain.setValueAtTime(vol * 0.9, t0 + 1.35);     // catches again —
        g.gain.linearRampToValueAtTime(vol * 0.2, t0 + 1.45);
        g.gain.linearRampToValueAtTime(vol * 0.9, t0 + 1.6);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.05);
        o.connect(f).connect(g).connect(master);
        o.start(t0); o.stop(t0 + 2.1);
      }
      // the frame takes the door's weight: a low wooden groan underneath
      const o3 = ctx.createOscillator(), g3 = ctx.createGain(), f3 = ctx.createBiquadFilter();
      o3.type = 'triangle';
      o3.frequency.setValueAtTime(74, t0);
      o3.frequency.linearRampToValueAtTime(52, t0 + 1.8);
      f3.type = 'lowpass'; f3.frequency.value = 160;
      g3.gain.setValueAtTime(0.0001, t0);
      g3.gain.exponentialRampToValueAtTime(0.05, t0 + 0.3);
      g3.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.95);
      o3.connect(f3).connect(g3).connect(master);
      o3.start(t0); o3.stop(t0 + 2);
      noiseBurst(0.08, 150, 1, 0.16, 1.95); // and it settles, open, against the wall
    },
    bang() { // one furious slam against the logs
      noiseBurst(0.05, 320, 1.2, 0.85);
      noiseBurst(0.45, 72, 0.5, 0.9, 0.01);
      noiseBurst(0.9, 44, 0.4, 0.6, 0.06);
    },
    shriek() { // close, layered and wrong — three voices tearing downward at once
      if (!ctx) return;
      const t0 = ctx.currentTime;
      for (const [f0, f1, det] of [[880, 140, 0], [660, 110, 18], [1240, 200, -25]]) {
        const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
        o.type = 'sawtooth';
        o.detune.value = det;
        o.frequency.setValueAtTime(f0 * (0.9 + Math.random() * 0.2), t0);
        o.frequency.exponentialRampToValueAtTime(f1, t0 + 1.1);
        f.type = 'bandpass'; f.Q.value = 2.5;
        f.frequency.setValueAtTime(1400, t0);
        f.frequency.exponentialRampToValueAtTime(300, t0 + 1.2);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.06);
        g.gain.setValueAtTime(0.09, t0 + 0.5);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.3);
        o.connect(f).connect(g).connect(master);
        o.start(t0); o.stop(t0 + 1.4);
      }
      noiseBurst(0.7, 2400, 1.5, 0.22);     // a breathy rasp riding on top
      noiseBurst(1.2, 90, 0.8, 0.5, 0.15);  // and a chest-deep thud underneath
    },
    scream() { // faint, far away, wrong
      if (!ctx) return;
      const t0 = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(620, t0);
      o.frequency.linearRampToValueAtTime(980, t0 + 0.35);
      o.frequency.linearRampToValueAtTime(500, t0 + 1.1);
      o.frequency.linearRampToValueAtTime(230, t0 + 1.7);
      f.type = 'bandpass'; f.frequency.value = 850; f.Q.value = 2;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.026, t0 + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.8);
      const dly = ctx.createDelay(); dly.delayTime.value = 0.5;
      const fb = ctx.createGain(); fb.gain.value = 0.45;
      o.connect(f).connect(g).connect(master);
      g.connect(dly); dly.connect(fb).connect(dly); dly.connect(master);
      o.start(); o.stop(t0 + 1.9);
    },
    knock(pan = 0) { // three deliberate knocks on wood, somewhere out there
      for (let i = 0; i < 3; i++) noiseBurst(0.06, 320, 2.5, 0.3, i * 0.45, pan);
    },
    crack(pan = 0) { noiseBurst(0.09, 1900 + Math.random() * 900, 4, 0.35, 0, pan); noiseBurst(0.05, 3000, 6, 0.18, 0.06, pan); },
    rustle(pan = 0) { noiseBurst(0.25, 700, 1.2, 0.12, 0, pan); noiseBurst(0.15, 1100, 1.5, 0.07, 0.1, pan); },
    splash() { noiseBurst(0.15, 900, 1.5, 0.15); noiseBurst(0.1, 1600, 2, 0.08, 0.05); },
    hiss() { noiseBurst(0.35, 4200, 1.2, 0.06); },
    step(wet) {
      if (wet) {
        // boot into shallow water: the body of the slosh, then spray falling back
        const f = 480 + Math.random() * 240;
        thud(90 + Math.random() * 20, 0.07, 0.09);
        noiseBurst(0.1, f, 0.9, 0.15);
        noiseBurst(0.13, f * 2.1, 1.3, 0.06, 0.045);
        noiseBurst(0.05, 2400 + Math.random() * 900, 2.5, 0.025, 0.08 + Math.random() * 0.04);
      } else {
        // heel strike lands as weight, then the sole settles into the litter as
        // a couple of distinct grains — never the same step twice
        thud(66 + Math.random() * 28, 0.08, 0.1);
        const base = 700 + Math.random() * 600;
        noiseBurst(0.035, base, 1.6, 0.05, 0.004);
        noiseBurst(0.03, base * (1.5 + Math.random() * 0.5), 2, 0.032, 0.02 + Math.random() * 0.02);
        if (Math.random() < 0.3) // a dry twig or leaf now and then
          noiseBurst(0.02, 2000 + Math.random() * 1400, 3, 0.018, 0.035 + Math.random() * 0.03);
      }
    },
    stepEcho(pan = 0) { // a stride heavier than yours, half a beat behind it
      noiseBurst(0.06, 520 + Math.random() * 260, 1.1, 0.05, 0, pan);
      noiseBurst(0.09, 95, 0.7, 0.07, 0.015, pan);
    },
    stridesFar(p1, p2) { // long low strides sweeping across, some way off
      for (let i = 0; i < 6; i++)
        noiseBurst(0.07, 75 + Math.random() * 20, 0.8, 0.15 + i * 0.012, i * 0.21, p1 + (p2 - p1) * (i / 5));
    },
    clank() { noiseBurst(0.07, 1300, 3, 0.3); noiseBurst(0.14, 480, 2, 0.25, 0.06); noiseBurst(0.05, 2400, 4, 0.12, 0.02); },
    hum() { // the generator holds — a low steady thrum from here on
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      o.type = 'sawtooth'; o.frequency.value = 54;
      f.type = 'lowpass'; f.frequency.value = 130;
      g.gain.value = 0.016;
      const lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = 8; lg.gain.value = 0.004;
      lfo.connect(lg).connect(g.gain);
      o.connect(f).connect(g).connect(master);
      o.start(); lfo.start();
    },
    radioFX() { // static, then a carrier, then three answering beeps
      if (!ctx) return;
      noiseBurst(1.4, 2000, 0.4, 0.22);
      noiseBurst(0.8, 1200, 0.6, 0.15, 1.2);
      const t0 = ctx.currentTime + 1.6;
      for (let i = 0; i < 3; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, t0 + i * 0.35);
        g.gain.linearRampToValueAtTime(0.05, t0 + i * 0.35 + 0.04);
        g.gain.linearRampToValueAtTime(0.0001, t0 + i * 0.35 + 0.22);
        o.connect(g).connect(master);
        o.start(t0 + i * 0.35); o.stop(t0 + i * 0.35 + 0.25);
      }
    },
    squeak(low) {
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(low ? 300 : 900, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(low ? 120 : 480, ctx.currentTime + 0.18);
      g.gain.setValueAtTime(0.055, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
      o.connect(g).connect(master);
      o.start(); o.stop(ctx.currentTime + 0.25);
    },
    chirp() {
      if (!ctx || silenceUntil) return; // the woods are quiet right now
      const t0 = ctx.currentTime;
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        const f = 2200 + Math.random() * 1400;
        o.frequency.setValueAtTime(f, t0 + i * 0.13);
        o.frequency.linearRampToValueAtTime(f * 1.25, t0 + i * 0.13 + 0.06);
        g.gain.setValueAtTime(0.0001, t0 + i * 0.13);
        g.gain.linearRampToValueAtTime(0.011, t0 + i * 0.13 + 0.02);
        g.gain.linearRampToValueAtTime(0.0001, t0 + i * 0.13 + 0.11);
        o.connect(g).connect(master);
        o.start(t0 + i * 0.13); o.stop(t0 + i * 0.13 + 0.14);
      }
    },
    call() {
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      const vib = ctx.createOscillator(), vibG = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(340, ctx.currentTime);
      o.frequency.linearRampToValueAtTime(255, ctx.currentTime + 1.6);
      vib.frequency.value = 6.5; vibG.gain.value = 9;
      vib.connect(vibG).connect(o.frequency);
      f.type = 'lowpass'; f.frequency.value = 520;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.9);
      const dly = ctx.createDelay(); dly.delayTime.value = 0.4;
      const fb = ctx.createGain(); fb.gain.value = 0.35;
      o.connect(f).connect(g).connect(master);
      g.connect(dly); dly.connect(fb).connect(dly); dly.connect(master);
      o.start(); vib.start();
      o.stop(ctx.currentTime + 2); vib.stop(ctx.currentTime + 2);
    },
    silence() { // the woods go quiet — free horror beat
      if (!ctx) return;
      windGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.15);
      silenceUntil = ctx.currentTime + 7; // and they stay quiet a little too long
    },
    stinger() { // a low thud under the worst moments
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(70, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(38, ctx.currentTime + 0.7);
      g.gain.setValueAtTime(0.14, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
      o.connect(g).connect(master);
      o.start(); o.stop(ctx.currentTime + 1);
    },
    blip() { // pickup / UI
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = 660;
      g.gain.setValueAtTime(0.03, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.07);
      o.connect(g).connect(master);
      o.start(); o.stop(ctx.currentTime + 0.08);
    },
    fireCrackle() { noiseBurst(0.04, 2600, 5, 0.05); },
    typeKey() { // one quiet typewriter strike under the objective line
      noiseBurst(0.012, 2300 + Math.random() * 1400, 4, 0.02);
      noiseBurst(0.008, 900, 2, 0.008, 0.004);
    },
    rung() { // a boot finding the next rung, a hand slapping the stringer
      noiseBurst(0.045, 420 + Math.random() * 180, 1.4, 0.14);
      noiseBurst(0.03, 1100, 2, 0.05, 0.015);
    },
    scratch() { // claws through fabric and skin — three fast rips and the weight behind them
      for (let i = 0; i < 3; i++) {
        noiseBurst(0.09, 2400 - i * 300, 2.2, 0.38, i * 0.07);
        noiseBurst(0.12, 720 - i * 110, 1.2, 0.28, i * 0.07 + 0.02);
      }
      noiseBurst(0.3, 90, 0.8, 0.5, 0.05);
    },
    chaseStep() { // something heavy landing right behind you, brush tearing
      noiseBurst(0.08, 85 + Math.random() * 20, 0.8, 0.5);
      noiseBurst(0.22, 48, 0.6, 0.45, 0.02);
      noiseBurst(0.12, 750 + Math.random() * 300, 1, 0.13, 0.03);
    },
    ratchet() { // three seconds of wrench work: tight clicking runs, torque, the part seating
      if (!ctx) return;
      for (let pass = 0; pass < 3; pass++) {
        const t0 = pass * 0.92;
        for (let i = 0; i < 8; i++) // the ratchet head clicking over
          noiseBurst(0.014, 2800 + i * 90, 5, 0.11, t0 + i * 0.052);
        noiseBurst(0.16, 260, 1.2, 0.1, t0 + 0.5); // the handle taking the strain
        noiseBurst(0.05, 1500, 3, 0.14, t0 + 0.68); // and the socket re-seating
      }
      noiseBurst(0.07, 1200, 3, 0.28, 2.78); // the last part knocked home
      noiseBurst(0.12, 480, 2, 0.22, 2.84);
    },
    radioStatic(g2) { // the set gutters and spits — never a clean signal
      if (!ctx) return;
      if (!rsGain) {
        const len2 = ctx.sampleRate * 2;
        const b = ctx.createBuffer(1, len2, ctx.sampleRate);
        const dd = b.getChannelData(0);
        for (let i = 0; i < len2; i++) dd[i] = Math.random() * 2 - 1;
        const s = ctx.createBufferSource();
        s.buffer = b; s.loop = true;
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = 0.8;
        rsGain = ctx.createGain(); rsGain.gain.value = 0;
        s.connect(f).connect(rsGain).connect(master);
        s.start();
      }
      // broken: the carrier cuts in and out instead of holding
      const flick = Math.sin(ctx.currentTime * 13) * Math.sin(ctx.currentTime * 4.7);
      rsGain.gain.setTargetAtTime(g2 * (0.35 + 0.65 * Math.abs(flick)), ctx.currentTime, 0.08);
      if (g2 > 0.004 && Math.random() < 0.025) // and pops when something inside arcs
        noiseBurst(0.04, 700 + Math.random() * 2200, 3, g2 * 5);
    },
  };
})();

/* ---------------- inventory / meters ---------------- */
function give(items) {
  for (const k in items) {
    if (!state.inv[k]) state.invOrder.push(k);
    state.inv[k] = (state.inv[k] || 0) + items[k];
  }
  updateInvHUD();
}
/* the slow red rim of the screen after a hit — it fades as your ears stop ringing */
const bloodEl = (() => {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:6;opacity:0;' +
    'background:radial-gradient(ellipse at center, rgba(0,0,0,0) 52%, rgba(120,8,4,.55) 80%, rgba(88,0,0,.92) 100%)';
  document.body.appendChild(el);
  return el;
})();
let bloodFade = 0;
function hurt(dmg, src) {
  if (state.dead || state.ended) return;
  state.health = clamp(state.health - dmg, 0, 100);
  const h = $('hurt');
  h.style.opacity = 0.9;
  setTimeout(() => { h.style.opacity = 0; }, 180);
  // the view rattles with the blow, and the edges bloom red
  state.shakeT = Math.max(state.shakeT, dmg >= 15 ? 0.9 : 0.35);
  bloodFade = Math.max(bloodFade, dmg >= 15 ? 1.0 : 0.5);
  audio.thud();
  drainSanity(2);
  if (state.health <= 0) die();
}
function die() {
  if (state.dead) return;
  state.dead = true;
  closeOverlays();
  $('prompt').innerHTML = '';
  audio.silence();
  $('death-text').innerHTML = `The forest took you on night ${nightNumber()}.<br>It was patient. It is still patient.`;
  $('death').hidden = false;
  requestAnimationFrame(() => $('death').classList.add('shown'));
}
function take(items) {
  for (const k in items) {
    state.inv[k] -= items[k];
    if (state.inv[k] <= 0) {
      delete state.inv[k];
      const i = state.invOrder.indexOf(k);
      if (i >= 0) state.invOrder.splice(i, 1);
      if (state.held === k) { state.held = null; rebuildHeld(); }
    }
  }
  updateInvHUD();
}
function has(items) {
  for (const k in items) if ((state.inv[k] || 0) < items[k]) return false;
  return true;
}
function drainSanity(n) { /* dread was removed from the game — kept as a no-op hook */ }

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.classList.add('fading'), 2600);
  setTimeout(() => el.remove(), 3800);
}
/* little drawn icons for every item, generated once on a canvas */
const ICON_CACHE = {};
function iconURL(name) {
  if (ICON_CACHE[name]) return ICON_CACHE[name];
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.lineCap = 'round';
  const line = (x1, y1, x2, y2, w, col) => { g.strokeStyle = col || '#7a5a32'; g.lineWidth = w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
  const blob = (x, y, rx, ry, col) => { g.fillStyle = col; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, 7); g.fill(); };
  const tri = (pts, col) => { g.fillStyle = col; g.beginPath(); g.moveTo(pts[0], pts[1]); g.lineTo(pts[2], pts[3]); g.lineTo(pts[4], pts[5]); g.fill(); };
  switch (name) {
    case 'Small Stick': line(9, 24, 23, 9, 3); break;
    case 'Stick': line(7, 25, 25, 7, 4.5); break;
    case 'Branch': line(6, 26, 26, 6, 6, '#5f4222'); line(16, 16, 25, 19, 3, '#5f4222'); break;
    case 'Pebble': blob(16, 20, 6, 4.5, '#9a9a9a'); blob(14, 18, 2, 1.5, '#b0b0b0'); break;
    case 'Stone': blob(16, 18, 9, 7, '#767676'); blob(13, 15, 3.5, 2.5, '#8d8d8d'); break;
    case 'Mud': blob(16, 20, 10, 6, '#4c3b26'); blob(12, 17, 4, 2.5, '#5d4a32'); break;
    case 'Leaves': blob(11, 13, 6, 3.5, '#4a7a34'); blob(21, 15, 6, 3.5, '#3f6a2c'); blob(16, 22, 6, 3.5, '#568a3c'); break;
    case 'Berries': blob(12, 14, 3.5, 3.5, '#8a2f47'); blob(20, 13, 3.5, 3.5, '#7a2740'); blob(16, 20, 3.5, 3.5, '#96334e'); blob(22, 21, 3, 3, '#8a2f47'); break;
    case 'Grubs': line(9, 20, 15, 14, 4, '#c9b98a'); line(17, 22, 23, 16, 4, '#bfae7e'); break;
    case 'Rations': g.fillStyle = '#8a9198'; g.fillRect(8, 10, 16, 14); g.fillStyle = '#b8873d'; g.fillRect(8, 15, 16, 4); break;
    case 'Key':
      g.strokeStyle = '#9c7a4a'; g.lineWidth = 3;
      g.beginPath(); g.arc(11, 11, 5, 0, 7); g.stroke();
      line(14, 14, 25, 25, 3, '#9c7a4a');
      line(22, 22, 25, 19, 2.5, '#9c7a4a');
      line(25, 25, 28, 22, 2.5, '#9c7a4a');
      break;
    case 'Flashlight':
      g.save(); g.translate(15, 17); g.rotate(-Math.PI / 4);
      // the beam
      g.fillStyle = 'rgba(255,236,160,.5)';
      g.beginPath(); g.moveTo(10, -4); g.lineTo(21, -9); g.lineTo(21, 9); g.lineTo(10, 4); g.closePath(); g.fill();
      // barrel with grip rings
      g.fillStyle = '#4c545e'; g.fillRect(-11, -3.5, 16, 7);
      g.fillStyle = '#343a42'; g.fillRect(-9, -3.5, 2, 7); g.fillRect(-5, -3.5, 2, 7);
      // flared head and lens
      g.fillStyle = '#3a3f46'; g.fillRect(5, -5.5, 5, 11);
      g.fillStyle = '#ffec9e'; g.fillRect(9.4, -4.5, 1.6, 9);
      // tail cap and switch
      g.fillStyle = '#343a42'; g.fillRect(-12.5, -3, 2, 6);
      g.fillStyle = '#c8412f'; g.fillRect(0, -5, 3, 2);
      g.restore();
      break;
    case 'Battery':
      g.fillStyle = '#23262b'; g.fillRect(6, 12, 20, 13);          // the case
      g.fillStyle = '#b8a23c'; g.fillRect(6, 16, 20, 4);           // label stripe
      g.fillStyle = '#8a2a22'; g.fillRect(9, 9, 4, 4);             // + terminal
      g.fillStyle = '#3a3f46'; g.fillRect(19, 9, 4, 4);            // - terminal
      break;
    case 'Spark Plug':
      g.save(); g.translate(16, 16); g.rotate(0.6);
      g.fillStyle = '#e0dcd0'; g.fillRect(-3, -12, 6, 10);         // ceramic
      g.fillStyle = '#8a8f94'; g.fillRect(-5, -2, 10, 5);          // hex
      g.fillStyle = '#8a5a34'; g.fillRect(-2.5, 3, 5, 6);          // thread
      g.fillStyle = '#3a3f46'; g.fillRect(-1, 9, 2, 3);            // electrode
      g.restore();
      break;
    case 'Drive Belt':
      g.strokeStyle = '#2f2b28'; g.lineWidth = 4;
      g.beginPath(); g.ellipse(16, 17, 10, 7, 0.4, 0, 7); g.stroke();
      g.strokeStyle = '#4a443e'; g.lineWidth = 1.5;
      g.beginPath(); g.ellipse(16, 17, 10, 7, 0.4, 0, 7); g.stroke();
      break;
    case 'Plank':
      g.save(); g.translate(16, 16); g.rotate(-0.6);
      g.fillStyle = '#8a6a42'; g.fillRect(-13, -3.5, 26, 7);       // the board
      g.strokeStyle = '#6e5232'; g.lineWidth = 1;                   // grain
      for (const yy of [-1.5, 1]) { g.beginPath(); g.moveTo(-12, yy); g.lineTo(12, yy + 0.5); g.stroke(); }
      g.fillStyle = '#3a3f46'; g.fillRect(-11, -1, 2, 2); g.fillRect(9, -1, 2, 2); // old nails
      g.restore();
      break;
    default: blob(16, 16, 8, 8, ITEM_COLORS[name] || '#888888'); break;
  }
  return ICON_CACHE[name] = c.toDataURL();
}
function itemSwatch(k) {
  return `<img class="icon" src="${iconURL(k)}" alt="${k}">`;
}
function updateInvHUD() {
  const bar = $('hotbar');
  bar.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const k = state.invOrder[i];
    const slot = document.createElement('div');
    slot.className = 'slot' + (k ? '' : ' empty') + (k && k === state.held ? ' sel' : '');
    slot.innerHTML = `<span class="num">${i + 1}</span>`;
    if (k) {
      slot.title = k + (ITEM_HINTS[k] ? ' — ' + ITEM_HINTS[k] : '');
      slot.innerHTML += itemSwatch(k) + `<span class="cnt">${state.inv[k]}</span>`;
      slot.onclick = e => { // click a slot to take the item in hand (same as its number key)
        e.stopPropagation();
        state.held = state.held === k ? null : k;
        rebuildHeld();
        updateInvHUD();
        audio.blip();
      };
    }
    bar.appendChild(slot);
  }
  if (state.invOrder.length > 9) {
    const more = document.createElement('div');
    more.className = 'slot more';
    more.title = 'Press I for the full inventory';
    more.innerHTML = `<span>+${state.invOrder.length - 9}<br>(I)</span>`;
    bar.appendChild(more);
  }
  if (state.overlayOpen === 'inv') renderInvPanel();
}
function renderInvPanel() {
  const grid = $('inv-grid');
  grid.innerHTML = '';
  if (!state.invOrder.length && !state.notesRead.length) {
    grid.innerHTML = '<div style="opacity:.6;font-size:12px">Empty — everything you pick up will appear here.</div>';
    return;
  }
  for (const k of state.invOrder) {
    const d = document.createElement('div');
    d.className = 'inv-item' + (k === state.held ? ' sel' : '');
    const hint = ITEM_HINTS[k] || '';
    d.innerHTML = itemSwatch(k) + `<span>${k} ×${state.inv[k]}</span><em>${hint}</em>`;
    d.onclick = () => { // click to hold it in your hand
      state.held = state.held === k ? null : k;
      rebuildHeld();
      updateInvHUD();
      renderInvPanel();
    };
    grid.appendChild(d);
  }
  if (state.notesRead.length) {
    const hdr = document.createElement('div');
    hdr.style.cssText = 'margin:14px 0 4px;font-size:11px;letter-spacing:2px;opacity:.7;text-transform:uppercase;width:100%';
    hdr.textContent = 'Notes';
    grid.appendChild(hdr);
    let diaryN = 0;
    for (const n of state.notesRead) {
      const d = document.createElement('div');
      d.className = 'inv-item';
      const label = n.title === 'My diary' ? `My diary — entry ${++diaryN}` : n.title;
      d.innerHTML = `<i style="display:inline-block;width:18px;height:18px;background:#d8d2bd;border:1px solid #8a8264;flex:none"></i>` +
        `<span>${label}</span><em>read again</em>`;
      d.onclick = () => { closeOverlays(); openNote(n); };
      grid.appendChild(d);
    }
  }
}

/* ---------------- notes UI ---------------- */
function openNote(note) {
  if (!state.notesRead.includes(note)) state.notesRead.push(note); // kept — re-read from the inventory
  $('note-title').textContent = note.title;
  $('note-body').textContent = note.body;
  const img = $('note-img');
  if (note.img) { img.src = note.img; img.hidden = false; }
  else img.hidden = true;
  $('note-overlay').hidden = false;
  state.overlayOpen = 'note';
}
function closeOverlays() {
  $('note-overlay').hidden = true;
  $('help').hidden = true;
  $('inv-panel').hidden = true;
  state.overlayOpen = null;
}

/* generic held item — Minecraft-style view model, bottom right of the screen */
const heldGroup = new THREE.Group();
heldGroup.position.set(0.36, -0.34, -0.58);
heldGroup.rotation.set(-0.2, 0.25, 0.1);
camera.add(heldGroup);
/* the flashlight beam — lives on the camera, lit only while the torch is in hand */
const torchLight = new THREE.SpotLight(0xffe9b0, 0, 30, 0.62, 0.55, 1.1);
torchLight.position.set(0.3, -0.25, 0);
camera.add(torchLight);
torchLight.target.position.set(0, -0.12, -6);
camera.add(torchLight.target);
function rebuildHeld() {
  while (heldGroup.children.length) heldGroup.remove(heldGroup.children[0]);
  const name = state.held;
  if (!name) return;
  if (name === 'Flashlight') {
    // proper torch in the hand: barrel, grip rings, flared head, glowing lens
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.036, 0.2, 10), mat(0x4c545e, { flatShading: false, shininess: 40 }));
    barrel.rotation.x = Math.PI / 2;
    heldGroup.add(barrel);
    for (const dz of [0.02, 0.06]) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.015, 10), mat(0x343a42, { flatShading: false }));
      ring.rotation.x = Math.PI / 2;
      ring.position.z = dz;
      heldGroup.add(ring);
    }
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.036, 0.06, 10), mat(0x3a3f46, { flatShading: false, shininess: 40 }));
    head.rotation.x = Math.PI / 2;
    head.position.z = -0.12;
    heldGroup.add(head);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.045, 10), new THREE.MeshBasicMaterial({ color: 0xffec9e }));
    lens.position.z = -0.151;
    lens.rotation.y = Math.PI; // faces away from the player, down the beam
    heldGroup.add(lens);
    return;
  }
  // a small swatch-coloured lump of whatever it is, held in the hand
  const c = new THREE.Color(ITEM_COLORS[name] || '#888888');
  const lump = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), mat(c.getHex()));
  lump.scale.set(1.2, 0.9, 1.1);
  heldGroup.add(lump);
}

/* collision against solid walls (the cabin and the radio shack) */
function blockedByWalls(nx, nz) {
  for (const s of wallSegs) {
    if (s.open) continue;
    const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
    const t = clamp(((nx - s.x1) * dx + (nz - s.z1) * dz) / (dx * dx + dz * dz), 0, 1);
    if (Math.hypot(nx - (s.x1 + dx * t), nz - (s.z1 + dz * t)) < 0.45) return true;
  }
  return false;
}

/* ---------------- interaction ---------------- */
let currentAction = null; // {label, key, fn}
function findAction() {
  if (state.climb) return null; // both hands on the rungs
  const px = state.pos.x, pz = state.pos.z;

  // the story comes first
  const qa = questAction(px, pz);
  if (qa) return qa;

  // nearest interactable prop (notes first, then resources)
  let best = null, bd = 3.0;
  for (const it of interactables) {
    const d = Math.hypot(px - it.pos.x, pz - it.pos.z);
    const prio = it.type === 'note' ? d - 0.8 : d;
    if (prio < bd) { bd = prio; best = it; }
  }
  if (best) {
    if (best.type === 'pickup')
      return { label: `Take ${best.label}`, key: 'E', fn: () => {
        give({ [best.data.item]: 1 });
        removeInteractable(best);
        audio.blip();
        toast(`+ ${best.data.item}`);
      } };
    if (best.type === 'note')
      return { label: best.label || 'Read the page', key: 'E', fn: () => {
        openNote(best.data.note);
        removeInteractable(best);
        if (best.data.onRead) best.data.onRead();
        drainSanity(3); // reading them costs something
      } };
    // searching takes a moment: a second of going through it, rustling all the while
    return { label: 'Search the ' + best.label, key: 'E', fn: () => {
      if (best.data.searching) return;
      best.data.searching = true;
      audio.rustle();
      setTimeout(() => { if (!state.dead && !state.ended) audio.rustle(); }, 450);
      setTimeout(() => {
        if (state.dead || state.ended) return;
        removeInteractable(best);
        if (best.data.luggage) searchLuggage(best.data);
        else if (best.data.give) {
          give(best.data.give);
          audio.blip();
          toast('+ ' + Object.entries(best.data.give).map(([k, n]) => `${k} ×${n}`).join(', '));
        }
        else toast('Nothing in there you can use.');
      }, 1000);
    } };
  }

  return null;
}

/* food left the game — health mends slowly on its own, and F is the torch */

/* ---------------- input ---------------- */
const keys = {};
addEventListener('keydown', e => {
  if (!state.running || state.ended || state.dead) return;
  const k = e.key.toLowerCase();

  if (state.overlayOpen === 'note') { closeOverlays(); return; }
  const isNum = k >= '1' && k <= '9';
  if (state.overlayOpen && k !== 'h' && k !== 'i' && k !== 'escape' && !isNum) return;

  keys[k] = true;
  // spacebar jump
  if (k === ' ') {
    e.preventDefault();
    if (!e.repeat && state.jumpY <= 0 && !state.overlayOpen && !state.climb && state.fixT <= 0 && state.stoneT <= 0) {
      state.velY = 4.8;
      state.jumpY = 0.001;
    }
  }
  // double-tap W to sprint
  if (k === 'w' && !e.repeat) {
    if (performance.now() - lastWTap < 350 && state.stamina > 1) state.sprinting = true;
    lastWTap = performance.now();
  }
  // number keys hold a hotbar item in hand
  if (isNum && !e.repeat) {
    const name = state.invOrder[+k - 1];
    if (name) {
      state.held = state.held === name ? null : name;
      rebuildHeld();
      updateInvHUD();
      if (state.overlayOpen === 'inv') renderInvPanel();
    }
    return;
  }
  if (k === 'e' && currentAction && currentAction.fn) currentAction.fn();
  if (k === 'h') { const wasOpen = state.overlayOpen === 'help'; closeOverlays(); if (!wasOpen) { $('help').hidden = false; state.overlayOpen = 'help'; } }
  if (k === 'i') { const wasOpen = state.overlayOpen === 'inv'; closeOverlays(); if (!wasOpen) { renderInvPanel(); $('inv-panel').hidden = false; state.overlayOpen = 'inv'; } }
  if (k === 'escape') closeOverlays();
  if (k === 'f') {
    if (state.held === 'Flashlight') {
      state.torchOn = !state.torchOn;
      audio.blip();
      toast(state.torchOn ? 'Flashlight on.' : 'Flashlight off.');
    } else if (has({ Flashlight: 1 })) toast('Take the flashlight in hand first (press its number).');
  }
  if (k === 't') { state.absHours += 1; toast('An hour passes…'); }
});
let lastWTap = -1000;
addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  keys[k] = false;
  if (k === 'w') state.sprinting = false;
});

/* drag look — pointer events so mouse and touch share one path (no pointer
   lock — unreliable in iframes). Only the first pointer on the canvas steers
   the camera; on touch the left thumb lives on the joystick zone instead. */
let lookId = null, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', e => {
  if (lookId !== null) return;
  lookId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', e => {
  if (e.pointerId !== lookId || !state.running || state.ended || state.dead) return;
  const sens = e.pointerType === 'touch' ? 0.006 : 0.005;
  state.yaw -= (e.clientX - lastX) * sens;
  state.pitch = clamp(state.pitch - (e.clientY - lastY) * sens, -1.35, 1.35);
  lastX = e.clientX; lastY = e.clientY;
});
const lookEnd = e => {
  if (e.pointerId !== lookId) return;
  lookId = null;
  canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', lookEnd);
canvas.addEventListener('pointercancel', lookEnd);

/* ---------------- touch controls (mobile) ---------------- */
/* left thumb: analog joystick (push past the ring to sprint); right side of
   the screen drags the camera; USE mirrors E and lights up when something is
   in reach; JUMP / EAT / BAG mirror Space / F / I. */
const IS_TOUCH = COARSE;
const joy = { x: 0, y: 0, len: 0 };

/* fullscreen + landscape, best-effort across browsers. The orientation lock
   matters even when the phone's rotation lock is on — a programmatic lock
   overrides it on Android; iOS supports neither (home-screen install instead). */
function goFullscreen() {
  try {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    const lock = () => {
      try {
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
      } catch (err) {}
    };
    const p = req && req.call(el, { navigationUI: 'hide' });
    if (p && p.then) p.then(lock).catch(() => lock()); else lock();
  } catch (err) { /* stay windowed */ }
}

if (IS_TOUCH) {
  document.documentElement.classList.add('touch');
  $('btn-fullscreen').addEventListener('click', goFullscreen);

  const zone = $('joy-zone'), base = $('joy-base'), thumb = $('joy-thumb');
  const R = 46; // max thumb travel in px
  let joyId = null, ox = 0, oy = 0;
  zone.addEventListener('pointerdown', e => {
    if (joyId !== null) return;
    joyId = e.pointerId; ox = e.clientX; oy = e.clientY;
    // the stick appears where the thumb lands
    const zr = zone.getBoundingClientRect();
    base.style.left = (ox - zr.left - base.offsetWidth / 2) + 'px';
    base.style.top = (oy - zr.top - base.offsetHeight / 2) + 'px';
    zone.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  zone.addEventListener('pointermove', e => {
    if (e.pointerId !== joyId) return;
    const dx = e.clientX - ox, dy = e.clientY - oy;
    const mag = Math.hypot(dx, dy);
    const c = mag > R ? R / mag : 1;
    thumb.style.transform = `translate(${dx * c}px, ${dy * c}px)`;
    let nx = dx * c / R, ny = dy * c / R;
    if (Math.hypot(nx, ny) < 0.18) nx = ny = 0; // deadzone
    joy.x = nx; joy.y = ny; joy.len = Math.hypot(nx, ny);
    // shove the stick well past the ring to sprint; ease back off to stop
    if (mag > R * 1.5 && ny < -0.5 && state.stamina > 1) state.sprinting = true;
    else if (mag < R * 1.1 || ny > -0.3) state.sprinting = false;
  });
  const joyEnd = e => {
    if (e.pointerId !== joyId) return;
    joyId = null; joy.x = joy.y = joy.len = 0;
    state.sprinting = false;
    base.style.left = base.style.top = ''; // drift back to its resting corner
    thumb.style.transform = '';
  };
  zone.addEventListener('pointerup', joyEnd);
  zone.addEventListener('pointercancel', joyEnd);

  // buttons re-enter through the keyboard handler so every overlay/state
  // guard behaves identically on both control schemes
  const synthKey = k => dispatchEvent(new KeyboardEvent('keydown', { key: k }));
  const bindBtn = (id, k) => $(id).addEventListener('pointerdown', e => { e.preventDefault(); synthKey(k); });
  bindBtn('btn-use', 'e');
  bindBtn('btn-jump', ' ');
  bindBtn('btn-food', 'f');
  bindBtn('btn-inv', 'i');

  document.querySelector('#start .keys').innerHTML =
    'left stick — move (push hard to sprint)<br>drag the view to look · USE — interact';
  document.querySelector('#note-overlay .close-hint').textContent = 'tap anywhere to put it down';
}

// notes say "press any key" — a click or tap anywhere counts too, but a DRAG
// must scroll the note (long ones carry a map below the fold), not put it down
{
  const ov = $('note-overlay');
  let down = null;
  ov.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
  ov.addEventListener('pointerup', e => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved < 8 && state.overlayOpen === 'note') closeOverlays();
  });
  ov.addEventListener('pointercancel', () => { down = null; });
}

/* ---------------- night event scheduling ---------------- */
function scheduleNight(n) {
  const cfg = NIGHTS[Math.min(n, 7)]; // past night 7 the woods stay at full hostility
  if (!cfg) return;
  if (cfg.storm) startStorm(10); // scripted storm night: blows through until dawn
  if (n >= 2) audio.howl();      // the wolves are awake
  state.eventQueue = [];
  const nightStartAbs = (n - 1) * 24 + NIGHT_START;
  const span = 22; // the night does not end, so neither do they
  for (let i = 0; i < cfg.sil; i++)
    state.eventQueue.push({ at: nightStartAbs + 0.5 + rng() * (span - 1), type: 'scare' });
  for (let i = 0; i < cfg.aud; i++)
    state.eventQueue.push({ at: nightStartAbs + 0.3 + rng() * (span - 0.8), type: 'aud' });
  state.eventQueue.sort((a, b) => a.at - b.at);
}
function runEvents() {
  while (state.eventQueue.length && state.absHours >= state.eventQueue[0].at) {
    const ev = state.eventQueue.shift();
    if (state.ended) return;
    if (ev.type === 'scare') triggerScare();
    else {
      const roll = rng();
      if (roll < 0.22) audio.crack();
      else if (roll < 0.44) audio.call();
      else if (roll < 0.62) audio.silence();
      else if (roll < 0.82) { audio.scream(); drainSanity(2); } // extra dread for the scream
      else audio.knock();
      drainSanity(4);
    }
  }
}

/* ---------------- day/night lighting ---------------- */
/* the palette leans cold, grey and underexposed — this forest is not a friendly one */
const skyDay = new THREE.Color(0x828e84), skyNight = new THREE.Color(0x070a0e),
      skyDusk = new THREE.Color(0x74625a);
const SKY = {
  dayTop: new THREE.Color(0x546a80), dayHor: new THREE.Color(0x929da0),
  duskTop: new THREE.Color(0x363e58), duskHor: new THREE.Color(0xb06a48),
  nightTop: new THREE.Color(0x02040a), nightHor: new THREE.Color(0x090f16),
  stormMul: new THREE.Color(0x4a5058),
};
const cloudDay = new THREE.Color(0xc8ccc8), cloudDusk = new THREE.Color(0xc08868), cloudNight = new THREE.Color(0x141922);
const fogCol = new THREE.Color(), tmpSky = new THREE.Color();
function daylight() {
  return 0; // there is no more daylight in these woods
}
const flashCol = new THREE.Color(0xd6deeb);
function updateLighting() {
  const d = daylight();
  const duskness = Math.sin(Math.min(d, 1) * Math.PI); // peaks mid sunrise/sunset

  const si = weather.intensity; // eases up as clouds build, down as they clear

  // sky dome: night -> day gradient, pulled toward orange at the transitions
  skyUniforms.topColor.value.copy(SKY.nightTop).lerp(SKY.dayTop, d).lerp(SKY.duskTop, duskness * 0.75);
  skyUniforms.horizonColor.value.copy(SKY.nightHor).lerp(SKY.dayHor, d).lerp(SKY.duskHor, duskness * 0.85);
  if (si > 0.01) {
    tmpSky.copy(skyUniforms.topColor.value).multiply(SKY.stormMul);
    skyUniforms.topColor.value.lerp(tmpSky, si);
    tmpSky.copy(skyUniforms.horizonColor.value).multiply(SKY.stormMul);
    skyUniforms.horizonColor.value.lerp(tmpSky, si);
  }
  // clouds catch the light, and darken as the weather turns
  cloudMat.color.copy(cloudNight).lerp(cloudDay, d).lerp(cloudDusk, duskness * 0.8);
  if (si > 0.01) {
    tmpSky.copy(cloudMat.color).multiply(SKY.stormMul);
    cloudMat.color.lerp(tmpSky, si);
  }

  // fog haze sits between the ground palette and the horizon color
  fogCol.copy(skyNight).lerp(skyDay, d).lerp(skyDusk, duskness * 0.35);
  fogCol.lerp(skyUniforms.horizonColor.value, 0.45);
  fogCol.lerp(skyNight, 0.35 * d * si); // heavy weather darkens the day
  if (weather.flash > 0) fogCol.lerp(flashCol, Math.min(1, weather.flash) * 0.7);
  scene.fog.color.copy(fogCol);
  scene.background.copy(fogCol);
  let density = lerp(0.047, 0.021, d) + si * (isNight() ? 0.02 : 0.014);
  if (chase) density = Math.max(density, 0.06); // the world closes in when it runs you down
  if (state.fogPulse > 0) density = Math.max(density, 0.024 + state.fogPulse * 0.04); // and sometimes it just... thickens
  scene.fog.density = density;
  sun.intensity = lerp(0.05, 0.68, d) * (1 - 0.45 * si) + weather.flash * 1.4;
  sun.color.setHSL(0.09, 0.25, lerp(0.4, 0.62, d)); // pale, drained light
  hemi.intensity = lerp(0.13, 0.62, d) * (1 - 0.35 * si) + weather.flash * 1.6;
  const a = (tod() / 24) * Math.PI * 2 - Math.PI / 2;
  // sun tracks the player so its shadow frustum always covers where you are
  sun.position.set(state.pos.x + Math.cos(a) * 80, Math.max(Math.sin(a) * 80, 6), state.pos.z + 30);
  sun.target.position.set(state.pos.x, 0, state.pos.z);

  // the stars are always out now; the moon drifts low and high but never sets
  starMat.opacity = (1 - d) * 0.9;
  skyGroup.position.set(state.pos.x, 0, state.pos.z);
  const moon = window._moon;
  // it drifts hour by hour but stays well above the treeline — it is always watching
  const ma = 1.25 + Math.sin(tod() / 24 * Math.PI * 2) * 0.3;
  moon.position.set(Math.cos(ma) * 230, Math.sin(ma) * 150 + 10, -100);
  moon.lookAt(camera.position);
  moonMat.opacity = (1 - d) * Math.min(1, Math.sin(ma) * 3);
  moonHaloMat.opacity = moonMat.opacity * 0.35 * (1 - 0.7 * weather.intensity);
  moonLight.position.set(state.pos.x + moon.position.x * 0.5, moon.position.y * 0.5, state.pos.z + moon.position.z * 0.5);
  moonLight.target.position.set(state.pos.x, 0, state.pos.z);
  moonLight.intensity = (1 - d) * 0.22 * Math.sin(ma) * (1 - 0.8 * weather.intensity);

  // the water catches whichever light rules the sky
  if (waterObj) {
    const u = waterObj.material.uniforms;
    if (d > 0.25) {
      u.sunDirection.value.copy(sun.position).sub(sun.target.position).normalize();
      u.sunColor.value.setHex(0xb8bcae).multiplyScalar(d);
    } else if (moonLight.intensity > 0.01) {
      u.sunDirection.value.copy(moonLight.position).sub(moonLight.target.position).normalize();
      u.sunColor.value.setHex(0x7d92b8);
    } else {
      u.sunColor.value.setHex(0x000000);
    }
    u.distortionScale.value = 5.5 + weather.intensity * 3.2; // storms rough the surface up further
  }
}

/* ---------------- meters / survival tick ---------------- */
let crackleT = 0;
function survivalTick(dt) {
  const perMin = dt / 60;

  // health mends slowly on its own; food (F) mends it faster
  state.health = clamp(state.health + 2 * perMin, 0, 100);
  if (state.health <= 0) { die(); return; }

  // standing in the fire burns
  if (Math.hypot(state.pos.x - FIRE.x, state.pos.z - FIRE.z) < 0.95) {
    state.fireT = (state.fireT || 0) + dt;
    if (state.fireT > 0.4) { state.fireT = 0; hurt(6, 'fire'); audio.crack(); }
  } else state.fireT = 0;

  if (nearFire()) {
    crackleT -= dt;
    if (crackleT <= 0) { audio.fireCrackle(); crackleT = 0.4 + Math.random() * 1.2; }
  }
}

/* ---------------- HUD ---------------- */
function objectiveText() {
  const dist = p => Math.round(Math.hypot(state.pos.x - p.x, state.pos.z - p.z)) + 'm';
  let txt;
  switch (state.quest) {
    case 0: txt = 'Search the luggage for the notes.'; break;
    case 1: txt = `Search the luggage for the notes — ${state.pieces}/5.`; break;
    case 2: txt = Math.hypot(state.pos.x - CABIN.x, state.pos.z - CABIN.z) <= 10
      ? 'Enter the cabin.'
      : `Follow the path to the cabin, ${compassWord(CABIN)} (${dist(CABIN)}).`; break;
    case 3: txt = 'The cabin is locked. One stone by the porch sits wrong — look under it.'; break;
    case 4: txt = 'Unlock the cabin door with the key.'; break;
    case 5: txt = 'Someone is inside the cabin. Read the letter.'; break;
    case 6: {
      // the shed is across the river now, so the walk to it crosses the bridge —
      // and trying to cross takes over the objective until the bridge is mended
      if (!bridgeGap.fixed && (onBridge(state.pos.x, state.pos.z) ||
          Math.hypot(state.pos.x - bridgeGap.x, state.pos.z - BRIDGE.z) < 4)) state.sawGap = true;
      if (state.sawGap && !bridgeGap.fixed)
        txt = has({ Plank: 1 })
          ? `Lay the plank and fix the bridge (${dist({ x: bridgeGap.x, z: BRIDGE.z })}).`
          : 'Find the missing wood plank and fix the bridge.';
      else if (state.shedMapRead)
        txt = `Follow the path to the watch tower on the great hill, ${compassWord(HILL)} (${dist(HILL)}).`;
      else
        // whether or not the bridge is behind you now, the shed still comes first
        txt = `Follow the path to the shed (${dist(SHED)}).`;
      break;
    }
    case 7: {
      const got = GEN_PARTS.filter(k => has({ [k]: 1 })).length;
      txt = got >= 3
        ? `You have everything. Fix the generator (${dist(GEN)}).`
        : `The radio is dead. Follow the power line down to the generator (${dist(GEN)}) — it needs a battery, a spark plug and a drive belt (${got}/3).`;
      break;
    }
    case 8: txt = chase ? 'RUN. Get back up the tower.' : 'Climb the tower. Turn on the radio. Call for help.'; break;
    default: txt = '…someone answered.'; break;
  }
  return txt;
}
/* the objective line types itself out, key by key */
const objTw = { key: '', txt: '', shown: 0, drawn: null };
function setObjective(txt, dt) {
  const key = txt.replace(/\(\d+m\)/g, '(#)'); // distances tick by without retyping
  if (key !== objTw.key) { objTw.key = key; objTw.shown = 0; }
  objTw.txt = txt;
  let out;
  if (objTw.shown < txt.length) {
    const before = Math.floor(objTw.shown);
    objTw.shown = Math.min(txt.length, objTw.shown + dt * 34);
    const after = Math.floor(objTw.shown);
    for (let i = before; i < after; i++) // a quiet strike as each letter lands
      if (i % 2 === 0 && txt[i] !== ' ') { audio.typeKey(); break; }
    out = txt.slice(0, after) + '▌';
  } else {
    out = txt;
  }
  if (out !== objTw.drawn) { objTw.drawn = out; $('objective').textContent = out; }
}
function updateHUD(dt) {
  $('bar-health').firstElementChild.style.width = state.health + '%';
  $('bar-stamina').firstElementChild.style.width = (state.stamina / 15 * 100) + '%';
  $('compass-dial').style.transform = `rotate(${state.yaw}rad)`;
  const t = tod();
  $('clock-time').textContent = String(Math.floor(t)).padStart(2, '0') + ':' + String(Math.floor((t % 1) * 60)).padStart(2, '0');
  setObjective(objectiveText(), dt || 0.016);

  currentAction = state.overlayOpen ? null : findAction();
  $('prompt').innerHTML = currentAction
    ? (currentAction.fn ? `<b>${currentAction.key}</b>${currentAction.label}` : currentAction.label)
    : '';
  if (IS_TOUCH) $('btn-use').classList.toggle('dim', !(currentAction && currentAction.fn));

  // the edges of the world are always a little closed in; low health closes them further
  $('vignette').style.opacity = clamp(Math.max(0.62, 1 - state.health / 35), 0, 0.95);
}

/* ---------------- ending ---------------- */
function triggerEnding() {
  state.ended = true;
  closeOverlays();
  $('prompt').innerHTML = '';
  // nothing steps out. The woods just go very, very quiet.
  audio.silence();
  audio.stinger();
  scene.fog.density = 0.06;
  setTimeout(() => { $('fade').style.opacity = 1; }, 2500);
  setTimeout(() => {
    $('ending-text').innerHTML =
      `Static. A carrier wave. Then a voice — a human voice — asking your name.<br><br>` +
      `The helicopter came at first light. From the air the forest looked small,<br>` +
      `which is a lie the air tells.<br><br>` +
      `You told them about the crash. You told them about Elliott James Pluck, and the cabin,<br>` +
      `and they wrote it down. You did not tell them everything.<br><br>` +
      `Somewhere below, at the treeline of the great hill, something stood very still<br>` +
      `and watched you leave. It can wait. It has always been good at that.`;
    $('ending').hidden = false;
    requestAnimationFrame(() => $('ending').classList.add('shown'));
  }, 8500);
}

/* ---------------- main loop ---------------- */
/* both fires burn even on the title screen — the menu backdrop is the live scene */
function animateFires(now, dt) {
  if (fireLight) {
    fireLight.intensity = 1.35 + Math.sin(now * 0.011) * 0.25 + Math.random() * 0.18;
    const ep = window._embers.geometry.attributes.position;
    for (let i = 0; i < ep.count; i++) {
      let ex = ep.getX(i) + Math.sin(now * 0.001 + i) * dt * 0.2;
      let ey = ep.getY(i) + dt * (0.5 + (i % 4) * 0.22);
      let ez = ep.getZ(i) + Math.cos(now * 0.0013 + i) * dt * 0.15;
      if (ey > 1.8) { ey = 0.25; ex = (Math.random() - 0.5) * 0.3; ez = (Math.random() - 0.5) * 0.3; }
      ep.setXYZ(i, ex, ey, ez);
    }
    ep.needsUpdate = true;
  }
  // flame tongues: born at the coals, narrowing as they climb, gone in under a second
  for (const f of window._flameJets) {
    const t = (now * 0.001 * f.speed + f.phase) % 1;
    const w = 1 - t * 0.75; // the flame narrows as it rises
    f.spr.position.set(
      f.x + Math.sin(now * 0.004 + f.jx) * 0.09 * f.scale * w,
      f.y + t * 0.95 * f.scale,
      f.z + Math.cos(now * 0.0035 + f.jx) * 0.09 * f.scale * w);
    const sc = f.scale * (0.55 * w + 0.08);
    f.spr.scale.set(sc, sc * (1.25 + t * 0.6), 1);
    f.m.opacity = Math.min(t / 0.08, 1) * (1 - t) * 0.85;
  }
  // smoke puffs: born at the flame tips, gone two feet up
  for (const p of window._smokePuffs) {
    const t = (now * 0.001 * p.speed + p.phase) % 1;
    p.spr.position.set(
      p.x + Math.sin(now * 0.001 + p.sway) * 0.06 + t * 0.18,
      p.y + t * 1.05,
      p.z + Math.cos(now * 0.0008 + p.sway) * 0.05);
    const sc = p.size * (0.5 + t * 1.4);
    p.spr.scale.set(sc, sc, 1);
    p.m.opacity = Math.min(t / 0.12, 1) * (1 - t) * 0.4;
  }
  if (window._planeFire)
    window._planeFire.light.intensity = 0.7 + Math.sin(now * 0.02) * 0.15 + Math.random() * 0.2;
}
let lastT = 0, bobT = 0, lastQuest = 0, shadowT = 9, perfAvg = 0.016;
function frame(now) {
  requestAnimationFrame(frame);
  fitViewport(); // phones resize without telling anyone — see its comment
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;
  if (!state.running) {
    // the title screen looks out from the spawn point: the fire, and the burning wreck
    camera.position.set(state.pos.x, playerGroundY(state.pos.x, state.pos.z) + 1.68, state.pos.z);
    camera.rotation.y = state.yaw;
    animateFires(now, dt);
    renderer.render(scene, camera);
    return;
  }

  if (!state.ended && !state.dead) {
    /* time */
    state.absHours += dt / SEC_PER_HOUR;
    const newNight = nightNumber(); // each 24 hours survived turns the screw
    if (newNight > state.day) {
      state.day = newNight;
      revealProps();
    }

    /* schedule tonight's events at nightfall */
    const n = nightNumber();
    if (n > 0 && n !== state.nightScheduled) {
      state.nightScheduled = n;
      scheduleNight(n);
    }
    runEvents();
    runDayGlimpses();
    // the long walks: the forest keeps you company on every transit
    if (state.quest !== lastQuest) { onQuestChange(state.quest); lastQuest = state.quest; }
    if (!chase) updateTransit(dt);
    updateBridge();
    updateCrosser(dt);
    if (state.fogPulse > 0) state.fogPulse = Math.max(0, state.fogPulse - dt * 0.09);
    if (bloodFade > 0) { // the red rim of a fresh wound, fading over a few seconds
      bloodFade = Math.max(0, bloodFade - dt * 0.25);
      bloodEl.style.opacity = Math.min(1, bloodFade).toFixed(3);
    }

    /* movement (not while climbing, wrenching, or turning stones over) */
    if (!state.overlayOpen && !state.climb && state.fixT <= 0 && state.stoneT <= 0) {
      let mx = 0, mz = 0;
      if (keys['w']) mz -= 1;
      if (keys['s']) mz += 1;
      if (keys['a']) mx -= 1;
      if (keys['d']) mx += 1;
      if (joy.len) { mx += joy.x; mz += joy.y; }
      state.moving = (mx || mz);
      if (state.moving) {
        const len = Math.hypot(mx, mz);
        if (len > 1) { mx /= len; mz /= len; }
        const eff = Math.min(1, len); // soft joystick pushes walk slower
        let speed = 4.2;
        if (state.sprinting && (keys['w'] || joy.y < -0.4) && state.stamina > 0) {
          speed = 7.2;
          state.stamina = Math.max(0, state.stamina - dt); // 15 seconds of sprint
          if (state.stamina <= 0) state.sprinting = false; // winded
        }
        if (inWater(state.pos.x, state.pos.z) && !onBridge(state.pos.x, state.pos.z)) speed *= 0.6;
        else if (nearTrail(state.pos.x, state.pos.z, 2.8)) speed *= 1.12; // the walked path is quick going
        const sy = Math.sin(state.yaw), cy = Math.cos(state.yaw);
        const nx = clamp(state.pos.x + (mx * cy + mz * sy) * speed * dt, -WORLD, WORLD);
        const nz = clamp(state.pos.z + (-mx * sy + mz * cy) * speed * dt, -WORLD, WORLD);
        // walls, trunks, boulders — and the water itself — block; test each axis so you slide
        const wet2 = (x2, z2) => inWater(x2, z2) && !onBridge(x2, z2); // the river is not an option
        if (!blockedAt(nx, state.pos.z) && !wet2(nx, state.pos.z)) state.pos.x = nx;
        if (!blockedAt(state.pos.x, nz) && !wet2(state.pos.x, nz)) state.pos.z = nz;
        bobT += dt * speed * eff * 1.9;
        // footsteps: grass rustle on land, sloshing in water
        state.stepDist += speed * eff * dt;
        if (state.stepDist > 2.3 && state.jumpY <= 0) {
          state.stepDist = 0;
          audio.step(inWater(state.pos.x, state.pos.z) && !onBridge(state.pos.x, state.pos.z));
          // and, sometimes, a second set of steps under your own
          if (transit.follower && state.playSec < transit.follower.until && Math.random() < 0.8) {
            const p = transit.follower.side * 0.45;
            setTimeout(() => { if (!state.dead && !state.ended && state.moving) audio.stepEcho(p); }, 140 + Math.random() * 110);
          }
        }
      }
    } else state.moving = false;
    if (!(state.sprinting && state.moving)) state.stamina = Math.min(15, state.stamina + dt * 3); // full again in 5s
    state.playSec += dt;

    // walking off an edge starts a fall instead of snapping to the lower ground
    // (never while on the ladder — climbing is not falling)
    const gNow = playerGroundY(state.pos.x, state.pos.z);
    if (!state.climb && state.jumpY <= 0 && state.lastGy !== null && state.lastGy - gNow > 0.7) {
      state.jumpY = state.lastGy - gNow;
      state.velY = 0;
    }
    state.lastGy = state.climb ? null : gNow;

    // jumping and falling
    if (state.jumpY > 0 || state.velY !== 0) {
      state.velY -= 13 * dt;
      state.jumpY += state.velY * dt;
      if (state.jumpY <= 0) {
        const fallSpeed = -state.velY;
        state.jumpY = 0; state.velY = 0;
        audio.step(inWater(state.pos.x, state.pos.z) && !onBridge(state.pos.x, state.pos.z)); // landing
        if (fallSpeed > 9) hurt(Math.round((fallSpeed - 9) * 4), 'fall'); // long drops cost you
      }
    }
    // splash when you wade in (the bridge keeps your feet dry)
    const wet = inWater(state.pos.x, state.pos.z) && !onBridge(state.pos.x, state.pos.z);
    if (wet && !state.wasWet) audio.splash();
    state.wasWet = wet;

    /* the cabin door easing open on its dry hinges */
    if (cabinDoor.anim) {
      const a = cabinDoor.anim;
      a.t += dt;
      const k = Math.min(1, a.t / a.dur);
      const e = 1 - Math.pow(1 - k, 2.2); // stiff at first, then giving way
      const hitch = Math.max(0, Math.sin(k * Math.PI) * 0.05 * Math.sin(k * 24)); // it catches, twice
      cabinDoor.mesh.rotation.y = a.from + (a.to - a.from) * e - hitch;
      if (k > 0.45) cabinDoor.seg.open = true;
      if (k >= 1) cabinDoor.anim = null;
    }
    /* turning the pale stone over takes both hands and three long seconds */
    if (state.stoneT > 0) {
      state.stoneT -= dt;
      if (state.stoneT <= 0) {
        state.stoneT = 0;
        give({ 'Key': 1 });
        if (state.quest < 4) state.quest = 4;
        toast('Cold earth, wood lice — and a small iron key.');
        audio.blip();
      }
    }
    /* the generator fix runs on a short clock; the chase runs on your legs */
    if (state.fixT > 0) {
      state.fixT -= dt;
      if (state.fixT <= 0) { state.fixT = 0; finishGenFix(); }
    }
    if (chase) updateChase(dt);
    // the radio: broken static up close until the generator wakes it, a carrier after
    let radioG = 0;
    if (state.onTower && state.quest >= 6 && state.quest < 9)
      radioG = (state.generatorOn ? 0.045 : 0.05) *
        clamp(1 - Math.hypot(state.pos.x - SHACK.radio.x, state.pos.z - SHACK.radio.z) / 5, 0, 1);
    audio.radioStatic(radioG);

    survivalTick(dt);
    updateWeather(dt);
    updateTotems(now);
    checkHollow();
    updateParticles(dt);
    updateAnimals(dt, now);
    updateFlock(dt, now);
    updateFlies(now);
    audio.setNight(true); // the dark is permanent — so is the pressure under it
    if (nightNumber() >= 2 && Math.random() < dt * 0.01) audio.howl();
    // trees groan in the dark
    if (Math.random() < dt * 0.014) audio.creak();
    // and sometimes, far off, something that is almost a voice
    if (Math.random() < dt * 0.005) { audio.scream(); drainSanity(2); }
    // birds still erupt out of the black canopy, early on — until there are no birds
    if (nightNumber() < 5 && !flock.active && state.absHours >= state.nextFlock) {
      launchFlock();
      state.nextFlock = state.absHours + 0.8 + rng() * 1.2;
    }
    audio.tick();
    updateHUD(dt);
  }

  /* skeletons keep moving even over the ending and death screens */
  for (const m of modelMixers) m.update(dt);

  /* camera */
  if (state.climb) {
    // three seconds of hand-over-hand up (or down) the ladder
    const c = state.climb;
    c.t = Math.min(c.dur, c.t + dt);
    const kk = c.up ? c.t / c.dur : 1 - c.t / c.dur; // 0 at the dirt, 1 at the deck
    const baseY = playerGroundY(HILL.x, HILL.z + 3.4);
    const hand = Math.sin(c.t * 7.5); // one hand, then the other
    camera.position.set(
      HILL.x + hand * 0.05,
      baseY + (TOWER.y - baseY) * kk + 1.45 + kk * 0.23 + Math.abs(hand) * 0.06,
      HILL.z + 3.75 - kk * 0.9);
    camera.rotation.y = state.yaw = 0;                       // face into the rungs
    camera.rotation.x = state.pitch = c.up ? 0.3 : -0.42;    // eyes up the ladder, or down past your boots
    camera.rotation.z = hand * 0.035;
    c.rung += dt;
    if (c.rung > 0.42) { c.rung = 0; audio.rung(); }
    if (c.t >= c.dur) finishClimb();
  } else {
  const gy = playerGroundY(state.pos.x, state.pos.z);
  const bob = state.moving ? Math.sin(bobT) * 0.065 : Math.sin(now * 0.0012) * 0.02; // idle breathing sway
  const sway = state.moving ? Math.sin(bobT * 0.5) * 0.05 : 0; // weight shifts foot to foot
  let crouch = 0;
  if (state.stoneT > 0) { // down on your knees over the stone, then back up
    const k = 1 - state.stoneT / 3;
    crouch = Math.sin(Math.min(1, k * 1.15) * Math.PI);
  }
  camera.position.set(
    state.pos.x - Math.cos(state.yaw) * sway,
    gy + 1.68 - crouch * 0.62 + bob + state.jumpY,
    state.pos.z + Math.sin(state.yaw) * sway);
  camera.rotation.y = state.yaw;
  camera.rotation.x = state.pitch - crouch * 0.55 + (state.moving ? Math.sin(bobT * 0.5) * 0.008 : 0);
  camera.rotation.z = state.moving ? Math.sin(bobT * 0.5) * 0.013 : 0; // and the head rolls with it
  }
  if (state.shakeT > 0) { // impacts rattle the view for a moment
    state.shakeT = Math.max(0, state.shakeT - dt);
    const k = state.shakeT * 5;
    camera.position.x += (Math.random() - 0.5) * 0.055 * k;
    camera.position.y += (Math.random() - 0.5) * 0.045 * k;
  }
  // hold a constant HORIZONTAL field of view (~102°) and derive the vertical
  // from the aspect: with a fixed vertical FOV, very wide phone screens got a
  // fisheye that dwarfed everything nearby — doors looked knee-high.
  // (tan(102.5°/2) = 1.246; at a 16:9 desktop this lands on the old 70°.)
  const baseFov = clamp(2 * Math.atan(1.246 / camera.aspect) * 180 / Math.PI, 52, 80);
  // sprint widens the view a touch
  const fovTarget = state.sprinting && state.moving && state.stamina > 0 ? baseFov + 7 : baseFov;
  if (Math.abs(camera.fov - fovTarget) > 0.05) {
    camera.fov += (fovTarget - camera.fov) * Math.min(1, dt * 6);
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();

  /* wind, water and sky keep moving */
  windTime.value = now * 0.001;
  waterTex.offset.x = now * 0.00002;
  waterTex.offset.y = now * 0.000013;
  if (waterObj) waterObj.material.uniforms.time.value = now * 0.00045; // slow, heavy water
  if (waterGeoRef) { // real waves: the surface itself rises and falls
    const wp = waterGeoRef.attributes.position;
    const wt = now * 0.0012;
    for (let i = 0; i < wp.count; i++) {
      const x = wp.getX(i), y = wp.getY(i);
      wp.setZ(i, Math.sin(wt + x * 0.35 + y * 0.21) * 0.055 + Math.sin(wt * 1.7 + y * 0.5 - x * 0.13) * 0.035);
    }
    wp.needsUpdate = true;
  }

  /* held item */
  heldGroup.visible = !!state.held && !state.ended && !state.dead;
  if (heldGroup.visible) {
    heldGroup.position.y = -0.34 + (state.moving ? Math.sin(bobT) * 0.02 : Math.sin(now * 0.0012) * 0.008);
    heldGroup.rotation.z = 0.1 + (state.moving ? Math.sin(bobT * 0.5) * 0.03 : 0);
  }
  // the flashlight lights when it's in your hand and switched on (F toggles it)
  torchLight.intensity = (heldGroup.visible && state.held === 'Flashlight' && state.torchOn) ? 1.6 : 0;

  /* the cabin lanterns breathe — dim, uneasy, and every so often they gutter */
  if (window._cabinLamps) {
    for (let i = 0; i < 2; i++) {
      let v = 0.4 + Math.sin(now * 0.012 + i * 2.6) * 0.07 + Math.sin(now * 0.037 + i) * 0.04 + Math.random() * 0.07;
      if (Math.random() < 0.012) v *= 0.2; // gutters for a heartbeat
      window._cabinLamps[i].intensity = v;
      window._cabinLampGlass[i].material.opacity = 0.45 + v * 0.8;
    }
  }
  if (window._cabinEmber) // embers pulse slower and deeper than the lamps
    window._cabinEmber.intensity = 0.42 + Math.sin(now * 0.004) * 0.12 + Math.random() * 0.06;

  animateFires(now, dt);

  updateLighting();
  updateClouds(dt);
  updateFireflies(now, 1 - daylight());
  // the shadow map re-renders every ~0.4s — the sun crawls, nobody notices —
  // and if a weak GPU is struggling after the first grace period, shadows go
  shadowT += dt;
  if (shadowT > 0.4 && sun.castShadow && sun.intensity > 0.1) {
    shadowT = 0;
    renderer.shadowMap.needsUpdate = true;
  }
  perfAvg += (dt - perfAvg) * 0.03;
  if (perfAvg > 0.055 && state.playSec > 10 && sun.castShadow) {
    sun.castShadow = false;
    renderer.shadowMap.needsUpdate = true;
  }
  renderer.render(scene, camera);
}

/* ---------------- start ---------------- */
$('btn-start').addEventListener('click', () => {
  audio.init();
  if (IS_TOUCH) goFullscreen(); // phones: fullscreen + hold landscape
  $('start').style.display = 'none';
  // three seconds of black, and a date typed onto it — then the woods
  const card = document.createElement('div');
  card.style.cssText = 'position:fixed;inset:0;background:#000;z-index:60;display:flex;align-items:center;justify-content:center;' +
    'color:#e8e2c8;font-family:"Courier New",monospace;font-size:26px;letter-spacing:5px;';
  document.body.appendChild(card);
  const dateTxt = 'November 19th 1983';
  let ci = 0;
  const iv = setInterval(() => {
    ci++;
    if (ci % 2 && dateTxt[ci - 1] !== ' ') audio.typeKey();
    card.textContent = dateTxt.slice(0, ci) + '▌';
    if (ci >= dateTxt.length) { clearInterval(iv); card.textContent = dateTxt; }
  }, 60);
  setTimeout(() => {
    card.style.transition = 'opacity .7s';
    card.style.opacity = '0';
    setTimeout(() => card.remove(), 750);
    state.running = true;
    revealProps();
    toast('It is already dark. Stay near the fire — and go through the luggage.');
  }, 3000);
});
/* ---------------- free animated models (licenses: assets/CREDITS.txt) ----------------
   Embedded as base64 so they load from file:// — parsed, cloned, and swapped in
   over the procedural stand-ins. If anything fails, the stand-ins remain. */
const modelMixers = [];
if (window.ASSETS_GLB && THREE.GLTFLoader && THREE.SkeletonUtils) {
  const loader = new THREE.GLTFLoader();
  const b64buf = s => Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer;
  // Khronos "Fox" (CC0 model, CC-BY rig) — replaces the box rabbits
  try {
    loader.parse(b64buf(ASSETS_GLB.fox), '', gltf => {
      for (const a of animals) {
        if (a.type !== 'rabbit') continue;
        const fox = THREE.SkeletonUtils.clone(gltf.scene);
        fox.scale.setScalar(0.012);
        fox.rotation.y = -Math.PI / 2; // model runs along +X; our animals face +Z
        enableShadows(fox);
        const wrap = new THREE.Group();
        wrap.add(fox);
        wrap.position.copy(a.g.position);
        scene.remove(a.g);
        scene.add(wrap);
        a.g = wrap;
        a.isFox = true;
        a.mixer = new THREE.AnimationMixer(fox);
        const clips = gltf.animations;
        a.actIdle = a.mixer.clipAction(clips.find(c => /survey/i.test(c.name)) || clips[0]);
        a.actRun = a.mixer.clipAction(clips.find(c => /run/i.test(c.name)) || clips[clips.length - 1]);
        a.actIdle.play();
        modelMixers.push(a.mixer);
      }
    }, () => {});
  } catch (e) { /* keep the stand-ins */ }
  // three.js "Stork" — the flocks overhead flap for real
  try {
    loader.parse(b64buf(ASSETS_GLB.stork), '', gltf => {
      flock.birds.forEach((b, i) => {
        while (b.children.length) b.remove(b.children[0]);
        const stork = THREE.SkeletonUtils.clone(gltf.scene);
        stork.scale.setScalar(0.045);
        b.add(stork);
        const mixer = new THREE.AnimationMixer(stork);
        const act = mixer.clipAction(gltf.animations[0]);
        act.time = i * 0.17; // don't flap in unison
        act.play();
        modelMixers.push(mixer);
      });
    }, () => {});
  } catch (e) { /* keep the stand-ins */ }
}

/* film grain — generated once, animated by CSS */
{
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const g = c.getContext('2d');
  const d = g.createImageData(160, 160);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = Math.floor(Math.random() * 255);
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = 48;
  }
  g.putImageData(d, 0, 0);
  $('grain').style.backgroundImage = `url(${c.toDataURL()})`;
}

updateLighting();
updateInvHUD();
requestAnimationFrame(t => { lastT = t; frame(t); });
