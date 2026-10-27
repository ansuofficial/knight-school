/* ---------- Wood ---------- */
// Every surface is painted in code on a canvas, so the game ships no image files and stays sharp at any size.
// A seeded random keeps each square's grain the same on every visit instead of shimmering between loads.
function rng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => { s = s * 16807 % 2147483647; return (s - 1) / 2147483646; };
}

// Grain is a few dozen wavy strokes, mostly darker than the base and a few lighter, so it reads as wood up close
// and as a calm color from across the board.
function grain(x, px, py, w, h, o) {
  x.save();
  x.beginPath(); x.rect(px, py, w, h); x.clip();
  x.fillStyle = o.base; x.fillRect(px, py, w, h);
  const R = rng(o.seed || 1), across = o.vertical ? w : h, along = o.vertical ? h : w;
  const n = Math.max(6, Math.floor(across * (o.density || 0.25)));
  for (let i = 0; i < n; i++) {
    const off = R() * across, amp = 1 + R() * (o.amp || 5), fr = (0.6 + R() * 1.8) / along * Math.PI * 2, ph = R() * 6.3;
    x.beginPath();
    for (let k = 0; k <= 28; k++) {
      const t = along * k / 28, v = off + Math.sin(t * fr + ph) * amp + Math.sin(t * fr * 2.7 + ph * 1.7) * amp * 0.35;
      if (o.vertical) k ? x.lineTo(px + v, py + t) : x.moveTo(px + v, py + t);
      else k ? x.lineTo(px + t, py + v) : x.moveTo(px + t, py + v);
    }
    x.strokeStyle = R() < 0.78 ? o.dark : o.light;
    x.globalAlpha = 0.05 + R() * 0.17;
    x.lineWidth = 0.6 + R() * 2.4 * (o.lw || 1);
    x.stroke();
  }
  x.globalAlpha = 1;
  // Pieces wrap the texture around a lathe, where a sheen across it would show a seam.
  if (o.flat) { x.restore(); return; }
  const gr = o.vertical ? x.createLinearGradient(px, py, px + w, py) : x.createLinearGradient(px, py, px, py + h);
  gr.addColorStop(0, "rgba(255,255,255,0.05)"); gr.addColorStop(0.5, "rgba(255,255,255,0)"); gr.addColorStop(1, "rgba(0,0,0,0.05)");
  x.fillStyle = gr; x.fillRect(px, py, w, h);
  x.restore();
}

function canvasTex(c, repeat) {
  const t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  t.anisotropy = ANISO;   // keeps far squares crisp when the board is tilted
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

/* ---------- Board ---------- */
// The frame carries the file letters and rank numbers, so they turn with the board like on a real set.
const FRAME = 0.62, BW = 8 + FRAME * 2;
const BOARD_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif';
const WOOD = {
  frame: { base: "#5A3823", dark: "#2C190D", light: "#7C5032" },
  side: { base: "#4E301C", dark: "#26150A", light: "#6E4529" },
  lightSq: { base: "#E5C99B", dark: "#B38C5A", light: "#F4E2C0" },
  darkSq: { base: "#86552F", dark: "#55321A", light: "#A2704A" },
  inlay: "#D9BD8F", inlayLine: "#37210F", letters: "#EBD5B0"
};

function boardTexture() {
  const PX = 2048, u = PX / BW, c = document.createElement("canvas");
  c.width = c.height = PX;
  const x = c.getContext("2d"), o = FRAME * u;
  grain(x, 0, 0, PX, PX, Object.assign({ vertical: false, seed: 7, density: 0.16, amp: 7 }, WOOD.frame));
  const edge = x.createLinearGradient(0, 0, 0, PX);
  edge.addColorStop(0, "rgba(0,0,0,0.10)"); edge.addColorStop(0.5, "rgba(0,0,0,0)"); edge.addColorStop(1, "rgba(0,0,0,0.10)");
  x.fillStyle = edge; x.fillRect(0, 0, PX, PX);
  x.fillStyle = WOOD.inlay; x.fillRect(o - 0.075 * u, o - 0.075 * u, 8 * u + 0.15 * u, 8 * u + 0.15 * u);
  x.fillStyle = WOOD.inlayLine; x.fillRect(o - 0.04 * u, o - 0.04 * u, 8 * u + 0.08 * u, 8 * u + 0.08 * u);
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    // Neighbouring squares run their grain across each other, like real veneer.
    const light = (f + r) % 2 === 1, px = o + f * u, py = o + (7 - r) * u, seed = 11 + f * 13 + r * 7, vertical = (f + r) % 2 === 0;
    grain(x, px, py, u, u, Object.assign({ vertical, seed, density: 0.32, amp: 4 }, light ? WOOD.lightSq : WOOD.darkSq));
  }
  x.font = `600 ${Math.round(0.27 * u)}px ${BOARD_FONT}`;
  x.textAlign = "center"; x.textBaseline = "middle";
  const label = (t, cx, cy, rot) => {
    x.save(); x.translate(cx, cy); x.rotate(rot);
    x.fillStyle = "rgba(0,0,0,0.5)"; x.fillText(t, 0, 2);   // a dark edge under each letter, so it looks carved
    x.fillStyle = WOOD.letters; x.fillText(t, 0, 0);
    x.restore();
  };
  // Each side is written the right way up for the player sitting there.
  for (let f = 0; f < 8; f++) { const L = "abcdefgh"[f]; label(L, o + (f + 0.5) * u, o + 8 * u + o * 0.48, 0); label(L, o + (f + 0.5) * u, o * 0.52, Math.PI); }
  for (let r = 0; r < 8; r++) { label(String(r + 1), o * 0.48, o + (7 - r + 0.5) * u, 0); label(String(r + 1), o + 8 * u + o * 0.52, o + (7 - r + 0.5) * u, Math.PI); }
  return canvasTex(c);
}

function sideTexture() {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 64;
  grain(c.getContext("2d"), 0, 0, 1024, 64, Object.assign({ vertical: false, seed: 3, density: 0.5, amp: 2 }, WOOD.side));
  return canvasTex(c);
}

function buildBoard() {
  const g = new THREE.Group();
  const sideMat = new THREE.MeshPhysicalMaterial({ map: sideTexture(), roughness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.3 });
  const topMat = new THREE.MeshPhysicalMaterial({ map: boardTexture(), roughness: 0.62, clearcoat: 0.12, clearcoatRoughness: 0.5, envMapIntensity: 0.3 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(BW, 0.3, BW), [sideMat, sideMat, topMat, sideMat, sideMat, sideMat]);
  box.position.y = -0.15; box.castShadow = true; box.receiveShadow = true;
  g.add(box);
  // A darker, slightly smaller plinth lifts the board off the table, so its shadow has a soft gap.
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(BW - 0.3, 0.08, BW - 0.3), new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.8 }));
  plinth.position.y = -0.34; plinth.castShadow = true;
  g.add(plinth);
  // The table itself is invisible: it only catches shadows, so the cream page shows through.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.13 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.38; ground.receiveShadow = true;
  g.add(ground);
  return g;
}

/* ---------- Pieces ---------- */
// Pieces are turned on a lathe, like real Staunton pieces: a profile of points spun around the middle.
// A profile mixes plain points [r, y], smooth runs { s: [...] } and arcs { a: [cx, cy, r, from, to] }.
function profile(parts) {
  const out = [];
  const push = v => { const last = out[out.length - 1]; if (!last || last.distanceTo(v) > 1e-4) out.push(v); };
  for (const p of parts) {
    if (Array.isArray(p)) push(new THREE.Vector2(p[0], p[1]));
    else if (p.s) new THREE.SplineCurve(p.s.map(q => new THREE.Vector2(q[0], q[1]))).getPoints(p.n || 14).forEach(push);
    else if (p.a) {
      const [cx, cy, r, a0, a1] = p.a, n = p.n || 16;
      for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; push(new THREE.Vector2(Math.max(0, cx + r * Math.cos(a)), cy + r * Math.sin(a))); }
    }
  }
  return out;
}
// The same stepped foot under every piece makes the set look like it came from one workshop.
const foot = w => [[0, 0], [w, 0], [w + 0.012, 0.012], [w + 0.012, 0.042], [w - 0.004, 0.056], [w - 0.03, 0.063], [w - 0.03, 0.076], [w - 0.06, 0.09]];
function lathe(parts) { const g = new THREE.LatheGeometry(profile(parts), 64); g.computeVertexNormals(); return g; }

function woodPieceTex(o) {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 512;
  grain(c.getContext("2d"), 0, 0, 512, 512, Object.assign({ vertical: true, density: 0.22, amp: 9, lw: 1.3, flat: true }, o));
  return canvasTex(c, [2, 1]);
}
// White is waxed boxwood. Black is lacquered, so it gets a strong clear coat and catches crisp highlights.
const PIECE_MAT = {
  w: new THREE.MeshPhysicalMaterial({ map: woodPieceTex({ base: "#ECD8B3", dark: "#BF9663", light: "#F8EBD0", seed: 5 }), roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.25, envMapIntensity: 0.75 }),
  b: new THREE.MeshPhysicalMaterial({ map: woodPieceTex({ base: "#2B1D15", dark: "#0E0805", light: "#4A3426", seed: 9 }), roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 0.75 })
};
const DETAIL_MAT = { w: new THREE.MeshStandardMaterial({ color: 0x4A2E1A, roughness: 0.6 }), b: new THREE.MeshStandardMaterial({ color: 0x9C7A58, roughness: 0.5 }) };
const FELT = new THREE.MeshStandardMaterial({ color: 0x2E4A36, roughness: 1 });

// One battlement of the rook's crown: a ring segment with softened edges.
function sector(r1, r2, a0, a1, h) {
  const s = new THREE.Shape();
  s.absarc(0, 0, r2, a0, a1, false); s.absarc(0, 0, r1, a1, a0, true); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 10 });
  g.rotateX(-Math.PI / 2);
  return g;
}

// The knight is carved rather than turned: a side profile cut out and thickened, then narrowed toward the muzzle
// and the ears so it looks shaped by hand from every angle, not like a flat cutout.
const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const taper = (x, y) => (1 - 0.52 * smooth(-0.04, 0.26, x) * smooth(0.3, 0.42, y)) * (1 - 0.32 * smooth(0.64, 0.8, y)) * (1 + 0.12 * smooth(0.3, 0.12, y));
function knightHead() {
  const pts = [[-0.17, 0.12], [-0.185, 0.3], [-0.155, 0.45], [-0.105, 0.58], [-0.045, 0.68], [-0.015, 0.76], [0.03, 0.805], [0.055, 0.725], [0.1, 0.68], [0.17, 0.605], [0.225, 0.51], [0.262, 0.44], [0.25, 0.395], [0.205, 0.378], [0.145, 0.392], [0.085, 0.415], [0.06, 0.36], [0.095, 0.28], [0.135, 0.2], [0.15, 0.12]];
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  s.splineThru(pts.slice(1).map(p => new THREE.Vector2(p[0], p[1])));
  s.lineTo(pts[0][0], pts[0][1]);
  const depth = 0.13;
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.028, bevelSegments: 5, curveSegments: 40 });
  g.translate(0, 0, -depth / 2);
  const pa = g.attributes.position;
  for (let i = 0; i < pa.count; i++) pa.setZ(i, pa.getZ(i) * taper(pa.getX(i), pa.getY(i)));
  g.translate(-0.03, 0, 0);
  g.computeVertexNormals();
  // The mane is a separate raised strip down the back of the neck.
  const back = [[-0.185, 0.3], [-0.155, 0.45], [-0.105, 0.58], [-0.045, 0.68], [-0.012, 0.745]];
  const outer = back.map(([a, b]) => [a - 0.03, b + 0.012]), inner = back.slice().reverse().map(([a, b]) => [a + 0.05, b - 0.01]);
  const ms = new THREE.Shape();
  ms.moveTo(outer[0][0], outer[0][1]);
  ms.splineThru(outer.slice(1).map(p => new THREE.Vector2(p[0], p[1])));
  inner.forEach(p => ms.lineTo(p[0], p[1]));
  ms.closePath();
  const mane = new THREE.ExtrudeGeometry(ms, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.012, bevelSegments: 3, curveSegments: 24 });
  mane.translate(-0.03, 0, -0.025);
  mane.computeVertexNormals();
  const half = depth / 2 + 0.035;
  return { head: g, mane, half, eyeZ: half * taper(0.115, 0.6), noseZ: half * taper(0.245, 0.43) };
}
const KNIGHT = knightHead();

// Piece types follow the rules engine: 1 pawn, 2 knight, 3 bishop, 4 rook, 5 queen, 6 king.
const BODY = {
  1: lathe([...foot(0.25), { s: [[0.19, 0.09], [0.15, 0.13], [0.115, 0.2], [0.095, 0.27]], n: 12 }, [0.14, 0.285], [0.152, 0.3], [0.14, 0.315], [0.085, 0.326], { a: [0, 0.41, 0.095, -62, 90], n: 20 }]),
  2: lathe([...foot(0.28), { s: [[0.22, 0.09], [0.2, 0.11], [0.19, 0.14]], n: 5 }, [0.17, 0.155], [0, 0.155]]),
  3: lathe([...foot(0.27), { s: [[0.21, 0.09], [0.18, 0.12], [0.14, 0.19], [0.112, 0.3], [0.1, 0.42]], n: 14 }, [0.15, 0.44], [0.162, 0.458], [0.15, 0.474], [0.105, 0.486], { s: [[0.105, 0.486], [0.128, 0.52], [0.137, 0.57], [0.122, 0.63], [0.082, 0.69], [0.03, 0.722]], n: 16 }, { a: [0, 0.752, 0.033, -70, 90], n: 12 }]),
  4: lathe([...foot(0.3), { s: [[0.24, 0.09], [0.215, 0.12], [0.195, 0.2], [0.185, 0.32], [0.18, 0.42]], n: 14 }, [0.205, 0.435], [0.215, 0.452], [0.2, 0.468], [0.205, 0.48], { s: [[0.205, 0.48], [0.232, 0.5], [0.245, 0.53]], n: 6 }, [0.245, 0.585], [0.172, 0.585], [0.172, 0.555], [0, 0.555]]),
  5: lathe([...foot(0.31), { s: [[0.25, 0.09], [0.22, 0.12], [0.17, 0.19], [0.13, 0.34], [0.112, 0.55]], n: 16 }, [0.162, 0.57], [0.172, 0.592], [0.158, 0.612], [0.115, 0.622], { s: [[0.115, 0.622], [0.135, 0.68], [0.17, 0.76], [0.205, 0.83]], n: 12 }, [0.19, 0.845], { a: [0, 0.84, 0.1, 10, 90], n: 14 }]),
  6: lathe([...foot(0.32), { s: [[0.26, 0.09], [0.23, 0.12], [0.18, 0.19], [0.135, 0.38], [0.116, 0.6]], n: 16 }, [0.168, 0.62], [0.178, 0.645], [0.162, 0.665], [0.12, 0.675], { s: [[0.12, 0.675], [0.142, 0.73], [0.172, 0.8], [0.19, 0.865]], n: 12 }, [0.175, 0.878], { a: [0, 0.875, 0.118, 10, 90], n: 14 }])
};

function buildPiece(type, color) {
  const g = new THREE.Group(), mat = PIECE_MAT[color], detail = DETAIL_MAT[color];
  const add = (geo, m, x = 0, y = 0, z = 0) => { const me = new THREE.Mesh(geo, m); me.position.set(x, y, z); me.castShadow = true; me.receiveShadow = true; g.add(me); return me; };
  add(BODY[type], mat);
  // Green felt under the base, the way good wooden sets are finished.
  const felt = new THREE.Mesh(new THREE.CircleGeometry(type === 1 ? 0.24 : 0.29, 32), FELT);
  felt.rotation.x = Math.PI / 2; felt.position.y = 0.001;
  g.add(felt);
  if (type === 4) for (let i = 0; i < 5; i++) { const a = i * Math.PI * 2 / 5; add(sector(0.172, 0.245, a, a + Math.PI * 2 / 5 * 0.58, 0.07), mat, 0, 0.585, 0); }
  if (type === 3) { const slit = add(new THREE.BoxGeometry(0.15, 0.014, 0.06), detail, 0, 0.6, 0.085); slit.rotation.z = 0.62; slit.castShadow = false; }
  if (type === 5) {
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; add(new THREE.SphereGeometry(0.034, 16, 12), mat, Math.cos(a) * 0.19, 0.855, Math.sin(a) * 0.19); }
    add(new THREE.SphereGeometry(0.042, 20, 14), mat, 0, 0.975, 0);
  }
  if (type === 6) {
    add(new THREE.CylinderGeometry(0.035, 0.045, 0.04, 20), mat, 0, 1.005, 0);
    add(new THREE.BoxGeometry(0.055, 0.19, 0.055), mat, 0, 1.11, 0);
    add(new THREE.BoxGeometry(0.15, 0.055, 0.055), mat, 0, 1.13, 0);
  }
  if (type === 2) {
    const head = new THREE.Group();
    head.position.y = 0.03;
    for (const geo of [KNIGHT.head, KNIGHT.mane]) { const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = true; head.add(m); }
    const eye = new THREE.SphereGeometry(0.021, 12, 10), nostril = new THREE.SphereGeometry(0.014, 10, 8), cheek = new THREE.SphereGeometry(0.08, 20, 14);
    for (const z of [-1, 1]) {
      const e = new THREE.Mesh(eye, detail); e.position.set(0.085, 0.6, z * (KNIGHT.eyeZ - 0.006)); head.add(e);
      const n = new THREE.Mesh(nostril, detail); n.position.set(0.212, 0.43, z * (KNIGHT.noseZ - 0.012)); head.add(n);
      const c = new THREE.Mesh(cheek, mat); c.scale.set(1.05, 0.9, 0.32); c.position.set(0.045, 0.47, z * (KNIGHT.half * taper(0.075, 0.47) - 0.012)); c.castShadow = true; head.add(c);
    }
    head.rotation.y = color === "w" ? Math.PI / 2 : -Math.PI / 2;   // knights face the other army
    g.add(head);
  }
  return g;
}

// Building a piece takes real work, so each kind is built once and cloned. Clones share geometry and materials.
const PIECES = { w: {}, b: {} };
for (const c of ["w", "b"]) for (let t = 1; t <= 6; t++) PIECES[c][t] = buildPiece(t, c);
const makePiece = (type, color) => PIECES[color][type].clone();

/* ---------- Lesson star ---------- */
// A thick gold star with bevelled edges, so it glints as it spins.
const STAR_GEO = (() => {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 0.085 : 0.2, a = i / 10 * Math.PI * 2 + Math.PI / 2;
    i ? s.lineTo(Math.cos(a) * r, Math.sin(a) * r) : s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.018, bevelSegments: 2 });
  g.center();
  return g;
})();
const STAR_MAT = new THREE.MeshStandardMaterial({ color: 0xF2B630, metalness: 0.55, roughness: 0.28, emissive: 0x7a4a00, emissiveIntensity: 0.3 });
