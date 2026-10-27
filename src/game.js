(() => {
/* ---------- Settings ---------- */
// How the computer plays at each level. depth: moves it looks ahead. extra: captures it keeps following after that,
// so it does not stop thinking in the middle of a trade. noise: random points added to every move it weighs
// (100 points is one pawn), so bigger means more mistakes. blunder: the chance it plays a random legal move.
const LEVELS = {
  beginner:    { depth: 1, extra: 0, noise: 150, blunder: 0.12 },
  casual:      { depth: 2, extra: 2, noise: 40,  blunder: 0.02 },
  challenging: { depth: 3, extra: 4, noise: 8,   blunder: 0 },
  hint:        { depth: 3, extra: 4, noise: 0,   blunder: 0 }   // the coach's suggestion: its best move, never random
};
const LEVEL_NOTE = {
  beginner: "Makes lots of mistakes. Perfect for your first games.",
  casual: "Plays sensible moves but misses some tricks.",
  challenging: "Thinks a few moves ahead. Watch your pieces!"
};
const THINK = 700;        // the computer waits at least this many milliseconds, so its reply never feels instant
const MOTION = 1;         // piece and effect timings are multiplied by this: 0.5 is twice as fast
const CAMERA = { tilt: 0.8, spin: 0.09, zoomMin: 0.55, zoomMax: 1.7 };   // tilt from straight down (radians); idle spin (radians per second)
const FIND = 5;           // squares to find in the first lesson
const SAVE = "knight-school-v1";   // the browser storage key for lesson progress and choices

/* ---------- Chess rules ---------- */
// The rules live in one self-contained function, so the same code can also run in a Web Worker:
// the computer thinks there, and the board keeps moving smoothly while it does.
// Squares are numbered 0 to 63 from a1 to h8, so a square's file is its last three bits and its rank the rest.
// A piece is its type, 1 pawn to 6 king, plus 8 when it is black.
function ENGINE(LEVELS) {
  const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
  const VAL = [0, 100, 320, 330, 500, 900, 0];
  const INF = 1e9, MATE = 100000;
  const F = s => s & 7, Rk = s => s >> 3;
  const NAME = s => "abcdefgh"[s & 7] + ((s >> 3) + 1);
  const IDX = n => (n.charCodeAt(0) - 97) + (n.charCodeAt(1) - 49) * 8;
  const on = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
  // The first four directions are straight (rook), the last four diagonal (bishop).
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const NT = [], KT = [], RAYS = [];
  for (let s = 0; s < 64; s++) {
    const f = F(s), r = Rk(s);
    NT[s] = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]].filter(([a, b]) => on(f + a, r + b)).map(([a, b]) => s + a + b * 8);
    KT[s] = DIRS.filter(([a, b]) => on(f + a, r + b)).map(([a, b]) => s + a + b * 8);
    RAYS[s] = DIRS.map(([a, b]) => { const o = []; let x = f + a, y = r + b; while (on(x, y)) { o.push(x + y * 8); x += a; y += b; } return o; });
  }
  // Castling rights as bits (1 white short, 2 white long, 4 black short, 8 black long). Anything that moves from or
  // lands on a king or rook square clears the rights that square stands for.
  const CR = new Array(64).fill(15);
  CR[0] = 15 & ~2; CR[7] = 15 & ~1; CR[4] = 15 & ~3; CR[56] = 15 & ~8; CR[63] = 15 & ~4; CR[60] = 15 & ~12;

  function fromFen(fen) {
    const st = { b: new Int8Array(64), turn: 0, castle: 0, ep: -1, half: 0, full: 1, king: [-1, -1], hist: [] };
    const parts = fen.trim().split(/\s+/), rows = parts[0].split("/");
    for (let i = 0; i < 8; i++) {
      let f = 0; const r = 7 - i;
      for (const ch of rows[i]) {
        if (ch >= "1" && ch <= "8") { f += +ch; continue; }
        const lo = ch.toLowerCase(), t = "pnbrqk".indexOf(lo) + 1, c = ch === lo ? 8 : 0;
        st.b[r * 8 + f] = t | c;
        if (t === K) st.king[c >> 3] = r * 8 + f;
        f++;
      }
    }
    st.turn = parts[1] === "b" ? 8 : 0;
    const cas = parts[2] || "-";
    if (cas.includes("K")) st.castle |= 1; if (cas.includes("Q")) st.castle |= 2;
    if (cas.includes("k")) st.castle |= 4; if (cas.includes("q")) st.castle |= 8;
    st.ep = parts[3] && parts[3] !== "-" ? IDX(parts[3]) : -1;
    st.half = +parts[4] || 0; st.full = +parts[5] || 1;
    return st;
  }
  function boardFen(st) {
    let s = "";
    for (let r = 7; r >= 0; r--) {
      let e = 0;
      for (let f = 0; f < 8; f++) {
        const p = st.b[r * 8 + f];
        if (!p) { e++; continue; }
        if (e) { s += e; e = 0; }
        const ch = "pnbrqk"[(p & 7) - 1]; s += p & 8 ? ch : ch.toUpperCase();
      }
      if (e) s += e;
      if (r) s += "/";
    }
    return s;
  }
  function castleStr(st) {
    let c = "";
    if (st.castle & 1) c += "K"; if (st.castle & 2) c += "Q"; if (st.castle & 4) c += "k"; if (st.castle & 8) c += "q";
    return c || "-";
  }
  function toFen(st) {
    return boardFen(st) + " " + (st.turn ? "b" : "w") + " " + castleStr(st) + " " + (st.ep >= 0 ? NAME(st.ep) : "-") + " " + st.half + " " + st.full;
  }

  // Is square sq attacked by side `by` (0 white, 8 black)? Looks outward from the square, which is far cheaper
  // than generating every enemy move.
  function attacked(st, sq, by) {
    const b = st.b, f = F(sq), r = Rk(sq);
    if (by === 0) { if (r > 0) { if (f > 0 && b[sq - 9] === P) return true; if (f < 7 && b[sq - 7] === P) return true; } }
    else { if (r < 7) { if (f > 0 && b[sq + 7] === (P | 8)) return true; if (f < 7 && b[sq + 9] === (P | 8)) return true; } }
    const kn = N | by, kg = K | by, rk = R | by, qn = Q | by, bs = B | by;
    const nt = NT[sq]; for (let i = 0; i < nt.length; i++) if (b[nt[i]] === kn) return true;
    const kt = KT[sq]; for (let i = 0; i < kt.length; i++) if (b[kt[i]] === kg) return true;
    const rays = RAYS[sq];
    for (let d = 0; d < 8; d++) {
      const ray = rays[d];
      for (let i = 0; i < ray.length; i++) {
        const p = b[ray[i]];
        if (p) { if (p === qn || (d < 4 ? p === rk : p === bs)) return true; break; }
      }
    }
    return false;
  }
  function attackers(st, sq, by) {
    const b = st.b, f = F(sq), r = Rk(sq), out = [];
    if (by === 0) { if (r > 0) { if (f > 0 && b[sq - 9] === P) out.push(sq - 9); if (f < 7 && b[sq - 7] === P) out.push(sq - 7); } }
    else { if (r < 7) { if (f > 0 && b[sq + 7] === (P | 8)) out.push(sq + 7); if (f < 7 && b[sq + 9] === (P | 8)) out.push(sq + 9); } }
    for (const t of NT[sq]) if (b[t] === (N | by)) out.push(t);
    for (const t of KT[sq]) if (b[t] === (K | by)) out.push(t);
    for (let d = 0; d < 8; d++) {
      for (const t of RAYS[sq][d]) {
        const p = b[t];
        if (p) { if (p === (Q | by) || (d < 4 ? p === (R | by) : p === (B | by))) out.push(t); break; }
      }
    }
    return out;
  }
  function attacksFrom(st, s) {
    const p = st.b[s]; if (!p) return [];
    const t = p & 7, c = p & 8, out = [];
    if (t === P) { const dr = c ? -1 : 1; for (const df of [-1, 1]) if (on(F(s) + df, Rk(s) + dr)) out.push(s + df + dr * 8); }
    else if (t === N) out.push(...NT[s]);
    else if (t === K) out.push(...KT[s]);
    else {
      const d0 = t === B ? 4 : 0, d1 = t === R ? 4 : 8;
      for (let d = d0; d < d1; d++) for (const to of RAYS[s][d]) { out.push(to); if (st.b[to]) break; }
    }
    return out;
  }

  // Moves that follow how pieces move, before checking the king is safe. Flags: 1 capture, 2 en passant,
  // 4 castle short, 8 castle long, 16 pawn double step, 32 promotion. With caps set, only captures and promotions.
  function gen(st, caps) {
    const b = st.b, us = st.turn, them = us ^ 8, out = [];
    const add = (from, to, piece, cap, flag, promo) => out.push({ from, to, piece, cap, flag, promo: promo || 0 });
    for (let s = 0; s < 64; s++) {
      const p = b[s]; if (!p || (p & 8) !== us) continue;
      const t = p & 7;
      if (t === P) {
        const dir = us ? -8 : 8, r = Rk(s), f = F(s), last = us ? 0 : 7, start = us ? 6 : 1, one = s + dir;
        if (one >= 0 && one < 64 && !b[one]) {
          if (Rk(one) === last) { for (const pr of [Q, R, B, N]) add(s, one, p, 0, 32, pr); }
          else if (!caps) { add(s, one, p, 0, 0); if (r === start && !b[one + dir]) add(s, one + dir, p, 0, 16); }
        }
        for (const df of [-1, 1]) {
          const nf = f + df; if (nf < 0 || nf > 7) continue;
          const to = one + df; if (to < 0 || to > 63) continue;
          const q = b[to];
          if (q && (q & 8) === them) { if (Rk(to) === last) { for (const pr of [Q, R, B, N]) add(s, to, p, q, 33, pr); } else add(s, to, p, q, 1); }
          else if (!q && to === st.ep && b[to - dir] === (P | them)) add(s, to, p, P | them, 3);
        }
      } else if (t === N || t === K) {
        const tl = t === N ? NT[s] : KT[s];
        for (const to of tl) { const q = b[to]; if (!q) { if (!caps) add(s, to, p, 0, 0); } else if ((q & 8) === them) add(s, to, p, q, 1); }
        if (t === K && !caps) {
          // The king may not castle out of, through or into check.
          if (us === 0 && s === 4) {
            if ((st.castle & 1) && b[7] === R && !b[5] && !b[6] && !attacked(st, 4, 8) && !attacked(st, 5, 8) && !attacked(st, 6, 8)) add(4, 6, p, 0, 4);
            if ((st.castle & 2) && b[0] === R && !b[1] && !b[2] && !b[3] && !attacked(st, 4, 8) && !attacked(st, 3, 8) && !attacked(st, 2, 8)) add(4, 2, p, 0, 8);
          } else if (us === 8 && s === 60) {
            if ((st.castle & 4) && b[63] === (R | 8) && !b[61] && !b[62] && !attacked(st, 60, 0) && !attacked(st, 61, 0) && !attacked(st, 62, 0)) add(60, 62, p, 0, 4);
            if ((st.castle & 8) && b[56] === (R | 8) && !b[57] && !b[58] && !b[59] && !attacked(st, 60, 0) && !attacked(st, 59, 0) && !attacked(st, 58, 0)) add(60, 58, p, 0, 8);
          }
        }
      } else {
        const d0 = t === B ? 4 : 0, d1 = t === R ? 4 : 8;
        for (let d = d0; d < d1; d++) {
          for (const to of RAYS[s][d]) {
            const q = b[to];
            if (!q) { if (!caps) add(s, to, p, 0, 0); }
            else { if ((q & 8) === them) add(s, to, p, q, 1); break; }
          }
        }
      }
    }
    return out;
  }

  // make and unmake change one board in place. Copying the board for every move would make the search far slower.
  function make(st, m) {
    const b = st.b, us = st.turn;
    st.hist.push({ m, castle: st.castle, ep: st.ep, half: st.half });
    b[m.from] = 0;
    if (m.flag & 2) b[m.to + (us ? 8 : -8)] = 0;
    b[m.to] = m.promo ? (m.promo | us) : m.piece;
    if ((m.piece & 7) === K) {
      st.king[us >> 3] = m.to;
      if (m.flag & 4) { const rf = us ? 63 : 7, rt = us ? 61 : 5; b[rt] = b[rf]; b[rf] = 0; }
      if (m.flag & 8) { const rf = us ? 56 : 0, rt = us ? 59 : 3; b[rt] = b[rf]; b[rf] = 0; }
    }
    if ((m.cap & 7) === K) st.king[(us ^ 8) >> 3] = -1;
    st.castle &= CR[m.from] & CR[m.to];
    st.ep = (m.flag & 16) ? (m.from + m.to) >> 1 : -1;
    st.half = ((m.piece & 7) === P || m.cap) ? 0 : st.half + 1;
    if (us) st.full++;
    st.turn = us ^ 8;
  }
  function unmake(st) {
    const u = st.hist.pop(), m = u.m, b = st.b;
    const us = st.turn ^ 8; st.turn = us; if (us) st.full--;
    b[m.from] = m.piece;
    if (m.flag & 2) { b[m.to] = 0; b[m.to + (us ? 8 : -8)] = m.cap; } else b[m.to] = m.cap;
    if ((m.piece & 7) === K) {
      st.king[us >> 3] = m.from;
      if (m.flag & 4) { const rf = us ? 63 : 7, rt = us ? 61 : 5; b[rf] = b[rt]; b[rt] = 0; }
      if (m.flag & 8) { const rf = us ? 56 : 0, rt = us ? 59 : 3; b[rf] = b[rt]; b[rt] = 0; }
    }
    if ((m.cap & 7) === K) st.king[(us ^ 8) >> 3] = m.to;
    st.castle = u.castle; st.ep = u.ep; st.half = u.half;
  }
  function inCheck(st, c) {
    if (c === undefined) c = st.turn;
    const k = st.king[c >> 3];
    return k >= 0 && attacked(st, k, c ^ 8);
  }
  function legal(st, caps) {
    const us = st.turn, ki = us >> 3, out = [], ms = gen(st, caps);
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]; make(st, m);
      const k = st.king[ki];
      if (k < 0 || !attacked(st, k, us ^ 8)) out.push(m);
      unmake(st);
    }
    return out;
  }
  // Standard algebraic notation, like Nf3, exd5, O-O or e8=Q+. A letter or rank is added only when two
  // identical pieces could reach the same square.
  function san(st, m, moves) {
    moves = moves || legal(st);
    let s;
    if (m.flag & 4) s = "O-O";
    else if (m.flag & 8) s = "O-O-O";
    else {
      const t = m.piece & 7;
      if (t === P) {
        s = m.cap ? "abcdefgh"[F(m.from)] + "x" + NAME(m.to) : NAME(m.to);
        if (m.promo) s += "=" + "PNBRQK"[m.promo - 1];
      } else {
        const others = moves.filter(o => o.piece === m.piece && o.to === m.to && o.from !== m.from);
        let d = "";
        if (others.length) {
          const sameF = others.some(o => F(o.from) === F(m.from)), sameR = others.some(o => Rk(o.from) === Rk(m.from));
          if (!sameF) d = "abcdefgh"[F(m.from)]; else if (!sameR) d = String(Rk(m.from) + 1); else d = NAME(m.from);
        }
        s = "PNBRQK"[t - 1] + d + (m.cap ? "x" : "") + NAME(m.to);
      }
    }
    make(st, m);
    if (inCheck(st)) s += legal(st).length ? "+" : "#";
    unmake(st);
    return s;
  }
  // King against king, or with one minor piece, or bishops all on one color: nobody can ever be checkmated.
  function insufficient(st) {
    const minors = [];
    for (let s = 0; s < 64; s++) {
      const p = st.b[s]; if (!p) continue;
      const t = p & 7; if (t === K) continue;
      if (t === P || t === R || t === Q) return false;
      minors.push({ t, s });
    }
    if (minors.length <= 1) return true;
    if (minors.every(m => m.t === B)) {
      const c = (F(minors[0].s) + Rk(minors[0].s)) % 2;
      return minors.every(m => (F(m.s) + Rk(m.s)) % 2 === c);
    }
    return false;
  }
  // Positions count as the same for repetition only if the same moves are possible, so an en passant square
  // is kept only when an en passant capture is really there.
  function posKey(st) {
    let ep = "-";
    if (st.ep >= 0 && legal(st).some(m => m.flag & 2)) ep = NAME(st.ep);
    return boardFen(st) + " " + (st.turn ? "b" : "w") + " " + castleStr(st) + " " + ep;
  }

  // Where each piece likes to stand, written from White's side with rank 8 on top. Small bonuses that pull
  // knights to the middle, pawns forward and the king into a corner until the endgame, when it should come out.
  const PST = {
    1: [0,0,0,0,0,0,0,0,50,50,50,50,50,50,50,50,10,10,20,30,30,20,10,10,5,5,10,25,25,10,5,5,0,0,0,20,20,0,0,0,5,-5,-10,0,0,-10,-5,5,5,10,10,-20,-20,10,10,5,0,0,0,0,0,0,0,0],
    2: [-50,-40,-30,-30,-30,-30,-40,-50,-40,-20,0,0,0,0,-20,-40,-30,0,10,15,15,10,0,-30,-30,5,15,20,20,15,5,-30,-30,0,15,20,20,15,0,-30,-30,5,10,15,15,10,5,-30,-40,-20,0,5,5,0,-20,-40,-50,-40,-30,-30,-30,-30,-40,-50],
    3: [-20,-10,-10,-10,-10,-10,-10,-20,-10,0,0,0,0,0,0,-10,-10,0,5,10,10,5,0,-10,-10,5,5,10,10,5,5,-10,-10,0,10,10,10,10,0,-10,-10,10,10,10,10,10,10,-10,-10,5,0,0,0,0,5,-10,-20,-10,-10,-10,-10,-10,-10,-20],
    4: [0,0,0,0,0,0,0,0,5,10,10,10,10,10,10,5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,0,0,0,5,5,0,0,0],
    5: [-20,-10,-10,-5,-5,-10,-10,-20,-10,0,0,0,0,0,0,-10,-10,0,5,5,5,5,0,-10,-5,0,5,5,5,5,0,-5,0,0,5,5,5,5,0,-5,-10,5,5,5,5,5,0,-10,-10,0,5,0,0,0,0,-10,-20,-10,-10,-5,-5,-10,-10,-20],
    6: [-30,-40,-40,-50,-50,-40,-40,-30,-30,-40,-40,-50,-50,-40,-40,-30,-30,-40,-40,-50,-50,-40,-40,-30,-30,-40,-40,-50,-50,-40,-40,-30,-20,-30,-30,-40,-40,-30,-30,-20,-10,-20,-20,-20,-20,-20,-20,-10,20,20,0,0,0,0,20,20,20,30,10,0,0,10,30,20],
    7: [-50,-40,-30,-20,-20,-30,-40,-50,-30,-20,-10,0,0,-10,-20,-30,-30,-10,20,30,30,20,-10,-30,-30,-10,30,40,40,30,-10,-30,-30,-10,30,40,40,30,-10,-30,-30,-10,20,30,30,20,-10,-30,-30,-30,0,0,0,0,-30,-30,-50,-30,-30,-30,-30,-30,-30,-50]
  };
  function evaluate(st) {
    const b = st.b; let npm = 0;
    for (let s = 0; s < 64; s++) { const t = b[s] & 7; if (t >= 2 && t <= 5) npm += VAL[t]; }
    const end = npm <= 2600;
    let score = 0, wb = 0, bb = 0;
    for (let s = 0; s < 64; s++) {
      const p = b[s]; if (!p) continue;
      const t = p & 7, black = p & 8;
      const i = black ? (Rk(s) * 8 + F(s)) : ((7 - Rk(s)) * 8 + F(s));
      const v = VAL[t] + (t === K ? (end ? PST[7] : PST[6]) : PST[t])[i];
      if (black) { score -= v; if (t === B) bb++; } else { score += v; if (t === B) wb++; }
    }
    if (wb >= 2) score += 30; if (bb >= 2) score -= 30;
    return score;
  }
  // Looking at captures first makes the search cut off bad lines much sooner.
  function order(ms) {
    for (const m of ms) m.o = (m.cap ? VAL[m.cap & 7] * 10 - VAL[m.piece & 7] / 10 + 1000 : 0) + (m.promo ? VAL[m.promo] : 0) + (m.flag & 12 ? 50 : 0);
    ms.sort((a, b) => b.o - a.o);
    return ms;
  }
  let nodes = 0;
  function quiesce(st, alpha, beta, q, ply) {
    nodes++;
    if (inCheck(st) && !legal(st).length) return -MATE + ply;
    const stand = evaluate(st) * (st.turn ? -1 : 1);
    if (q <= 0 || nodes > 350000) return stand;
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    for (const m of order(legal(st, true))) {
      make(st, m); const v = -quiesce(st, -beta, -alpha, q - 1, ply + 1); unmake(st);
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }
  function search(st, depth, alpha, beta, ply, q) {
    if (st.half >= 100) return 0;
    if (depth <= 0) return quiesce(st, alpha, beta, q, ply);
    nodes++;
    const ms = legal(st);
    if (!ms.length) return inCheck(st) ? -MATE + ply : 0;
    order(ms);
    for (const m of ms) {
      make(st, m); const v = -search(st, depth - 1, -beta, -alpha, ply + 1, q); unmake(st);
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }
  function bestMove(st, level) {
    const cfg = LEVELS[level] || LEVELS.casual;
    const ms = legal(st); if (!ms.length) return null;
    if (Math.random() < cfg.blunder) return ms[Math.floor(Math.random() * ms.length)];
    order(ms); nodes = 0;
    let best = ms[0], bestV = -INF, bestRaw = -INF;
    for (const m of ms) {
      // Moves already far worse than the best, even after noise, are not searched to the end.
      const a = bestRaw === -INF ? -INF : bestRaw - 2 * cfg.noise - 1;
      make(st, m); const v = -search(st, cfg.depth - 1, -INF, -a, 1, cfg.extra); unmake(st);
      const vn = v + (Math.random() * 2 - 1) * cfg.noise;
      if (v > bestRaw) bestRaw = v;
      if (vn > bestV) { bestV = vn; best = m; }
    }
    return best;
  }
  // Pieces of `color` that can be taken for free, or by something worth less. The coach warns about these.
  function hanging(st, color) {
    const out = [], them = color ^ 8;
    for (let s = 0; s < 64; s++) {
      const p = st.b[s]; if (!p || (p & 8) !== color) continue;
      const t = p & 7; if (t === K) continue;
      const att = attackers(st, s, them); if (!att.length) continue;
      const def = attacked(st, s, color);
      let min = 1e9, by = 0;
      for (const a of att) { const at = st.b[a] & 7; const v = at === K ? 1e8 : VAL[at]; if (v < min) { min = v; by = at; } }
      if (!def) out.push({ sq: s, type: t, free: true, by });
      else if (min < VAL[t]) out.push({ sq: s, type: t, free: false, by });
    }
    return out.sort((a, b) => VAL[b.type] - VAL[a.type]);
  }

  // One game: the board, every move played, and every position seen, for the draw rules.
  class Game {
    constructor(fen) { this.st = fromFen(fen); this.keys = [posKey(this.st)]; this.log = []; }
    get turn() { return this.st.turn ? "b" : "w"; }
    moves() { return legal(this.st); }
    play(mv) {
      const ms = this.moves();
      const m = ms.find(x => x.from === mv.from && x.to === mv.to && (!x.promo || x.promo === (mv.promo || Q)));
      if (!m) return null;
      const s = san(this.st, m, ms);
      make(this.st, m);
      this.keys.push(posKey(this.st));
      const rec = Object.assign({}, m, { san: s });
      this.log.push(rec);
      return rec;
    }
    undo() {
      if (!this.log.length || !this.st.hist.length) return null;
      unmake(this.st); this.keys.pop(); return this.log.pop();
    }
    fen() { return toFen(this.st); }
    status() {
      const ms = this.moves(), chk = inCheck(this.st);
      if (!ms.length) return chk ? { over: true, reason: "checkmate", winner: this.st.turn ? "w" : "b" } : { over: true, reason: "stalemate" };
      if (this.st.half >= 100) return { over: true, reason: "fifty" };
      if (insufficient(this.st)) return { over: true, reason: "material" };
      const k = this.keys[this.keys.length - 1];
      if (this.keys.filter(x => x === k).length >= 3) return { over: true, reason: "repetition" };
      return { over: false, check: chk };
    }
  }
  // perft counts every legal position a few moves deep. Matching the published counts proves the move rules right.
  function perft(st, d) { if (d === 0) return 1; let n = 0; for (const m of legal(st)) { make(st, m); n += perft(st, d - 1); unmake(st); } return n; }
  return { P, N, B, R, Q, K, VAL, NAME, IDX, fromFen, toFen, legal, make, unmake, san, inCheck, attacked, attackers, attacksFrom, hanging, bestMove, evaluate, Game, perft };
}

/* ---------- Words and lessons ---------- */
// Every technical word in the lessons is written [[key]] or [[key|label]] and turns into a tappable chip.
// Add a word here and it shows up in the glossary too.
const GLOSS = {
  file: ["File", "A column of squares that runs from White's side to Black's side. Files are named with letters, a to h."],
  rank: ["Rank", "A row of squares that runs across the board. Ranks are numbered 1 to 8, starting on White's side."],
  coordinate: ["Square name", "The file letter plus the rank number, like e4. Every square has its own name."],
  pawn: ["Pawn", "The smallest piece. It moves straight forward and captures one square diagonally forward. Worth 1 point."],
  knight: ["Knight", "Moves in an L shape: two squares one way, then one square to the side. It can jump over pieces. Worth 3 points."],
  bishop: ["Bishop", "Moves diagonally as far as it likes. It stays on one color all game. Worth 3 points."],
  rook: ["Rook", "Moves straight along files and ranks as far as it likes. Worth 5 points."],
  queen: ["Queen", "The strongest piece. Moves like a rook and a bishop together. Worth 9 points."],
  king: ["King", "Moves one square in any direction. If your king is checkmated, you lose the game."],
  capture: ["Capture", "Taking an enemy piece by moving onto its square. The taken piece leaves the board."],
  guard: ["Guard", "A piece guards another piece when it could capture on that square. If the guarded piece is taken, you can take back."],
  hanging: ["Free piece", "A piece that can be taken for free because nothing guards it. Also called a hanging piece."],
  value: ["Piece value", "Points that show how strong a piece is: pawn 1, knight 3, bishop 3, rook 5, queen 9."],
  trade: ["Trade", "When both players capture, one after the other. A good trade wins you more points than you lose."],
  promotion: ["Promotion", "When a pawn reaches the last rank, it turns into a queen, rook, bishop or knight."],
  check: ["Check", "The king is under attack. The player in check must get out of it on the very next move."],
  checkmate: ["Checkmate", "The king is in check and there is no way out. The game is over and the attacking side wins."],
  stalemate: ["Stalemate", "The player to move is not in check, but has no legal move. The game is a draw."],
  draw: ["Draw", "A game that ends with no winner."],
  legal: ["Legal move", "A move the rules allow. You may never make a move that leaves your own king in check."],
  castling: ["Castling", "A special move of the king and a rook. The king moves two squares toward the rook, and the rook jumps over to the square the king crossed."],
  enpassant: ["En passant", "French for \"in passing\". When a pawn moves two squares and lands beside an enemy pawn, that pawn may capture it as if it had moved one square. Only on the very next move."],
  tactic: ["Tactic", "A short trick that wins something, often in one to three moves."],
  fork: ["Fork", "One piece attacks two or more enemy pieces at the same time."],
  pin: ["Pin", "A piece cannot move, or should not, because a more valuable piece stands behind it."],
  skewer: ["Skewer", "A valuable piece is attacked and has to move away. Then the piece behind it can be captured."],
  opening: ["Opening", "The first moves of the game, when both players bring out their pieces."],
  center: ["Center", "The four middle squares: d4, e4, d5 and e5. Pieces in the center control more of the board."],
  development: ["Development", "Moving knights and bishops off their starting squares so they can join the game."],
  notation: ["Notation", "A short way to write chess moves, like Nf3 or e4. Also called algebraic notation."],
  repetition: ["Repetition", "If the same position happens three times with the same player to move, the game is a draw."],
  fifty: ["Fifty-move rule", "If both players make 50 moves in a row with no capture and no pawn move, the game is a draw."],
  material: ["Not enough pieces", "If neither side has enough pieces left to give checkmate, like king against king, the game is a draw."]
};

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const EMPTY_FEN = "8/8/8/8/8/8/8/8 w - - 0 1";
const fileSqs = f => [1, 2, 3, 4, 5, 6, 7, 8].map(r => f + r);
const rankSqs = r => "abcdefgh".split("").map(f => f + r);
// U+FE0E asks for the plain text chess glyph, not a colored emoji, on phones that have both.
const glyph = c => c + "\uFE0E";
const GLYPH = ["", "\u265F", "\u265E", "\u265D", "\u265C", "\u265B", "\u265A"].map(g => g ? glyph(g) : "");
const PN = ["", "pawn", "knight", "bishop", "rook", "queen", "king"];

const VALUES_HTML = '<div class="vals">' + [[1, "Pawn", "1"], [2, "Knight", "3"], [3, "Bishop", "3"], [4, "Rook", "5"], [5, "Queen", "9"], [6, "King", "No price"]]
  .map(([t, n, v]) => `<div class="val"><span class="glyph" aria-hidden="true">${GLYPH[t]}</span><span class="vn">${n}</span><span class="vv">${v}</span></div>`).join("") + "</div>";
const LETTERS_HTML = '<div class="vals">' + [[6, "K", "King"], [5, "Q", "Queen"], [4, "R", "Rook"], [3, "B", "Bishop"], [2, "N", "Knight"], [1, "none", "Pawn"]]
  .map(([t, l, n]) => `<div class="val"><span class="glyph" aria-hidden="true">${GLYPH[t]}</span><span class="vn">${n}</span><span class="vv mono">${l}</span></div>`).join("") + "</div>";
const SYMBOLS_HTML = '<div class="vals">' + [["x", "captures", "Bxf6"], ["+", "check", "Qh5+"], ["#", "checkmate", "Ra8#"], ["O-O", "castle king side", ""], ["O-O-O", "castle queen side", ""], ["=Q", "promote to a queen", "e8=Q"]]
  .map(([s, n, e]) => `<div class="val"><span class="vv mono sym">${s}</span><span class="vn">${n}</span><span class="vx mono">${e}</span></div>`).join("") + "</div>";

// A lesson is a list of steps. info: read and press Next. tap: find named squares. stars: collect stars with
// one piece (it may move as often as it likes). goal: play the right move; each goal has a test on the move played,
// an ok message, an optional fail message for a near miss, an optional computer reply, and a solution for "Show me".
const LESSONS = [
  { id: "board", title: "The board", sub: "Files, ranks and square names", steps: [
    { type: "info", fen: EMPTY_FEN, marks: fileSqs("e"), text: "A chessboard has 64 squares in 8 columns and 8 rows. The columns are called [[file|files]]. Each file has a letter, from a to h. The blue squares are the e-file." },
    { type: "info", fen: EMPTY_FEN, marks: rankSqs(4), text: "The rows are called [[rank|ranks]]. Each rank has a number, from 1 to 8. The blue squares are rank 4." },
    { type: "info", fen: EMPTY_FEN, marks: ["e4"], text: "Every square has a [[coordinate|name]]: first its file letter, then its rank number. The e-file and rank 4 meet at e4. The letters and numbers are carved into the wooden frame." },
    { type: "tap", fen: EMPTY_FEN, text: "Your turn. I name a square, you tap it on the board. Use the letters and numbers on the frame." },
    { type: "info", fen: START_FEN, marks: ["h1", "a8"], text: "This is how every game starts. White sits on ranks 1 and 2. Black sits on ranks 7 and 8. Tip: each player has a light square in the right-hand corner." }
  ] },
  { id: "pieces", title: "The pieces", sub: "How each piece moves", steps: [
    { type: "stars", piece: "R", fen: "8/8/8/8/8/8/8/3R4 w - - 0 1", stars: ["d6", "h6", "h2"], text: "The [[rook]] moves in straight lines: up, down, left or right, as far as it likes. Tap the rook, then tap a square to move." },
    { type: "stars", piece: "B", fen: "8/8/8/8/8/8/8/2B5 w - - 0 1", stars: ["e3", "g5", "d8"], text: "The [[bishop]] moves diagonally, as far as it likes. A bishop stays on the same color all game." },
    { type: "stars", piece: "Q", fen: "8/8/8/8/8/8/8/3Q4 w - - 0 1", stars: ["d5", "h5", "e8", "a4"], text: "The [[queen]] is the strongest piece. She moves like a rook and a bishop together: straight or diagonal." },
    { type: "stars", piece: "N", fen: "8/8/8/8/8/8/5PPP/6N1 w - - 0 1", stars: ["f3", "e5", "d7"], text: "The [[knight]] moves in an L shape: two squares one way, then one square to the side. It is the only piece that can jump over others." },
    { type: "stars", piece: "K", fen: "8/8/8/8/8/8/8/4K3 w - - 0 1", stars: ["d2", "d3", "e4"], text: "The [[king]] moves one square in any direction. He is slow, but he is the most important piece. If he gets trapped, the game is over." }
  ] },
  { id: "pawns", title: "Pawns", sub: "Moves, captures and promotion", steps: [
    { type: "stars", piece: "P", fen: "8/8/8/8/8/8/4P3/8 w - - 0 1", stars: ["e4", "e5", "e6"], text: "The [[pawn]] moves straight forward, one square at a time. On its very first move it may jump two squares. Pawns never move backward." },
    { type: "goal", fen: "8/8/8/2ppn3/3P4/8/8/8 w - - 0 1", text: "Pawns move forward, but they [[capture]] diagonally, one square ahead. Your pawn is blocked in front, but it can capture.",
      goals: [{ task: "Capture the knight.", solution: "d4e5", test: c => c.to === "e5", ok: "Nice! The pawn took the knight diagonally.", fail: c => c.to === "c5" ? "That capture works, but a knight is worth more than a pawn. Try the knight." : null }] },
    { type: "goal", fen: "8/1P6/8/8/8/8/8/8 w - - 0 1", text: "When a pawn reaches the far side of the board, it gets a [[promotion]]. It turns into a queen, rook, bishop or knight. Most players pick a queen.",
      goals: [{ task: "Move the pawn to the last rank.", solution: "b7b8", test: c => !!c.promo, ok: c => `Your pawn became a ${c.promoName}!` }] }
  ] },
  { id: "values", title: "Piece values", sub: "What each piece is worth", steps: [
    { type: "info", fen: "8/8/8/8/1PNBRQK1/8/8/8 w - - 0 1", text: "Each piece has a [[value]] in points. Points help you decide if a [[trade]] is good. The king has no price: if you lose him, you lose the game.", html: VALUES_HTML },
    { type: "goal", fen: "8/3r4/1n6/8/3Q4/8/8/8 w - - 0 1", text: "Your queen can take the knight or the rook. Nothing guards either one, so both are free.",
      goals: [{ task: "Take the piece worth more.", solution: "d4d7", test: c => c.to === "d7", ok: "Yes! The rook is worth 5. The knight is only worth 3.", fail: c => c.to === "b6" ? "A knight is worth 3, but the rook is worth 5. Try again." : null }] },
    { type: "goal", fen: "8/3p4/n3p3/8/2B5/8/8/8 w - - 0 1", text: "Your bishop could take the pawn on e6, but the pawn on d7 [[guard|guards]] it. You would give a bishop (3) for a pawn (1).",
      goals: [{ task: "Find the piece you can take for free.", solution: "c4a6", test: c => c.to === "a6", ok: "Free knight! Nothing could take your bishop back.", fail: c => c.to === "e6" ? "The d7 pawn would take your bishop back. That trade loses points. Try again." : null }] }
  ] },
  { id: "check", title: "Check and mate", sub: "Check, escaping, checkmate, stalemate", steps: [
    { type: "goal", fen: "4k3/8/8/8/8/8/8/R5K1 w - - 0 1", text: "When a king is attacked, it is in [[check]].",
      goals: [{ task: "Give check with your rook.", solution: "a1a8", test: c => c.check, ok: "Check! The black king is under attack.", fail: () => "That move does not attack the king. Line up your rook with the king." }] },
    { type: "goal", fen: "4k3/8/8/4r3/3B4/8/8/4K3 w - - 0 1", text: "Now your king is in check from the rook. You must get out of check right away. There are three ways: move the king, block the attack, or capture the attacker.",
      goals: [{ task: "Get out of check. Any of the three ways is fine.", solution: "d4e5", test: () => true, ok: c => c.type === 6 ? "You moved the king out of danger." : c.cap ? "You captured the attacker. That is often the best way!" : "You blocked the attack with your bishop." }] },
    { type: "goal", fen: "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", text: "[[checkmate|Checkmate]] means the king is in check and has no way out. Then the game is over.",
      goals: [{ task: "Find checkmate in one move.", solution: "a1a8", test: c => c.mate, ok: "Checkmate! The black pawns trap their own king." }] },
    { type: "goal", fen: "7k/8/6K1/8/8/8/8/5Q2 w - - 0 1", text: "[[stalemate|Stalemate]] happens when the player to move is not in check, but has no legal move. The game ends in a [[draw]], so nobody wins.",
      goals: [{ task: "Find checkmate. Careful: one queen move gives stalemate instead.", solution: "f1f8", test: c => c.mate, ok: "Checkmate! You avoided the stalemate trap.", fail: c => c.stalemate ? "That is stalemate! Black is not in check but cannot move, so it is a draw. Try again." : null }] }
  ] },
  { id: "special", title: "Special moves", sub: "Castling and en passant", steps: [
    { type: "goal", fen: "4k3/8/8/8/8/8/5PPP/R3K2R w KQ - 0 1", text: "[[castling|Castling]] is a special king move. The king moves two squares toward a rook, and the rook jumps over to the other side. It tucks your king away safely.",
      goals: [{ task: "Castle on the king side: tap the king, then tap g1.", solution: "e1g1", test: c => c.castleK, ok: "Castled! The king is safe behind its pawns.", fail: c => c.castleQ ? "That is castling on the queen side. Nice, but try the king side this time." : "Tap the king, then the square two steps toward the h1 rook." }] },
    { type: "info", fen: "4k3/8/8/8/8/8/5PPP/R3K2R w KQ - 0 1", text: "You may castle only when all of these are true: the king and that rook have not moved yet, no pieces stand between them, your king is not in check, and the king does not cross or land on an attacked square." },
    { type: "goal", fen: "4k3/8/8/8/8/8/5PPP/R3K2R w KQ - 0 1", text: "Castling works on the queen side too. The king goes two squares left to c1, and the rook lands on d1.",
      goals: [{ task: "Castle on the queen side.", solution: "e1c1", test: c => c.castleQ, ok: "Castled on the queen side (O-O-O)!", fail: () => "Tap the king, then tap c1." }] },
    { type: "goal", fen: "4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1", pre: ["d7d5"], text: "[[enpassant|En passant]] is a special pawn capture. Watch: Black moves a pawn two squares and lands right beside your pawn. You may capture it as if it had moved only one square.",
      goals: [{ task: "Capture en passant: move your pawn to d6. You only get this chance on the very next move.", solution: "e5d6", test: c => c.ep, ok: "En passant! Your pawn captured the pawn beside it." }] }
  ] },
  { id: "tactics", title: "Tactics", sub: "Fork, pin and skewer", steps: [
    { type: "goal", fen: "r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1", text: "A [[fork]] is one piece attacking two pieces at once. The other player can only save one of them. Knights are great at forks.",
      goals: [{ task: "Find the knight move that attacks the king and the rook.", solution: "d5c7", test: c => c.type === 2 && c.to === "c7", ok: "Fork! The king must step out of check.", reply: "e8d7" },
              { task: "The king moved away. Now take the rook.", solution: "c7a8", test: c => c.to === "a8", ok: "You won a rook, worth 5 points!" }] },
    { type: "goal", fen: "4k3/3n4/8/8/8/8/8/4KB2 w - - 0 1", text: "A [[pin]] is when a piece cannot move because a more important piece stands behind it.",
      goals: [{ task: "Pin the black knight to its king with your bishop.", solution: "f1b5", test: c => c.type === 3 && (c.to === "b5" || c.to === "a4"), ok: "Pinned! If the knight moves, its own king would be in check. So it is stuck." }] },
    { type: "goal", fen: "8/8/8/3k3q/8/8/8/R5K1 w - - 0 1", text: "A [[skewer]] is like a pin turned around. The more valuable piece is in front. When it moves away, you capture the piece behind it.",
      goals: [{ task: "Check the king with your rook, so the queen is behind it.", solution: "a1a5", test: c => c.to === "a5", ok: "Skewer! The king has to move.", reply: "d5e4" },
              { task: "Now take the queen.", solution: "a5h5", test: c => c.to === "h5", ok: "You won the queen, worth 9 points!" }] }
  ] },
  { id: "opening", title: "Good openings", sub: "Smart habits for the first moves", steps: [
    { type: "info", fen: START_FEN, marks: ["d4", "e4", "d5", "e5"], text: "The [[opening]] is the start of the game. Three habits help a lot: take the [[center]] with pawns, bring out knights and bishops early, which is called [[development]], and castle to keep your king safe. Try not to bring the queen out too early." },
    { type: "goal", fen: START_FEN, text: "Let us play a model opening together, one good habit at a time.",
      goals: [{ task: "Take the center: move the e-pawn two squares, to e4.", solution: "e2e4", test: c => c.san === "e4", ok: "Great start! Your pawn controls the center.", reply: "e7e5" },
              { task: "Black did the same. Develop your knight to f3. It attacks the pawn on e5.", solution: "g1f3", test: c => c.san === "Nf3", ok: "Good development, and it attacks e5!", reply: "b8c6" },
              { task: "Black guards e5 with a knight. Develop your bishop to c4, aiming at the center.", solution: "f1c4", test: c => c.san === "Bc4", ok: "Two pieces out already.", reply: "g8f6" },
              { task: "Nothing stands between your king and rook now. Castle!", solution: "e1g1", test: c => c.castleK, ok: "A perfect opening: center, knight, bishop, castle." }] }
  ] },
  { id: "notation", title: "Chess notation", sub: "How to read and write moves", steps: [
    { type: "info", fen: START_FEN, text: "Players write moves in [[notation]]. Each piece has a letter, then comes the square it moves to. Pawns have no letter. So Nf3 means knight to f3, and e4 means a pawn to e4. N is for knight, because K is taken by the king.", html: LETTERS_HTML },
    { type: "info", fen: START_FEN, text: "A few symbols add more detail:", html: SYMBOLS_HTML },
    { type: "goal", fen: START_FEN, text: "Now read the moves and play them. Each one is written in notation.",
      goals: [{ task: "Play Nf3.", solution: "g1f3", test: c => c.san === "Nf3", ok: "Right, knight to f3. Black played d5.", reply: "d7d5" },
              { task: "Play d4.", solution: "d2d4", test: c => c.san === "d4", ok: "Pawn to d4. Black played Nf6.", reply: "g8f6" },
              { task: "Play Bg5.", solution: "c1g5", test: c => c.san === "Bg5", ok: "Bishop to g5. Black played e6.", reply: "e7e6" },
              { task: "Play Bxf6. The x means capture.", solution: "g5f6", test: c => c.san === "Bxf6", ok: "Bishop takes f6! Black answers Qxf6.", reply: "d8f6" }],
      done: "You read every move. Now you can follow any chess book!" }
  ] }
];

/* ---------- Setup ---------- */
const E = ENGINE(LEVELS);
const $ = s => document.querySelector(s);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SPEED = MOTION * (reduceMotion ? 0.35 : 1);   // reduced motion keeps moves visible but quick, with no idle spin
const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uci = s => ({ from: E.IDX(s.slice(0, 2)), to: E.IDX(s.slice(2, 4)) });
const wait = ms => new Promise(r => setTimeout(r, ms * SPEED));

// Everything is kept in one object under SAVE: finished lessons, sound, and the last level and side picked.
const saved = { done: {}, sound: true, tip: false, level: "casual", side: "w" };
try {
  const d = JSON.parse(localStorage.getItem(SAVE));
  if (d && typeof d === "object") {
    if (d.done && typeof d.done === "object") saved.done = d.done;
    if (typeof d.sound === "boolean") saved.sound = d.sound;
    if (typeof d.tip === "boolean") saved.tip = d.tip;
    if (d.level in LEVEL_NOTE) saved.level = d.level;
    if (["w", "b", "r"].includes(d.side)) saved.side = d.side;
  }
} catch (e) { /* storage blocked or unreadable: start fresh and play without saving */ }
function save() {
  try { localStorage.setItem(SAVE, JSON.stringify(saved)); } catch (e) { /* storage blocked: progress lasts until the tab closes */ }
}

/* ---------- Sound ---------- */
// Small synthesized sounds, so there are no files to load. Browsers only allow audio after a press,
// so nothing is created until the first key press or tap.
const Sound = {
  ctx: null, out: null, noise: null, on: saved.sound,
  init() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const comp = this.ctx.createDynamicsCompressor();
      this.out = this.ctx.createGain(); this.out.gain.value = 0.7;
      this.out.connect(comp); comp.connect(this.ctx.destination);
      // A short burst of fading noise, shaped by a filter, is what makes a move sound like wood on wood.
      const len = Math.floor(this.ctx.sampleRate * 0.25), buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      this.noise = buf;
    } catch (e) { this.ctx = null; }
  },
  tone(freq, dur, o = {}) {
    if (!this.on || !this.ctx) return;
    const c = this.ctx, t = c.currentTime + (o.delay || 0), os = c.createOscillator(), g = c.createGain();
    os.type = o.type || "sine";
    os.frequency.setValueAtTime(freq, t);
    if (o.slide) os.frequency.exponentialRampToValueAtTime(freq * o.slide, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(o.gain || 0.1, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    os.connect(g); g.connect(this.out); os.start(t); os.stop(t + dur + 0.03);
  },
  knock(freq, gain, delay = 0) {
    if (!this.on || !this.ctx || !this.noise) return;
    const c = this.ctx, t = c.currentTime + delay, src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = this.noise; f.type = "bandpass"; f.frequency.value = freq; f.Q.value = 2.2;
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    src.connect(f); f.connect(g); g.connect(this.out); src.start(t); src.stop(t + 0.15);
  },
  move() { this.knock(1500, 0.5); this.tone(180, 0.1, { gain: 0.12 }); },
  capture() { this.knock(1100, 0.55); this.knock(1700, 0.35, 0.05); this.tone(140, 0.14, { gain: 0.14 }); },
  check() { this.tone(880, 0.28, { gain: 0.06, type: "triangle" }); this.tone(1318, 0.4, { gain: 0.05, delay: 0.09 }); },
  star(n) { const f = 784 * Math.pow(1.12246, n || 0); this.tone(f, 0.2, { gain: 0.07, type: "triangle" }); this.tone(f * 2, 0.32, { gain: 0.03, delay: 0.05 }); },
  good() { this.tone(660, 0.18, { gain: 0.06, type: "triangle" }); this.tone(990, 0.3, { gain: 0.05, type: "triangle", delay: 0.08 }); },
  success() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.4, { gain: 0.06, type: "triangle", delay: i * 0.085 })); },
  error() { this.tone(240, 0.18, { gain: 0.07, slide: 0.75 }); },
  tap() { this.tone(1400, 0.05, { gain: 0.03 }); },
  promote() { [660, 880, 1100, 1320, 1760].forEach((f, i) => this.tone(f, 0.3, { gain: 0.045, delay: i * 0.05 })); },
  sad() { [392, 330, 262].forEach((f, i) => this.tone(f, 0.4, { gain: 0.05, type: "triangle", delay: i * 0.14 })); },
  calm() { [523, 523].forEach((f, i) => this.tone(f, 0.35, { gain: 0.05, type: "triangle", delay: i * 0.18 })); }
};

/* ---------- Scene ---------- */
const canvas = $("#gl"), stageEl = $("#stage");
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
} catch (e) { renderer = null; }
if (!renderer) {   // no WebGL: say so plainly instead of showing a blank board
  $("#startBtn").hidden = true;
  $("#noGL").hidden = false;
  return;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));   // above 2x the extra pixels cost more than they show
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x000000, 0);   // transparent, so the cream page is the background
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
const ANISO = renderer.capabilities.getMaxAnisotropy();

// Soft studio light for the varnish to reflect: a warm gradient dome with a few bright panels, baked once.
(function studio() {
  const pm = new THREE.PMREMGenerator(renderer), es = new THREE.Scene();
  const g = new THREE.SphereGeometry(30, 32, 16), pos = g.attributes.position, cols = [];
  for (let i = 0; i < pos.count; i++) { const t = (pos.getY(i) / 30 + 1) / 2; cols.push(0.30 + 0.70 * t, 0.27 + 0.69 * t, 0.24 + 0.68 * t); }
  g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  es.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true })));
  const panel = (w, h, x, y, z, k) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k * 0.97, k * 0.92), side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.lookAt(0, 0, 0); es.add(m);
  };
  panel(12, 7, 8, 16, 10, 3); panel(10, 6, -13, 8, -6, 1.1); panel(9, 3, 0, 5, -18, 0.9);
  scene.environment = pm.fromScene(es, 0.035).texture;
  pm.dispose();
})();

scene.add(new THREE.HemisphereLight(0xfff8ee, 0xb8a488, 0.32));
const sun = new THREE.DirectionalLight(0xfff4e6, 1.45);
sun.position.set(5, 12, 7); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 40 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.025;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xe2ebff, 0.22);   // a cool fill from the other side keeps black pieces from going flat
fill.position.set(-7, 6, -5);
scene.add(fill);

/*__ART__*/

scene.add(buildBoard());

/* ---------- Marks on squares ---------- */
// Marks are flat textured tiles laid just above the board, drawn on top of it so they never flicker.
function shapeTex(draw) { const c = document.createElement("canvas"); c.width = c.height = 128; draw(c.getContext("2d")); return new THREE.CanvasTexture(c); }
const roundRect = (x, a, b, w, h, r) => { x.beginPath(); if (x.roundRect) x.roundRect(a, b, w, h, r); else x.rect(a, b, w, h); };
const TEX = {
  tile: shapeTex(x => { x.fillStyle = "#fff"; roundRect(x, 5, 5, 118, 118, 16); x.fill(); }),
  frame: shapeTex(x => { x.strokeStyle = "#fff"; x.lineWidth = 10; roundRect(x, 9, 9, 110, 110, 18); x.stroke(); }),
  dot: shapeTex(x => { x.fillStyle = "#fff"; x.beginPath(); x.arc(64, 64, 17, 0, 7); x.fill(); }),
  ring: shapeTex(x => { x.strokeStyle = "#fff"; x.lineWidth = 9; x.beginPath(); x.arc(64, 64, 52, 0, 7); x.stroke(); }),
  glow: shapeTex(x => { const g = x.createRadialGradient(64, 64, 6, 64, 64, 64); g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.55, "rgba(255,255,255,0.55)"); g.addColorStop(1, "rgba(255,255,255,0)"); x.fillStyle = g; x.fillRect(0, 0, 128, 128); })
};
const markMat = (tex, color, opacity) => new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, opacity, depthWrite: false, toneMapped: false });
const MAT = {
  last: markMat(TEX.tile, 0xF6D365, 0.42), sel: markMat(TEX.tile, 0x7DD3A0, 0.62), dot: markMat(TEX.dot, 0x1D1D1F, 0.32), ring: markMat(TEX.ring, 0x1D1D1F, 0.3),
  hint: markMat(TEX.tile, 0x2F8BFF, 0.5), mark: markMat(TEX.tile, 0x3D8EF0, 0.5), check: markMat(TEX.glow, 0xFF3B30, 0.85),
  good: markMat(TEX.tile, 0x34C759, 0.7), bad: markMat(TEX.tile, 0xFF453A, 0.65), cursor: markMat(TEX.frame, 0x0071E3, 0.95)
};
const TILE = new THREE.PlaneGeometry(1, 1);
const marksG = new THREE.Group(); marksG.position.y = 0.004; scene.add(marksG);
const fxG = new THREE.Group(); fxG.position.y = 0.006; scene.add(fxG);
const sqXZ = s => ({ x: (s & 7) - 3.5, z: 3.5 - (s >> 3) });
function tileMesh(sq, mat, size = 1) {
  const m = new THREE.Mesh(TILE, mat); m.rotation.x = -Math.PI / 2;
  const p = sqXZ(sq); m.position.set(p.x, 0, p.z); m.scale.setScalar(size); m.renderOrder = 2;
  return m;
}

/* ---------- Effects ---------- */
const starsG = new THREE.Group(); scene.add(starsG);
let stars = [];
function setStars(list) {
  for (const s of stars) starsG.remove(s.mesh);
  stars = (list || []).map((name, i) => {
    const sq = E.IDX(name), p = sqXZ(sq), m = new THREE.Mesh(STAR_GEO, STAR_MAT);
    m.castShadow = true; m.position.set(p.x, 0.36, p.z); m.scale.setScalar(0.001); starsG.add(m);
    tween(380, t => m.scale.setScalar(Math.max(0.001, t)), ease.back, null, i * 90);
    return { sq, mesh: m, ph: i * 1.3 };
  });
}
// Little wooden chips and gold flakes: they fly up, fall, bounce once on the board and fade.
const bitGeo = new THREE.BoxGeometry(0.055, 0.055, 0.055), bitMats = {}, bits = [];
function burst(pos, color, n, spd) {
  const mat = bitMats[color] || (bitMats[color] = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: color === 0xF2B630 ? 0.5 : 0 }));
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(bitGeo, mat); m.position.copy(pos); m.position.y += 0.2;
    const a = Math.random() * Math.PI * 2, s = (0.6 + Math.random()) * spd;
    scene.add(m);
    bits.push({ m, v: new THREE.Vector3(Math.cos(a) * s, 1.6 + Math.random() * 2.2, Math.sin(a) * s), r: new THREE.Vector3(Math.random() * 8, Math.random() * 8, 0), life: 0, max: 0.65 + Math.random() * 0.4 });
  }
}
function ringFx(pos, color) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.38, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(pos.x, 0.01, pos.z); fxG.add(m);
  tween(650, t => { m.scale.setScalar(0.6 + t * 1.8); m.material.opacity = 0.9 * (1 - t); }, ease.out).then(() => { fxG.remove(m); m.geometry.dispose(); m.material.dispose(); });
}
function flash(sq, kind) {
  const m = tileMesh(sq, MAT[kind].clone(), 0.96); fxG.add(m);
  tween(750, t => { m.material.opacity = MAT[kind].opacity * (1 - t); }, ease.lin).then(() => { fxG.remove(m); m.material.dispose(); });
}
function confetti() {
  const cols = [0xF2B630, 0x3D8EF0, 0x34C759, 0xFF6B57, 0xECD8B3];
  for (let i = 0; i < 5; i++) setTimeout(() => burst(new THREE.Vector3((Math.random() - 0.5) * 5, 0.2, (Math.random() - 0.5) * 5), cols[i], 16, 1.6), i * 120);
}

/* ---------- Tweens ---------- */
// One list of running animations, stepped from the render loop. A key lets a new animation of a piece
// replace an older one, so a piece never gets pulled two ways at once.
const ease = {
  inOut: t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  out: t => 1 - Math.pow(1 - t, 3),
  lin: t => t,
  back: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
};
const tweens = [];
function tween(dur, fn, e, key, delay) {
  dur = Math.max(1, dur * SPEED);
  if (key) for (const tw of tweens) if (tw.key === key && !tw.dead) { tw.dead = true; tw.res(); }
  return new Promise(res => tweens.push({ t0: performance.now() + (delay || 0) * SPEED, dur, fn, e: e || ease.inOut, res, key }));
}
function stepTweens(now) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    if (tw.dead) { tweens.splice(i, 1); continue; }
    if (now < tw.t0) continue;
    const p = Math.min(1, (now - tw.t0) / tw.dur);
    tw.fn(tw.e(p), p);
    if (p >= 1) { tweens.splice(i, 1); tw.res(); }
  }
}

/* ---------- Pieces on the board ---------- */
// Every piece on screen has a slot: "s12" is a square, "tw3" the fourth white piece in the captured row
// beside the board. Pieces glide between slots, so captures, undo and new lessons all animate the same way.
const piecesG = new THREE.Group(); scene.add(piecesG);
let recs = [];
const bySlot = new Map();
function slotPos(slot) {
  if (slot[0] === "s") { const p = sqXZ(+slot.slice(1)); return new THREE.Vector3(p.x, 0, p.z); }
  const c = slot[1], i = +slot.slice(2), col = Math.floor(i / 8), row = i % 8;
  return c === "w" ? new THREE.Vector3(-(5.2 + col * 0.6), -0.38, -3.5 + row * 0.56 + col * 0.28) : new THREE.Vector3(5.2 + col * 0.6, -0.38, 3.5 - row * 0.56 - col * 0.28);
}
const slotScale = slot => slot[0] === "s" ? 1 : 0.6;
function newRec(type, color, slot, visible) {
  const obj = makePiece(type, color), rec = { obj, type, color, slot };
  obj.userData.rec = rec; obj.position.copy(slotPos(slot)); obj.scale.setScalar(visible ? slotScale(slot) : 0.001);
  piecesG.add(obj); recs.push(rec); bySlot.set(slot, rec);
  return rec;
}
function dropRec(rec, animate) {
  recs = recs.filter(r => r !== rec);
  if (bySlot.get(rec.slot) === rec) bySlot.delete(rec.slot);
  if (!animate) { piecesG.remove(rec.obj); return; }
  const s0 = rec.obj.scale.x, y0 = rec.obj.position.y;
  tween(260, t => { rec.obj.scale.setScalar(Math.max(0.001, s0 * (1 - t))); rec.obj.position.y = y0 + t * 0.3; }, ease.inOut, rec).then(() => piecesG.remove(rec.obj));
}
function targetsFor(game) {
  const t = [], b = game.st.b;
  for (let s = 0; s < 64; s++) { const p = b[s]; if (p) t.push({ slot: "s" + s, type: p & 7, color: p & 8 ? "b" : "w" }); }
  const n = { w: 0, b: 0 };
  for (const m of game.log) if (m.cap) { const c = m.cap & 8 ? "b" : "w"; t.push({ slot: "t" + c + (n[c]++), type: m.cap & 7, color: c }); }
  return t;
}
function glide(rec, dur) {
  const from = rec.obj.position.clone(), to = slotPos(rec.slot), s0 = rec.obj.scale.x, s1 = slotScale(rec.slot), rx = rec.obj.rotation.x, rz = rec.obj.rotation.z;
  const h = from.distanceTo(to) > 0.01 ? 0.22 : 0;
  return tween(dur || 440, t => { rec.obj.position.lerpVectors(from, to, t); rec.obj.position.y += h * Math.sin(Math.PI * t); rec.obj.scale.setScalar(s0 + (s1 - s0) * t); rec.obj.rotation.x = rx * (1 - t); rec.obj.rotation.z = rz * (1 - t); }, ease.inOut, rec);
}
// Make the pieces on screen match a game. Pieces already in the right place stay, the rest glide from wherever
// the same kind of piece is nearest, and only the leftovers appear or vanish.
function syncPieces(game, animate) {
  const targets = targetsFor(game), pool = recs.slice(), pairs = [], left = [], fresh = [];
  for (const t of targets) {
    const i = pool.findIndex(r => r.slot === t.slot && r.type === t.type && r.color === t.color);
    if (i >= 0) { pairs.push([pool[i], t]); pool.splice(i, 1); } else left.push(t);
  }
  for (const t of left) {
    const tp = slotPos(t.slot); let bi = -1, bd = 1e9;
    pool.forEach((r, i) => { if (r.type === t.type && r.color === t.color) { const d = r.obj.position.distanceTo(tp); if (d < bd) { bd = d; bi = i; } } });
    if (bi >= 0) { pairs.push([pool[bi], t]); pool.splice(bi, 1); } else fresh.push(t);
  }
  for (const r of pool) dropRec(r, animate);
  bySlot.clear();
  for (const [r, t] of pairs) {
    r.slot = t.slot; bySlot.set(t.slot, r);
    const atRest = r.obj.position.distanceTo(slotPos(t.slot)) < 0.001 && Math.abs(r.obj.scale.x - slotScale(t.slot)) < 0.001;
    if (!atRest) {
      if (animate) glide(r);
      else { r.obj.position.copy(slotPos(t.slot)); r.obj.scale.setScalar(slotScale(t.slot)); r.obj.rotation.set(0, 0, 0); }
    }
  }
  fresh.forEach((t, i) => { const r = newRec(t.type, t.color, t.slot, !animate); if (animate) { const s = slotScale(t.slot); tween(380, k => r.obj.scale.setScalar(Math.max(0.001, s * k)), ease.back, r, i * 18); } });
  lifted = null;
}
let lifted = null;
function setLift(sq) {   // a picked-up piece hovers a little, so it is clear which one will move
  const rec = sq == null ? null : bySlot.get("s" + sq);
  if (lifted && lifted !== rec) { const o = lifted.obj, y0 = o.position.y, yb = slotPos(lifted.slot).y; tween(160, t => o.position.y = y0 + (yb - y0) * t, ease.out, lifted); }
  if (rec && rec !== lifted) { const o = rec.obj, y0 = o.position.y; tween(200, t => o.position.y = y0 + (0.14 - y0) * t, ease.out, rec); }
  lifted = rec;
}
function squash(rec) {   // a tiny squash on landing sells the weight of the wood
  const o = rec.obj, s = slotScale(rec.slot);
  return tween(200, t => { const k = Math.sin(Math.PI * t) * 0.07; o.scale.set(s * (1 + k * 0.5), s * (1 - k), s * (1 + k * 0.5)); }, ease.lin, rec);
}

async function animMove(m) {
  const color = m.piece & 8 ? "b" : "w";
  const rec = bySlot.get("s" + m.from);
  if (!rec) { syncPieces(curGame(), true); await wait(450); return; }
  lifted = null;
  let capRec = null;
  if (m.cap) {
    const cs = (m.flag & 2) ? m.to + (color === "w" ? -8 : 8) : m.to;   // en passant takes the pawn beside, not the one on the target square
    capRec = bySlot.get("s" + cs) || null;
    if (capRec) bySlot.delete("s" + cs);
  }
  bySlot.delete("s" + m.from); rec.slot = "s" + m.to; bySlot.set(rec.slot, rec);
  if (capRec) { let i = 0; while (bySlot.has("t" + capRec.color + i)) i++; capRec.slot = "t" + capRec.color + i; bySlot.set(capRec.slot, capRec); }
  const from = rec.obj.position.clone(), to = slotPos(rec.slot), d = Math.hypot(to.x - from.x, to.z - from.z);
  // Knights hop high because they jump over pieces. Others lift just enough to clear the board, higher for longer trips.
  const knight = rec.type === 2, h = knight ? 0.75 : Math.min(0.8, 0.34 + d * 0.05), dur = (knight ? 540 : 380) + d * 40;
  const dx = d ? (to.x - from.x) / d : 0, dz = d ? (to.z - from.z) / d : 0;
  const main = tween(dur, t => {
    rec.obj.position.lerpVectors(from, to, t);
    rec.obj.position.y = from.y * (1 - t) + h * Math.sin(Math.PI * t);
    const tilt = 0.17 * Math.sin(Math.PI * t);   // lean into the direction of travel
    rec.obj.rotation.x = dz * tilt; rec.obj.rotation.z = -dx * tilt;
  }, ease.inOut, rec);
  if (capRec) setTimeout(() => captureFly(capRec), dur * 0.66 * SPEED);   // knocked away just before the attacker lands
  if (m.flag & 12) {   // castling: the rook jumps over the king
    const k = !!(m.flag & 4), row = color === "w" ? 0 : 56, rf = row + (k ? 7 : 0), rt = row + (k ? 5 : 3);
    const rr = bySlot.get("s" + rf);
    if (rr) {
      bySlot.delete("s" + rf); rr.slot = "s" + rt; bySlot.set(rr.slot, rr);
      const f2 = rr.obj.position.clone(), t2 = slotPos(rr.slot);
      tween(dur * 0.9, t => { rr.obj.position.lerpVectors(f2, t2, t); rr.obj.position.y = 0.55 * Math.sin(Math.PI * t); }, ease.inOut, rr, dur * 0.25);
    }
  }
  await main;
  rec.obj.rotation.set(0, 0, 0); rec.obj.position.copy(to);
  if (m.cap) Sound.capture(); else Sound.move();
  squash(rec);
  if (m.flag & 12) await wait(250);
  if (m.promo) await promoteAnim(rec, m.promo);
}
function captureFly(rec) {
  const from = rec.obj.position.clone(), to = slotPos(rec.slot), s1 = slotScale(rec.slot);
  burst(from, rec.color === "w" ? 0xE6CFA5 : 0x3A2A20, 12, 1.3);
  tween(620, t => {
    rec.obj.position.lerpVectors(from, to, t);
    rec.obj.position.y = from.y + (to.y - from.y) * t + 1.1 * Math.sin(Math.PI * t);
    rec.obj.scale.setScalar(1 + (s1 - 1) * t);
    rec.obj.rotation.z = Math.sin(Math.PI * t) * 0.9; rec.obj.rotation.y = t * Math.PI * 2;
  }, ease.inOut, rec).then(() => { rec.obj.rotation.set(0, 0, 0); });
}
async function promoteAnim(rec, type) {   // the pawn spins away and the new piece spins in, with a gold ring and flakes
  const pos = rec.obj.position.clone();
  Sound.promote(); ringFx(pos, 0xF2B630);
  await tween(280, t => { rec.obj.rotation.y = t * Math.PI * 2; rec.obj.scale.setScalar(Math.max(0.001, 1 - t)); rec.obj.position.y = t * 0.35; }, ease.inOut, rec);
  piecesG.remove(rec.obj); recs = recs.filter(r => r !== rec);
  const nr = newRec(type, rec.color, rec.slot, false);
  burst(pos, 0xF2B630, 14, 1.2);
  await tween(460, t => { nr.obj.scale.setScalar(Math.max(0.001, t)); nr.obj.rotation.y = (1 - t) * Math.PI * 2; }, ease.back, nr);
}

/* ---------- Camera ---------- */
// The camera sits on a sphere around the board: theta turns it around, phi tilts it, zoom moves it closer.
// The t values are where it is heading; each frame it eases part of the way, so every change feels smooth.
const cam = { theta: 0.6, phi: 0.95, zoom: 1.06, tTheta: 0.6, tPhi: 0.95, tZoom: 1.06, base: 16, idle: true };
function fit() {   // back the camera off until the whole board fits, whatever the shape of the screen
  const w = stageEl.clientWidth, h = stageEl.clientHeight; if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  const v = camera.fov * Math.PI / 180, hf = 2 * Math.atan(Math.tan(v / 2) * camera.aspect);
  const span = camera.aspect < 0.95 ? 10 : 12.4;   // leave room for the captured pieces beside the board on wide screens
  cam.base = Math.max((span / 2) / Math.tan(hf / 2), (9.6 / 2) / Math.tan(v / 2));
}
new ResizeObserver(fit).observe(stageEl);
// Turn to a side's view the short way round, from wherever the camera is now.
function viewFor(color) { const b = color === "b" ? Math.PI : 0; cam.tTheta = b + Math.PI * 2 * Math.round((cam.tTheta - b) / (Math.PI * 2)); cam.tPhi = CAMERA.tilt; cam.tZoom = 1; cam.idle = false; }

/* ---------- Pointer and touch ---------- */
// One finger or the mouse: a tap picks a square, a drag turns and tilts the board. Two fingers or the wheel zoom.
const ptrs = new Map(); let drag = null, pinch0 = 0, zoom0 = 1;
const dist2 = () => { const a = [...ptrs.values()]; return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); };
canvas.addEventListener("pointerdown", e => {
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* some browsers refuse capture for pens; dragging still works */ }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (kb.on) { kb.on = false; drawMarks(); }   // touching the board hides the keyboard outline
  if (ptrs.size === 1) drag = { x: e.clientX, y: e.clientY, moved: false, th: cam.tTheta, ph: cam.tPhi };
  else if (ptrs.size === 2) { if (drag) drag.moved = true; pinch0 = dist2(); zoom0 = cam.tZoom; }
});
canvas.addEventListener("pointermove", e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) { cam.tZoom = clamp(zoom0 * pinch0 / Math.max(1, dist2()), CAMERA.zoomMin, CAMERA.zoomMax); return; }
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) > 7) drag.moved = true;   // a few pixels of wobble still count as a tap
  if (drag.moved) { cam.idle = false; cam.tTheta = drag.th - dx * 0.0065; cam.tPhi = clamp(drag.ph - dy * 0.0055, 0.14, 1.3); hideTip(); }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  if (drag && !drag.moved && ptrs.size === 1 && e.type === "pointerup") onTap(e);
  ptrs.delete(e.pointerId);
  if (!ptrs.size) drag = null;
}
canvas.addEventListener("pointerup", endPtr);
canvas.addEventListener("pointercancel", endPtr);
canvas.addEventListener("wheel", e => { e.preventDefault(); cam.tZoom = clamp(cam.tZoom * Math.exp(e.deltaY * 0.0012), CAMERA.zoomMin, CAMERA.zoomMax); }, { passive: false });
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitP = new THREE.Vector3();
// Pieces are hit first, so tapping the top of a tall piece picks its square even when the ray would land behind it.
function pick(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(recs.filter(x => x.slot[0] === "s").map(x => x.obj), true);
  for (const h of hits) { let o = h.object; while (o && !o.userData.rec) o = o.parent; if (o) return +o.userData.rec.slot.slice(1); }
  if (ray.ray.intersectPlane(plane, hitP)) { const f = Math.floor(hitP.x + 4), rk = Math.floor(4 - hitP.z); if (f >= 0 && f < 8 && rk >= 0 && rk < 8) return rk * 8 + f; }
  return null;
}
function onTap(e) {
  Sound.init();
  const sq = pick(e);
  if (sq == null) { if (selected != null) { selected = null; setLift(null); drawMarks(); } return; }
  tapSquare(sq);
}
function tapSquare(sq) {
  if (mode === "lesson") lessonTap(sq);
  else if (mode === "game") gameTap(sq);
}
const tipEl = $("#dragTip");
function showTip() { if (saved.tip || reduceMotion) return; tipEl.hidden = false; setTimeout(hideTip, 6000); }
function hideTip() { if (tipEl.hidden) return; tipEl.hidden = true; saved.tip = true; save(); }

/* ---------- Keyboard ---------- */
// Arrows move a blue outline over the squares and Enter or Space taps the square under it. The arrows follow the
// screen, so "up" always means away from you, whichever way the board has been turned.
const kb = { on: false, sq: 12 };
const boardKeys = () => mode === "game" || (mode === "lesson" && L.step && L.step.type !== "info");
function kbStep(sx, sy) {
  const q = ((Math.round(cam.theta / (Math.PI / 2)) % 4) + 4) % 4;   // which quarter turn the camera is nearest to
  const [df, dr] = [[sx, sy], [-sy, sx], [-sx, -sy], [sy, -sx]][q];
  const f = clamp((kb.sq & 7) + df, 0, 7), r = clamp((kb.sq >> 3) + dr, 0, 7);
  kb.sq = r * 8 + f;
}
function kbStart() {   // start the outline on a piece that can move, so the first Enter does something useful
  const g = curGame();
  if (selected != null) kb.sq = selected;
  else if (g) { const ms = g.moves(); if (ms.length && !(g.st.b[kb.sq] && (g.st.b[kb.sq] & 8) === g.st.turn)) kb.sq = ms[0].from; }
}
document.addEventListener("keydown", e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const typing = e.target.closest && e.target.closest("input, textarea");
  if (typing) return;
  const onButton = e.target.closest && e.target.closest("button");
  if (e.code === "KeyM") { if (!e.repeat) toggleSound(); return; }   // M mutes or unmutes anywhere
  if (e.key === "Escape") { backOut(); return; }
  if (mode === "start") {
    if (e.key === "Enter" && !onButton) { e.preventDefault(); start(); }
    return;
  }
  const dir = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
  if (dir && boardKeys() && $("#promo").hidden) {
    e.preventDefault();
    Sound.init();
    if (onButton) onButton.blur();   // hand Enter to the board, not to the last button clicked
    if (!kb.on) { kb.on = true; kbStart(); } else kbStep(dir[0], dir[1]);
    drawMarks();
    return;
  }
  if ((e.key === "Enter" || e.key === " ") && kb.on && !onButton && boardKeys() && $("#promo").hidden) {
    e.preventDefault();
    tapSquare(kb.sq);
  }
});
function backOut() {   // there is no clock in chess, so Esc never pauses: it backs out of whatever is open
  if (!$("#promo").hidden) { $("#promo").click(); return; }
  if (!pop.hidden) { pop.hidden = true; return; }
  if (selected != null) { selected = null; setLift(null); drawMarks(); return; }
  if (kb.on) { kb.on = false; drawMarks(); }
}

/* ---------- Marks ---------- */
let selected = null, lastMove = null, hintMv = null, lessonMarks = [];
const hintMeshes = [];
function curGame() { return mode === "lesson" ? L.game : mode === "game" ? G.game : idleGame; }
function drawMarks() {
  while (marksG.children.length) marksG.remove(marksG.children[0]);
  hintMeshes.length = 0;
  const g = curGame();
  for (const s of lessonMarks) marksG.add(tileMesh(s, MAT.mark, 0.96));
  if (lastMove) { marksG.add(tileMesh(lastMove.from, MAT.last, 0.96)); marksG.add(tileMesh(lastMove.to, MAT.last, 0.96)); }
  if (g && (mode === "game" || mode === "lesson") && E.inCheck(g.st)) { const k = g.st.king[g.st.turn >> 3]; if (k >= 0) marksG.add(tileMesh(k, MAT.check, 1.25)); }
  if (hintMv) for (const s of [hintMv.from, hintMv.to]) { const m = tileMesh(s, MAT.hint, 0.96); hintMeshes.push(m); marksG.add(m); }
  if (selected != null && g) {
    marksG.add(tileMesh(selected, MAT.sel, 0.96));
    const seen = new Set();
    for (const m of g.moves()) if (m.from === selected && !seen.has(m.to)) {
      seen.add(m.to);
      // A dot shows an empty square to move to, a ring a piece you can take.
      marksG.add(g.st.b[m.to] || (m.flag & 2) ? tileMesh(m.to, MAT.ring, 0.92) : tileMesh(m.to, MAT.dot, 0.9));
    }
  }
  if (kb.on && boardKeys()) marksG.add(tileMesh(kb.sq, MAT.cursor, 1));
}

/* ---------- Picking and moving ---------- */
async function boardSelect(game, sq, canPick, onMove) {
  const moves = game.moves();
  if (selected != null) {
    const opts = moves.filter(m => m.from === selected && m.to === sq);
    if (opts.length) {
      let promo = 0;
      if (opts[0].promo) { promo = await askPromo(); if (!promo) return; }
      const from = selected; selected = null; hintMv = null;
      onMove({ from, to: sq, promo });
      return;
    }
  }
  const p = game.st.b[sq];
  if (p && (p & 8) === game.st.turn && canPick(sq, p)) {
    if (selected === sq) { selected = null; setLift(null); drawMarks(); return; }
    selected = sq; Sound.tap(); setLift(sq); drawMarks();
    if (!moves.some(m => m.from === sq)) onNoMoves(game);
    return;
  }
  selected = null; setLift(null); drawMarks();
}
function onNoMoves(game) {
  const msg = E.inCheck(game.st) ? "Your king is in check. This piece cannot help, so pick another one." : "That piece has no moves right now.";
  if (mode === "lesson") { L.fb = { kind: "bad", text: msg }; renderPanel(); } else if (mode === "game") { G.note = msg; renderPanel(); }
  say(msg);
}
function askPromo() {
  return new Promise(res => {
    const box = $("#promo"), opts = $("#promoOpts"), back = document.activeElement;
    opts.innerHTML = [5, 4, 3, 2].map(t => `<button type="button" data-t="${t}"><span aria-hidden="true">${GLYPH[t]}</span>${cap1(PN[t])}</button>`).join("");
    box.hidden = false;
    const done = v => { box.hidden = true; box.onclick = null; if (back && back.focus) back.focus({ preventScroll: true }); res(v); };
    box.onclick = e => { const b = e.target.closest("button[data-t]"); if (b) done(+b.dataset.t); else if (e.target === box) done(0); };
    opts.querySelector("button").focus();
  });
}

/* ---------- Words as chips ---------- */
function rich(t) {
  return (t || "").replace(/\[\[([a-z]+)(?:\|([^\]]+))?\]\]/g, (_, k, label) => `<button type="button" class="chip" data-term="${k}">${label || (GLOSS[k] ? GLOSS[k][0].toLowerCase() : k)}</button>`);
}
const plain = t => (t || "").replace(/\[\[([a-z]+)(?:\|([^\]]+))?\]\]/g, (_, k, label) => label || (GLOSS[k] ? GLOSS[k][0].toLowerCase() : k)).replace(/<[^>]+>/g, "");
const sayEl = $("#say");
function say(t) { sayEl.textContent = ""; requestAnimationFrame(() => { sayEl.textContent = plain(t); }); }   // cleared first, so a repeated message is read again
const pop = $("#pop");
function showPop(chip) {
  const g = GLOSS[chip.dataset.term]; if (!g) return;
  pop.innerHTML = `<div class="t">${g[0]}</div><div class="d">${g[1]}</div><button type="button" class="link" data-act="glossary">All terms</button>`;
  pop.hidden = false;
  const r = chip.getBoundingClientRect(), pw = Math.min(290, innerWidth - 24), ph = pop.offsetHeight;
  const left = clamp(r.left + r.width / 2 - pw / 2, 12, innerWidth - pw - 12);
  let top = r.bottom + 8;
  if (top + ph > innerHeight - 12) top = Math.max(12, r.top - ph - 8);   // no room below: open above the word
  pop.style.left = left + "px"; pop.style.top = top + "px"; pop.style.width = pw + "px";
  say(g[0] + ". " + g[1]);
  Sound.tap();
}
document.addEventListener("click", e => {
  const chip = e.target.closest(".chip");
  if (chip) { Sound.init(); showPop(chip); return; }
  if (e.target.closest("#pop [data-act='glossary']")) { pop.hidden = true; openGlossary(); return; }
  if (!e.target.closest("#pop")) pop.hidden = true;
});

/* ---------- Screens ---------- */
let mode = "start", backTo = "home";
const panel = $("#panel"), app = $("#app");
const idleGame = new E.Game(START_FEN);
const L = {};
const G = { level: saved.level, colorPick: saved.side, game: null, user: "w", token: 0 };
// The panel is redrawn from state after every change. Focus is put back on the same control, so keyboard
// players keep their place instead of being thrown back to the top of the page.
function renderPanel() {
  const top = panel.scrollTop, a = document.activeElement, had = panel.contains(a);
  const key = had && a.dataset ? [a.dataset.act, a.dataset.v, a.dataset.term].join("|") : null;
  let html = "";
  if (mode === "home") html = homeHTML();
  else if (mode === "lessons") html = lessonsHTML();
  else if (mode === "lesson") html = L.finished ? lessonDoneHTML() : lessonHTML();
  else if (mode === "setup") html = setupHTML();
  else if (mode === "game") html = gameHTML();
  else if (mode === "glossary") html = glossaryHTML();
  panel.innerHTML = html;
  panel.scrollTop = top;
  const mv = panel.querySelector(".moves"); if (mv) mv.scrollLeft = mv.scrollWidth;
  if (mode === "glossary") { const s = panel.querySelector("#gsearch"); s.addEventListener("input", () => { panel.querySelector("#glist").innerHTML = glossList(s.value); }); }
  if (had) {
    const same = key && [...panel.querySelectorAll("[data-act], [data-term]")].find(el => [el.dataset.act, el.dataset.v, el.dataset.term].join("|") === key && !el.disabled);
    (same || panel).focus({ preventScroll: true });
  }
}
function go(m) {
  mode = m; pop.hidden = true; panel.scrollTop = 0;
  $("#menuBtn").hidden = m === "home" || m === "start";
  if (m === "home" || m === "lessons" || m === "setup") idleBoard();
  renderPanel();
  if (panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
}
function idleBoard() {   // menus show the starting position, slowly turning
  G.token++; selected = null; lastMove = null; hintMv = null; lessonMarks = []; kb.on = false; setStars([]);
  if (recs.length === 0 || targetsFor(idleGame).length !== recs.length || boardDiffers()) syncPieces(idleGame, true);
  drawMarks(); cam.idle = true; cam.tPhi = 0.92; cam.tZoom = 1.04;
}
function boardDiffers() { return targetsFor(idleGame).some(t => { const r = bySlot.get(t.slot); return !r || r.type !== t.type || r.color !== t.color; }); }

panel.addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b || b.disabled) return;
  const a = b.dataset.act, v = b.dataset.v;
  Sound.init();
  ({
    learn: () => go("lessons"),
    play: () => go("setup"),
    glossary: () => openGlossary(),
    home: () => go("home"),
    back: () => go(backTo),
    lesson: () => startLesson(+v),
    nextStep: () => nextStep(),
    prevStep: () => goStep(L.k - 1),
    retry: () => goStep(L.k),
    showme: () => showMe(),
    nextLesson: () => startLesson(L.i + 1),
    level: () => { G.level = v; saved.level = v; save(); renderPanel(); Sound.tap(); },
    color: () => { G.colorPick = v; saved.side = v; save(); renderPanel(); Sound.tap(); },
    startGame: () => startGame(),
    hint: () => giveHint(),
    undo: () => undoMove(),
    newGame: () => go("setup"),
    again: () => startGame()
  }[a] || (() => {}))();
});
function openGlossary() { if (mode !== "glossary") backTo = mode; go("glossary"); }

const ICON = {
  warn: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5 15 14H1z" opacity=".18"/><path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6v3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.8" r=".9"/></svg>',
  chev: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>'
};

function homeHTML() {
  const done = LESSONS.filter(l => saved.done[l.id]).length;
  return `<div class="pv">
    <div class="eyebrow">Knight School</div>
    <h1 class="h-xl">Learn chess, one move at a time.</h1>
    <div class="choices">
      <button type="button" class="choice" data-act="learn"><span class="glyph" aria-hidden="true">${GLYPH[1]}</span><span><b>Learn</b><span class="s">${done ? `${done} of ${LESSONS.length} lessons done` : `${LESSONS.length} short lessons`}</span><span class="bar" aria-hidden="true"><i style="width:${done / LESSONS.length * 100}%"></i></span></span><span class="chev">${ICON.chev}</span></button>
      <button type="button" class="choice" data-act="play"><span class="glyph" aria-hidden="true">${GLYPH[2]}</span><span><b>Play</b><span class="s">A friendly computer with a coach</span></span><span class="chev">${ICON.chev}</span></button>
    </div>
    <div class="row"><button type="button" class="link" data-act="glossary">Glossary</button></div>
  </div>`;
}
function lessonsHTML() {
  const next = LESSONS.findIndex(l => !saved.done[l.id]);
  return `<div class="pv">
    <h2 class="h-lg">Lessons</h2>
    <p class="muted lead">${next < 0 ? "All done! Replay any lesson, or go play." : "Start at the top. Each lesson takes a few minutes."}</p>
    <div class="lessons">${LESSONS.map((l, i) => { const d = saved.done[l.id]; return `<button type="button" class="les ${d ? "done" : ""}" data-act="lesson" data-v="${i}"><span class="num" aria-hidden="true">${d ? ICON.check : i + 1}</span><span><b>${l.title}</b><span class="s">${l.sub}${d ? '<span class="sr">, done</span>' : ""}</span></span><span class="chev">${ICON.chev}</span></button>`; }).join("")}</div>
  </div>`;
}

/* ---------- Lessons ---------- */
function startLesson(i) {
  if (i >= LESSONS.length) { go("lessons"); return; }
  Object.assign(L, { i, lesson: LESSONS[i], finished: false });
  mode = "lesson"; $("#menuBtn").hidden = false; pop.hidden = true; panel.scrollTop = 0;
  viewFor("w"); showTip();
  goStep(0);
  if (panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
}
async function goStep(k) {
  const st = L.lesson.steps[k];
  const token = ++G.token;   // any wait still running from the step before checks this and quietly stops
  Object.assign(L, { k, step: st, done: st.type === "info", fails: 0, goal: 0, fb: null, busy: false, moves: 0, collected: 0, tapRound: 0, showme: false });
  L.game = new E.Game(st.fen || EMPTY_FEN);
  selected = null; lastMove = null; hintMv = null; lessonMarks = (st.marks || []).map(E.IDX);
  syncPieces(L.game, true); setStars(st.stars);
  if (st.type === "tap") newTapTarget();
  if (kb.on) kbStart();
  drawMarks(); renderPanel();
  say(st.type === "tap" ? `${st.text} Find ${L.tap}.` : st.text);
  if (st.pre) {   // moves the lesson plays by itself before you start, like Black's pawn for en passant
    L.busy = true; renderPanel(); await wait(900);
    for (const p of st.pre) { if (token !== G.token) return; await playUci(L.game, p); }
    L.busy = false; renderPanel();
  }
}
function nextStep() {
  if (L.k < L.lesson.steps.length - 1) goStep(L.k + 1);
  else { saved.done[L.lesson.id] = true; save(); L.finished = true; Sound.success(); confetti(); renderPanel(); say("Lesson done!"); }
}
function newTapTarget() { let s; do { s = E.NAME(Math.floor(Math.random() * 64)); } while (s === L.tap); L.tap = s; }
async function playUci(game, u) {
  const rec = game.play(uci(u)); if (!rec) return null;
  lastMove = { from: rec.from, to: rec.to }; selected = null; drawMarks();
  await animMove(rec);
  if (E.inCheck(game.st)) Sound.check();
  drawMarks();
  return rec;
}
// Everything a lesson's test might want to know about the move just played.
function ctxOf(game, rec) {
  const s = game.status();
  return { san: rec.san.replace(/[+#]/g, ""), to: E.NAME(rec.to), from: E.NAME(rec.from), type: rec.piece & 7, cap: rec.cap & 7, check: E.inCheck(game.st), mate: s.reason === "checkmate", stalemate: s.reason === "stalemate", castleK: !!(rec.flag & 4), castleQ: !!(rec.flag & 8), ep: !!(rec.flag & 2), promo: rec.promo, promoName: PN[rec.promo] };
}
function lessonTap(sq) {
  const st = L.step; if (L.busy || L.finished) return;
  if (st.type === "tap") {
    if (L.done) return;
    const name = E.NAME(sq);
    if (name === L.tap) {
      flash(sq, "good"); L.tapRound++; Sound.star(L.tapRound);
      if (L.tapRound >= FIND) { L.done = true; L.fb = { kind: "good", text: "Great! You can read the board like a map." }; Sound.success(); }
      else { L.fb = { kind: "good", text: `Yes, that is ${name}!` }; newTapTarget(); }
    } else { flash(sq, "bad"); Sound.error(); L.fb = { kind: "bad", text: `That is ${name}. Find ${L.tap}.` }; }
    renderPanel(); say(L.fb.kind === "good" && !L.done ? `${L.fb.text} Find ${L.tap}.` : L.fb.text);
    return;
  }
  if (st.type === "stars") {
    if (L.done) return;
    const want = st.piece ? " PNBRQK".indexOf(st.piece) : 0;
    boardSelect(L.game, sq, (s, p) => !want || (p & 7) === want, mv => starMove(mv));
    return;
  }
  if (st.type === "goal") { if (L.done) return; boardSelect(L.game, sq, () => true, mv => goalMove(mv)); }
}
async function starMove(mv) {
  const token = G.token;
  const rec = L.game.play(mv); if (!rec) return;
  L.busy = true; lastMove = { from: rec.from, to: rec.to }; drawMarks();
  await animMove(rec);
  if (token !== G.token) return;
  L.game.st.turn = 0; L.game.st.ep = -1; L.moves++;   // star hunts have no opponent: it is always your move
  const i = stars.findIndex(s => s.sq === rec.to);
  if (i >= 0) {
    const s = stars[i]; stars.splice(i, 1); L.collected++; Sound.star(L.collected + 1);
    burst(s.mesh.position.clone().setY(0.1), 0xF2B630, 14, 1.2);
    const y0 = s.mesh.position.y;
    tween(450, t => { s.mesh.position.y = y0 + t * 0.9; s.mesh.scale.setScalar(Math.max(0.001, 1 + 0.6 * Math.sin(Math.PI * t * 0.5) - t)); s.mesh.rotation.y += 0.3; }, ease.out).then(() => starsG.remove(s.mesh));
  }
  if (!stars.length) { L.done = true; L.fb = { kind: "good", text: `All stars collected in ${L.moves} ${L.moves === 1 ? "move" : "moves"}!` }; setTimeout(() => Sound.success(), 250); }
  else L.fb = i >= 0 ? { kind: "good", text: "Got one!" } : null;
  L.busy = false; drawMarks(); renderPanel();
  if (L.fb) say(L.fb.text);
}
async function goalMove(mv) {
  const token = G.token, goal = L.step.goals[L.goal];
  const rec = L.game.play(mv); if (!rec) return;
  L.busy = true; L.fb = null; lastMove = { from: rec.from, to: rec.to }; hintMv = null; drawMarks(); renderPanel();
  await animMove(rec);
  if (token !== G.token) return;
  const c = ctxOf(L.game, rec);
  if (c.check) Sound.check();
  drawMarks();
  if (goal.test(c)) {
    L.fb = { kind: "good", text: typeof goal.ok === "function" ? goal.ok(c) : goal.ok };
    L.goal++; L.fails = 0; L.showme = false;
    if (L.goal >= L.step.goals.length) { L.done = true; Sound.success(); confetti(); if (L.step.done) L.fb = { kind: "good", text: L.fb.text + " " + L.step.done }; }
    else Sound.good();
    renderPanel(); say(L.fb.text);
    if (goal.reply) { await wait(750); if (token !== G.token) return; await playUci(L.game, goal.reply); }
    L.busy = false; renderPanel();
  } else {
    L.fails++;
    L.fb = { kind: "bad", text: (goal.fail && goal.fail(c)) || (c.stalemate ? "That is stalemate, so the game would be a draw. Try again." : "Not quite. Try again.") };
    if (L.fails >= 2 && goal.solution) L.showme = true;   // after two misses, offer to show the answer
    Sound.error(); renderPanel(); say(L.fb.text);
    await wait(1200); if (token !== G.token) return;
    L.game.undo(); lastMove = null; syncPieces(L.game, true); drawMarks();   // the wrong move glides back
    await wait(450); L.busy = false; renderPanel();
  }
}
function showMe() {
  const g = L.step.goals[L.goal]; if (!g || !g.solution) return;
  hintMv = uci(g.solution); drawMarks();
  L.fb = { kind: "", text: `Move the piece on ${g.solution.slice(0, 2)} to ${g.solution.slice(2, 4)}. They are the blue squares.` };
  renderPanel(); say(L.fb.text);
}
function lessonHTML() {
  const les = L.lesson, st = L.step, k = L.k, n = les.steps.length;
  let task = "";
  const fb = L.fb ? `<div class="fb ${L.fb.kind}">${rich(L.fb.text)}</div>` : "";
  if (st.type === "tap") task = `<div class="task"><div class="label">Your task</div><div class="big">${L.done ? "All found!" : `Tap <span class="sq">${L.tap}</span>`}</div><div class="pips" role="img" aria-label="${L.tapRound} of ${FIND} found">${Array.from({ length: FIND }, (_, i) => `<i class="${i < L.tapRound ? "on" : ""}"></i>`).join("")}</div>${fb}</div>`;
  if (st.type === "stars") task = `<div class="task"><div class="label">Your task</div><div class="do">${L.done ? "All stars collected!" : "Collect every star."}</div><div class="pips" role="img" aria-label="${L.collected} of ${st.stars.length} stars">${st.stars.map((_, i) => `<i class="${i < L.collected ? "on" : ""}"></i>`).join("")}</div><div class="meta">${L.moves} ${L.moves === 1 ? "move" : "moves"}</div>${fb}${L.done ? "" : '<div><button type="button" class="link" data-act="retry">Start over</button></div>'}</div>`;
  if (st.type === "goal") {
    const g = st.goals[Math.min(L.goal, st.goals.length - 1)];
    const label = st.goals.length > 1 ? `Your task, ${Math.min(L.goal + 1, st.goals.length)} of ${st.goals.length}` : "Your task";
    task = `<div class="task"><div class="label">${L.done ? "Done" : label}</div>${L.done ? "" : `<div class="do">${rich(g.task)}</div>`}${fb}${!L.done && L.showme ? '<div><button type="button" class="link" data-act="showme">Show me</button></div>' : ""}${!L.done && L.goal > 0 ? '<div><button type="button" class="link" data-act="retry">Start over</button></div>' : ""}</div>`;
  }
  return `<div class="pv">
    <div class="eyebrow">Lesson ${L.i + 1} of ${LESSONS.length}</div>
    <h2 class="h-lg">${les.title}</h2>
    <div class="dots" role="img" aria-label="Step ${k + 1} of ${n}">${les.steps.map((_, i) => `<span class="${i < k ? "done" : i === k ? "on" : ""}"></span>`).join("")}</div>
    <div class="txt">${rich(st.text)}</div>
    ${st.html || ""}
    ${task}
    <div class="row nav"><button type="button" class="btn" data-act="prevStep" ${k === 0 ? "disabled" : ""}>Back</button><button type="button" class="btn primary" data-act="nextStep" ${L.done && !L.busy ? "" : "disabled"}>${k === n - 1 ? "Finish" : "Next"}</button></div>
  </div>`;
}
function lessonDoneHTML() {
  const last = L.i >= LESSONS.length - 1;
  return `<div class="pv">
    <div class="eyebrow">Lesson ${L.i + 1} of ${LESSONS.length}</div>
    <h2 class="h-xl">Lesson done!</h2>
    <p class="txt flush">You finished <b>${L.lesson.title}</b>. ${last ? "That was the last lesson. You know all the rules now, so try a real game!" : "Your progress is saved on this device."}</p>
    <div class="row">${last ? '<button type="button" class="btn primary grow" data-act="play">Play a game</button>' : '<button type="button" class="btn primary grow" data-act="nextLesson">Next lesson</button>'}<button type="button" class="btn grow" data-act="learn">All lessons</button></div>
  </div>`;
}

/* ---------- Play ---------- */
function setupHTML() {
  const seg = (act, cur, label, items) => `<div class="seg" role="group" aria-label="${label}">${items.map(([v, l]) => `<button type="button" data-act="${act}" data-v="${v}" aria-pressed="${cur === v}">${l}</button>`).join("")}</div>`;
  return `<div class="pv">
    <h2 class="h-lg">Play</h2>
    <div class="h-sm">Level</div>
    ${seg("level", G.level, "Level", [["beginner", "Beginner"], ["casual", "Casual"], ["challenging", "Challenging"]])}
    <div class="note">${LEVEL_NOTE[G.level]}</div>
    <div class="h-sm">You play</div>
    ${seg("color", G.colorPick, "You play", [["w", "White"], ["b", "Black"], ["r", "Random"]])}
    <button type="button" class="btn primary start-game" data-act="startGame">Start game</button>
  </div>`;
}
// The computer thinks in a Web Worker built from the same rules code, so the board never freezes.
// If the browser blocks the worker (some do for pages opened from disk), it thinks on the page instead.
let worker = null, reqId = 0;
const pending = new Map();
try {
  const src = ENGINE.toString() + "\nvar E = ENGINE(" + JSON.stringify(LEVELS) + ");\nonmessage = function (e) { var d = e.data, m = E.bestMove(E.fromFen(d.fen), d.level); postMessage({ id: d.id, move: m ? { from: m.from, to: m.to, promo: m.promo } : null }); };";
  worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  worker.onmessage = e => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p.res(e.data.move); } };
  worker.onerror = () => { worker = null; for (const [id, p] of pending) { pending.delete(id); p.res(localThink(p.fen, p.level)); } };
} catch (e) { worker = null; }
function localThink(fen, level) { const m = E.bestMove(E.fromFen(fen), level); return m && { from: m.from, to: m.to, promo: m.promo }; }
function think(fen, level) {
  return new Promise(res => {
    if (worker) { const id = ++reqId; pending.set(id, { res, fen, level }); worker.postMessage({ id, fen, level }); }
    else setTimeout(() => res(localThink(fen, level)), 30);
  });
}

function startGame() {
  Sound.init();
  G.token++;
  G.user = G.colorPick === "r" ? (Math.random() < 0.5 ? "w" : "b") : G.colorPick;
  G.game = new E.Game(START_FEN); G.over = null; G.thinking = false; G.busy = false; G.hint = null; G.note = "";
  G.lines = [{ who: "coach", head: "Hi! I am your coach.", why: `Tap a piece, then tap a square to move it. I will explain every move.${G.user === "b" ? " You play Black, so the computer moves first." : ""}` }];
  mode = "game"; $("#menuBtn").hidden = false; pop.hidden = true; panel.scrollTop = 0;
  selected = null; lastMove = null; hintMv = null; lessonMarks = []; setStars([]);
  kb.sq = G.user === "w" ? 12 : 52;   // e2 or e7, where most first moves start
  syncPieces(G.game, true); viewFor(G.user); drawMarks(); renderPanel(); showTip();
  if (panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
  say(`New game. You play ${G.user === "w" ? "White" : "Black"}.`);
  if (G.user === "b") computerMove();
}
async function computerMove() {
  const token = G.token; G.thinking = true; renderPanel();
  const t0 = performance.now();
  const mv = await think(G.game.fen(), G.level);
  const el = performance.now() - t0;
  if (el < THINK) await new Promise(r => setTimeout(r, THINK - el));
  if (token !== G.token || mode !== "game") return;
  G.thinking = false;
  if (mv) await playGameMove(mv, "cpu"); else renderPanel();
}
function gameTap(sq) {
  if (G.busy || G.thinking || G.over || G.game.turn !== G.user) return;
  G.note = "";
  boardSelect(G.game, sq, () => true, mv => playGameMove(mv, "you"));
}
async function playGameMove(mv, who) {
  const token = G.token;
  const rec = G.game.play(mv); if (!rec) return;
  G.busy = true; G.hint = null; hintMv = null; selected = null; lastMove = { from: rec.from, to: rec.to }; drawMarks();
  if (who === "you") { G.lines = []; renderPanel(); }
  await animMove(rec);
  if (token !== G.token) return;
  G.busy = false;
  const ex = explain(G.game, rec), status = G.game.status();
  const line = { who, head: ex.head, why: ex.why };
  if (who === "you") G.lines = [line]; else G.lines = G.lines.filter(l => l.who === "you").concat([line]);
  let warn = "";
  if (status.over) { G.over = status; endSound(status); }
  else {
    if (status.check) Sound.check();
    warn = hangText(G.game, who === "you" ? rec.to : -1);
    if (warn) G.lines.push({ who: "warn", text: warn });
  }
  if (kb.on && who === "cpu") kbStart();
  drawMarks(); renderPanel();
  say((who === "cpu" ? "Computer: " : "You: ") + ex.head + ". " + ex.why + (warn ? " " + warn : "") + (status.over ? " " + resultTitle(status) : ""));
  if (!status.over && who === "you") computerMove();
}
function endSound(s) {
  if (s.reason === "checkmate") (s.winner === G.user ? Sound.success() : Sound.sad()); else Sound.calm();
  if (s.reason === "checkmate" && s.winner === G.user) confetti();
}
const VALTXT = ["", "a pawn, worth 1 point", "a knight, worth 3 points", "a bishop, worth 3 points", "a rook, worth 5 points", "a queen, worth 9 points", ""];
// The coach's words for a move: a plain headline with its notation, then at most two short reasons.
// The first reason that fits wins: the result of the game, then check, promotion or what was won, then threats,
// and only for quiet moves the opening habits.
function explain(game, m) {
  const st = game.st, t = m.piece & 7, color = m.piece & 8, sqn = E.NAME(m.to);
  let head;
  if (m.flag & 4) head = `Castles on the king side (${m.san})`;
  else if (m.flag & 8) head = `Castles on the queen side (${m.san})`;
  else {
    head = cap1(PN[t]) + (m.cap ? ` takes the ${PN[m.cap & 7]} on ${sqn}` : ` to ${sqn}`);
    if (m.flag & 2) head += " en passant";
    if (m.promo) head += ` and becomes a ${PN[m.promo]}`;
    head += ` (${m.san})`;
  }
  const why = [], s = game.status();
  if (s.reason === "checkmate") why.push("[[checkmate|Checkmate]]! The king has no way out.");
  else if (s.over) why.push(drawText(s));
  else if (s.check) why.push("[[check|Check]]! The king is under attack.");
  if (m.promo) why.push("The pawn reached the last rank and got a [[promotion]].");
  else if (m.cap && !s.over && why.length < 2) why.push(`That wins ${VALTXT[m.cap & 7]}.`);
  if (m.flag & 12) why.push("The king is now safer behind its pawns.");
  if (why.length < 2 && !s.over) {
    // Threats worth naming: the king, anything worth more than the mover, or anything left unguarded.
    const targets = E.attacksFrom(st, m.to).filter(q => { const p = st.b[q]; if (!p || (p & 8) === color) return false; const pt = p & 7; if (pt === 6) return true; return E.VAL[pt] > E.VAL[t] || !E.attacked(st, q, color ^ 8); });
    if (targets.length >= 2) why.push(`A [[fork]]! It attacks the ${targets.slice(0, 2).map(q => PN[st.b[q] & 7]).join(" and the ")}.`);
    else if (targets.length === 1 && (st.b[targets[0]] & 7) !== 6) why.push(`It now attacks the ${PN[st.b[targets[0]] & 7]} on ${E.NAME(targets[0])}.`);
  }
  if (!why.length) {
    const fromRank = m.from >> 3, home = color ? 7 : 0;
    if ((t === 2 || t === 3) && fromRank === home && st.full <= 14) why.push("It brings a new piece into the game. That is good [[development]].");
    else if ([27, 28, 35, 36].includes(m.to)) why.push("It fights for the [[center]].");
    else if (t === 1 && st.full <= 10) why.push("It opens room for the pieces behind it.");
  }
  return { head, why: why.slice(0, 2).join(" ") };
}
function drawText(s) {
  return {
    stalemate: "[[stalemate|Stalemate]]: no legal move, but no check. It is a [[draw]].",
    fifty: "Fifty moves with no capture or pawn move. It is a [[draw]] by the [[fifty|fifty-move rule]].",
    material: "Neither side has enough pieces to checkmate. It is a [[draw]].",
    repetition: "The same position came up three times. It is a [[draw]] by [[repetition]]."
  }[s.reason] || "";
}
// Warn about your own pieces that can be taken badly. Right after your move, the piece you just moved comes first,
// with a nudge to undo; after the computer's move, the most valuable piece in danger.
function hangText(game, prefer) {
  const list = E.hanging(game.st, G.user === "w" ? 0 : 8); if (!list.length) return "";
  const h = list.find(x => x.sq === prefer) || list[0];
  const where = `your ${PN[h.type]} on ${E.NAME(h.sq)}`;
  if (h.sq === prefer) return h.free ? `Careful: ${where} can now be taken for free. Tap Undo to try another move.` : `Careful: a ${PN[h.by]} can take ${where}, and you would lose points. Tap Undo to try another move.`;
  return h.free ? `Watch out: ${where} can be taken for free. Nothing [[guard|guards]] it.` : `Watch out: a ${PN[h.by]} attacks ${where}. That trade would cost you points.`;
}
async function giveHint() {
  if (G.busy || G.thinking || G.over || G.game.turn !== G.user) return;
  const token = G.token; G.hintLoading = true; renderPanel();
  const mv = await think(G.game.fen(), "hint");
  G.hintLoading = false;
  if (token !== G.token || !mv) { renderPanel(); return; }
  const rec = G.game.play(mv), ex = explain(G.game, rec);
  G.game.undo();
  hintMv = { from: mv.from, to: mv.to }; selected = null; setLift(null);
  G.hint = `<b>Try ${ex.head}.</b> ${ex.why}`;
  Sound.tap(); drawMarks(); renderPanel(); say(G.hint);
}
function undoMove() {
  if (G.busy || G.thinking || !G.game || !userMoveCount()) return;
  do { G.game.undo(); } while (G.game.log.length && G.game.turn !== G.user);   // take back the computer's reply too
  G.over = null; G.hint = null; hintMv = null; selected = null; G.note = "";
  const lm = G.game.log[G.game.log.length - 1]; lastMove = lm ? { from: lm.from, to: lm.to } : null;
  G.lines = [{ who: "coach", head: "Move taken back.", why: "Your turn. Try something new." }];
  syncPieces(G.game, true); drawMarks(); renderPanel(); Sound.tap(); say("Move taken back. Your turn.");
}
function userMoveCount() { return G.game.log.filter((m, i) => (G.user === "w" ? i % 2 === 0 : i % 2 === 1)).length; }
function resultTitle(s) { return s.reason === "checkmate" ? (s.winner === G.user ? "Checkmate. You win!" : "Checkmate. The computer wins.") : "Draw"; }
function gameHTML() {
  const g = G.game, s = G.over;
  let pill;
  if (s) pill = '<span class="pill">Game over</span>';
  else if (G.thinking) pill = '<span class="pill cpu"><i></i>Computer is thinking</span>';
  else if (g.turn === G.user) pill = E.inCheck(g.st) ? '<span class="pill check"><i></i>Check! Your move</span>' : '<span class="pill"><i></i>Your move</span>';
  else pill = '<span class="pill cpu"><i></i>Computer to move</span>';
  const lv = { beginner: "Beginner", casual: "Casual", challenging: "Challenging" }[G.level];
  const lines = (G.lines || []).map(l => {
    if (l.who === "warn") return `<div class="warn">${ICON.warn}<span>${rich(l.text)}</span></div>`;
    const cls = l.who === "cpu" ? "cpu" : l.who === "coach" ? "coach-l" : "";
    const av = l.who === "cpu" ? GLYPH[2] : l.who === "coach" ? "\u2726" : G.user === "w" ? glyph("\u2659") : GLYPH[1];
    const label = l.who === "cpu" ? "Computer: " : l.who === "you" ? "You: " : "";
    return `<div class="line ${cls}"><span class="who" aria-hidden="true">${av}</span><div><b>${label}${l.head}</b>${l.why ? `<p>${rich(l.why)}</p>` : ""}</div></div>`;
  }).join("");
  let result = "";
  if (s) {
    const sub = s.reason === "checkmate" ? (s.winner === G.user ? "Well played! Try a harder level next." : "Good try! Tap Undo to go back, or play again.") : drawText(s);
    result = `<div class="result"><div class="h-lg">${resultTitle(s)}</div><div class="muted">${rich(sub)}</div><div class="row"><button type="button" class="btn primary grow" data-act="again">Play again</button><button type="button" class="btn grow" data-act="newGame">Change level</button></div></div>`;
  }
  const moves = g.log.map((m, i) => `<span class="${i === g.log.length - 1 ? "last" : ""}">${i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : ""}${m.san}</span>`);
  const canUndo = !G.busy && !G.thinking && userMoveCount() > 0;
  const canHint = !s && !G.busy && !G.thinking && g.turn === G.user && !G.hintLoading;
  return `<div class="pv">
    <div class="status">${pill}<span class="muted small">${lv}</span></div>
    ${result}
    <div class="coach">${lines}</div>
    ${G.note ? `<div class="fb bad">${G.note}</div>` : ""}
    ${G.hint ? `<div class="hintbox">${rich(G.hint)}</div>` : ""}
    ${moves.length ? `<div class="moves" aria-label="Moves so far">${moves.join("")}</div>` : ""}
    <div class="row">
      <button type="button" class="btn grow" data-act="hint" ${canHint ? "" : "disabled"}>${G.hintLoading ? "Thinking" : "Hint"}</button>
      <button type="button" class="btn grow" data-act="undo" ${canUndo ? "" : "disabled"}>Undo</button>
      <button type="button" class="btn grow" data-act="newGame">New game</button>
    </div>
  </div>`;
}

/* ---------- Glossary ---------- */
function glossList(q) {
  q = (q || "").trim().toLowerCase();
  const items = Object.values(GLOSS).filter(g => !q || g[0].toLowerCase().includes(q) || g[1].toLowerCase().includes(q)).sort((a, b) => a[0].localeCompare(b[0]));
  return items.length ? items.map(g => `<div><b>${g[0]}</b><span>${g[1]}</span></div>`).join("") : '<div class="muted">No matching terms.</div>';
}
function glossaryHTML() {
  return `<div class="pv">
    <h2 class="h-lg">Glossary</h2>
    <input id="gsearch" class="search" type="search" placeholder="Search terms" aria-label="Search terms" autocomplete="off">
    <div class="gl" id="glist" aria-live="polite">${glossList("")}</div>
    <div><button type="button" class="btn" data-act="back">Done</button></div>
  </div>`;
}

/* ---------- Controls ---------- */
const soundBtn = $("#soundBtn");
function paintSound() {
  soundBtn.querySelector("span").textContent = Sound.on ? "Sound on" : "Sound off";
  soundBtn.querySelector(".waves").style.opacity = Sound.on ? 1 : 0.15;
  soundBtn.setAttribute("aria-pressed", String(Sound.on));
}
function toggleSound() { Sound.init(); Sound.on = !Sound.on; saved.sound = Sound.on; save(); paintSound(); Sound.tap(); say(Sound.on ? "Sound on" : "Sound off"); }
soundBtn.addEventListener("click", toggleSound);
$("#viewBtn").addEventListener("click", () => { viewFor(mode === "game" ? G.user : "w"); if (mode === "home" || mode === "lessons" || mode === "setup" || mode === "glossary") cam.idle = true; });
$("#menuBtn").addEventListener("click", () => { Sound.tap(); go(mode === "lesson" ? "lessons" : "home"); });
function start() {
  if (mode !== "start") return;
  Sound.init(); Sound.good();
  $("#start").hidden = true; panel.hidden = false; app.classList.add("with-panel");
  soundBtn.hidden = false; $("#viewBtn").hidden = false; paintSound();
  requestAnimationFrame(fit);
  go("home");
  const first = panel.querySelector("button"); if (first) first.focus({ preventScroll: true });
}
$("#startBtn").addEventListener("click", start);

/* ---------- Loop ---------- */
syncPieces(idleGame, false);
fit();
let prev = performance.now();
function loop(now) {
  // Clamped both ways: a long pause (a hidden tab) must not fling the camera, and the first frame can carry
  // a timestamp from before the page finished loading, which would make dt negative.
  const dt = Math.min(0.12, Math.max(0, (now - prev) / 1000)); prev = now;
  stepTweens(now);
  if (cam.idle && !drag && !reduceMotion) cam.tTheta += dt * CAMERA.spin;
  const k = 1 - Math.pow(0.0015, dt);   // the same smoothing at any frame rate
  cam.theta += (cam.tTheta - cam.theta) * k; cam.phi += (cam.tPhi - cam.phi) * k; cam.zoom += (cam.tZoom - cam.zoom) * k;
  const R = cam.base * cam.zoom;
  camera.position.set(R * Math.sin(cam.phi) * Math.sin(cam.theta), R * Math.cos(cam.phi), R * Math.sin(cam.phi) * Math.cos(cam.theta));
  camera.lookAt(0, -0.25, 0);
  const t = now / 1000;
  for (const s of stars) { s.mesh.rotation.y += dt * 1.6; s.mesh.position.y = 0.36 + Math.sin(t * 2.2 + s.ph) * 0.05; }
  for (let i = bits.length - 1; i >= 0; i--) {
    const b = bits[i];
    b.life += dt; b.v.y -= 7 * dt; b.m.position.addScaledVector(b.v, dt);
    b.m.rotation.x += b.r.x * dt; b.m.rotation.y += b.r.y * dt;
    if (b.m.position.y < 0.02) { b.m.position.y = 0.02; b.v.multiplyScalar(0.4); b.v.y = Math.abs(b.v.y) * 0.3; }
    b.m.scale.setScalar(Math.max(0.001, 1 - b.life / b.max));
    if (b.life >= b.max) { scene.remove(b.m); bits.splice(i, 1); }
  }
  if (hintMeshes.length) MAT.hint.opacity = 0.38 + 0.22 * Math.sin(t * 5);   // the hint squares pulse gently
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
})();
