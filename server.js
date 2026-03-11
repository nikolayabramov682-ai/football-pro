const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = {};

function uid() { return Math.random().toString(36).substr(2, 5).toUpperCase(); }

// ── FIELD (логические координаты) ─────────────────────────────
const FW = 105, FH = 68; // метры (стандарт FIFA)
const GW = 7.32, GD = 2; // ширина ворот, глубина
const GY1 = (FH - GW) / 2;
const GY2 = (FH + GW) / 2;
const BALL_R = 0.22;

const TEAMS_DATA = {
  real:   { name: 'Реал Мадрид', rating: 89, speed: 1.05, shoot: 1.08, pass: 1.06 },
  barca:  { name: 'Барселона',   rating: 87, speed: 1.02, shoot: 1.02, pass: 1.10 },
  city:   { name: 'Ман Сити',    rating: 88, speed: 1.03, shoot: 1.05, pass: 1.08 },
  bayern: { name: 'Бавария',     rating: 86, speed: 1.04, shoot: 1.06, pass: 1.04 },
  psg:    { name: 'ПСЖ',         rating: 87, speed: 1.06, shoot: 1.07, pass: 1.03 },
};

const ALL_TEAMS = Object.keys(TEAMS_DATA);

// Расстановка 4-3-3
const FORMATION = [
  // side=0 (слева)
  [
    { x: 3,  y: FH/2 },       // GK
    { x: 18, y: FH*0.18 },    // RB
    { x: 18, y: FH*0.38 },    // CB
    { x: 18, y: FH*0.62 },    // CB
    { x: 18, y: FH*0.82 },    // LB
    { x: 38, y: FH*0.22 },    // RM
    { x: 38, y: FH*0.50 },    // CM
    { x: 38, y: FH*0.78 },    // LM
    { x: 60, y: FH*0.22 },    // RF
    { x: 60, y: FH*0.50 },    // CF
    { x: 60, y: FH*0.78 },    // LF
  ],
  // side=1 (справа, зеркально)
  [
    { x: FW-3,  y: FH/2 },
    { x: FW-18, y: FH*0.18 },
    { x: FW-18, y: FH*0.38 },
    { x: FW-18, y: FH*0.62 },
    { x: FW-18, y: FH*0.82 },
    { x: FW-38, y: FH*0.22 },
    { x: FW-38, y: FH*0.50 },
    { x: FW-38, y: FH*0.78 },
    { x: FW-60, y: FH*0.22 },
    { x: FW-60, y: FH*0.50 },
    { x: FW-60, y: FH*0.78 },
  ],
];

const ROLES = ['gk','rb','cb','cb','lb','rm','cm','lm','rf','cf','lf'];
const SPEEDS = [5.5, 6.8, 6.5, 6.5, 6.8, 7.5, 7.0, 7.5, 8.0, 7.8, 8.0]; // m/s

function makePlayer(side, i, teamId) {
  const td = TEAMS_DATA[teamId] || TEAMS_DATA.real;
  const f = FORMATION[side][i];
  return {
    id: side * 11 + i, side, idx: i,
    role: ROLES[i],
    x: f.x, y: f.y,
    hx: f.x, hy: f.y,
    vx: 0, vy: 0,
    spd: SPEEDS[i] * td.speed,
    shootMult: td.shoot,
    facing: side === 0 ? 1 : -1, // 1=right, -1=left
    running: false,
    runFrame: 0,
    isControlled: false,
    stamina: 100,
    hasBall: false,
  };
}

function makeState(teams) {
  const players = [];
  for (let s = 0; s < 2; s++) {
    for (let i = 0; i < 11; i++) players.push(makePlayer(s, i, teams[s]));
  }
  return {
    ball: { x: FW/2, y: FH/2, z: 0, vx: 0, vy: 0, vz: 0, lastTouch: -1 },
    players,
    score: [0, 0],
    time: 5400,   // 90 min × 60 ticks (~8 min real)
    ticks: 0,
    phase: 'kickoff',
    pauseTicks: 90,
    teams,
    controlled: [-1, -1], // which player index each side controls
  };
}

function resetKickoff(g) {
  g.ball = { x: FW/2, y: FH/2, z: 0, vx: 0, vy: 0, vz: 0, lastTouch: -1 };
  for (let s = 0; s < 2; s++) {
    for (let i = 0; i < 11; i++) {
      const p = g.players[s*11+i];
      const f = FORMATION[s][i];
      p.x = f.x; p.y = f.y; p.vx = 0; p.vy = 0;
      p.hasBall = false; p.running = false;
    }
  }
  g.controlled = [-1, -1];
}

// ── AI ───────────────────────────────────────────────────────
function aiPlayer(p, g) {
  const b = g.ball;
  const dir = p.side === 0 ? 1 : -1;
  let tx = p.hx, ty = p.hy;

  const distToBall = Math.hypot(p.x - b.x, p.y - b.y);
  const ballInOurHalf = p.side === 0 ? b.x < FW/2 + 10 : b.x > FW/2 - 10;

  if (p.role === 'gk') {
    tx = p.hx;
    ty = Math.max(GY1 + 0.5, Math.min(GY2 - 0.5, b.y));
    if (distToBall < 8) { tx = b.x; ty = b.y; }
  } else if (p.role === 'cb' || p.role === 'rb' || p.role === 'lb') {
    if (ballInOurHalf) {
      if (distToBall < 25) { tx = b.x; ty = b.y; }
      else { tx = p.hx; ty = b.y * 0.4 + p.hy * 0.6; }
    } else {
      tx = p.hx; ty = p.hy;
    }
  } else if (p.role === 'cm' || p.role === 'rm' || p.role === 'lm') {
    if (distToBall < 18) { tx = b.x; ty = b.y; }
    else {
      tx = p.hx + dir * (ballInOurHalf ? -5 : 5);
      ty = b.y * 0.3 + p.hy * 0.7;
    }
  } else { // forwards
    if (!ballInOurHalf) {
      if (distToBall < 20) { tx = b.x; ty = b.y; }
      else { tx = p.hx; ty = b.y * 0.5 + p.hy * 0.5; }
    } else {
      tx = p.side === 0 ? FW - 15 : 15;
      ty = p.hy + Math.sin(g.ticks * 0.02 + p.id) * 5;
    }
  }

  const dx = tx - p.x, dy = ty - p.y;
  const d = Math.hypot(dx, dy);
  if (d > 0.3) {
    const spd = p.spd * 0.016 * (p.stamina > 30 ? 1 : 0.7);
    p.x += (dx/d) * spd;
    p.y += (dy/d) * spd;
    p.facing = dx > 0 ? 1 : -1;
    p.running = true;
    p.runFrame += 0.25;
  } else {
    p.running = false;
    p.vx = 0; p.vy = 0;
  }

  p.x = Math.max(0.5, Math.min(FW-0.5, p.x));
  p.y = Math.max(0.5, Math.min(FH-0.5, p.y));
}

function gameTick(room) {
  const g = room.state;
  if (!g) return;

  if (g.phase === 'pause' || g.phase === 'kickoff') {
    g.pauseTicks--;
    if (g.pauseTicks <= 0) g.phase = 'playing';
    bcast(room, { t: 'st', s: pack(g) });
    return;
  }
  if (g.phase !== 'playing') return;

  g.ticks++;
  if (g.ticks % 11 === 0 && g.time > 0) g.time--;
  if (g.time <= 0) {
    g.phase = 'ended';
    bcast(room, { t: 'end', score: g.score, teams: g.teams });
    clearInterval(room.iv);
    return;
  }

  // Human inputs
  for (let side = 0; side < 2; side++) {
    const inp = room.inp[side];
    if (!inp || g.controlled[side] < 0) continue;
    const p = g.players[side * 11 + g.controlled[side]];
    if (!p) continue;

    const spd = p.spd * 0.018;
    let moved = false;
    if (inp.u) { p.y -= spd; p.facing = p.side===0?1:-1; moved=true; }
    if (inp.d) { p.y += spd; p.facing = p.side===0?1:-1; moved=true; }
    if (inp.l) { p.x -= spd; p.facing = -1; moved=true; }
    if (inp.r) { p.x += spd; p.facing = 1; moved=true; }
    p.running = moved;
    if (moved) p.runFrame += 0.3;
    p.x = Math.max(0.5, Math.min(FW-0.5, p.x));
    p.y = Math.max(0.5, Math.min(FH-0.5, p.y));

    // Auto-switch to closest player to ball
    let closest = g.controlled[side], cDist = 9999;
    for (let i = 0; i < 11; i++) {
      const pp = g.players[side*11+i];
      const d = Math.hypot(pp.x - g.ball.x, pp.y - g.ball.y);
      if (d < cDist) { cDist = d; closest = i; }
    }
    if (inp.switchBtn) {
      g.controlled[side] = closest;
      inp.switchBtn = false;
    }
    // Auto-assign if not set
    if (g.controlled[side] < 0) g.controlled[side] = closest;
  }

  // AI for non-controlled players
  g.players.forEach(p => {
    const ctrl = g.controlled[p.side];
    if (ctrl >= 0 && p.idx === ctrl) return; // human controls this
    aiPlayer(p, g);
  });

  // Ball physics
  const b = g.ball;
  const DT = 1/60;
  b.x += b.vx * DT;
  b.y += b.vy * DT;
  b.z += b.vz * DT;

  // Gravity on z
  if (b.z > 0) { b.vz -= 9.8; }
  else { b.z = 0; if (b.vz < 0) { b.vz *= -0.35; if (Math.abs(b.vz) < 0.5) b.vz = 0; } }

  // Ground friction
  const groundFric = b.z < 0.1 ? 0.985 : 0.999;
  b.vx *= groundFric; b.vy *= groundFric;
  if (Math.abs(b.vx) < 0.05) b.vx = 0;
  if (Math.abs(b.vy) < 0.05) b.vy = 0;

  // Walls
  if (b.y < 0)   { b.y = 0;  b.vy *= -0.6; }
  if (b.y > FH)  { b.y = FH; b.vy *= -0.6; }

  // Goal check (left goal: x<0, right goal: x>FW)
  if (b.x < 0 && b.y > GY1 && b.y < GY2 && b.z < 2.44) {
    g.score[1]++;
    g.phase = 'pause'; g.pauseTicks = 150;
    bcast(room, { t: 'goal', side: 1, score: g.score });
    resetKickoff(g);
    return;
  }
  if (b.x > FW && b.y > GY1 && b.y < GY2 && b.z < 2.44) {
    g.score[0]++;
    g.phase = 'pause'; g.pauseTicks = 150;
    bcast(room, { t: 'goal', side: 0, score: g.score });
    resetKickoff(g);
    return;
  }

  // Out of bounds → reset near edge
  if (b.x < -2)  { b.x = 2;    b.vx = Math.abs(b.vx) * 0.5; }
  if (b.x > FW+2){ b.x = FW-2; b.vx = -Math.abs(b.vx) * 0.5; }

  // Player-ball collision
  let nearestDist = [9999, 9999];
  let nearestPlayer = [null, null];

  g.players.forEach(p => {
    const dx = p.x - b.x, dy = p.y - b.y;
    const dist = Math.hypot(dx, dy);
    if (dist < nearestDist[p.side]) { nearestDist[p.side] = dist; nearestPlayer[p.side] = p; }

    const touchRadius = 0.9;
    if (dist < touchRadius && b.z < 1.0) {
      const ang = Math.atan2(dy, dx);
      // AI auto-kick toward opponent goal
      const ctrl = g.controlled[p.side];
      if (ctrl < 0 || p.idx !== ctrl) {
        const gx = p.side === 0 ? FW : 0;
        const ga = Math.atan2(GY1 + GW/2 + (Math.random()-0.5)*2 - b.y, gx - b.x);
        const dist2goal = Math.hypot(p.x - gx, p.y - FH/2);
        const pwr = dist2goal < 20 ? 18 + Math.random()*4 : 10 + Math.random()*5;
        b.vx = Math.cos(ga) * pwr * p.shootMult;
        b.vy = Math.sin(ga) * pwr;
        if (dist2goal < 15 && Math.random() < 0.4) b.vz = 4 + Math.random()*3;
        b.lastTouch = p.side;
      }
    }
  });

  // Update controlled player if none set
  for (let side = 0; side < 2; side++) {
    if (g.controlled[side] < 0 && nearestPlayer[side]) {
      g.controlled[side] = nearestPlayer[side].idx;
    }
  }

  bcast(room, { t: 'st', s: pack(g) });
}

function pack(g) {
  return {
    b: { x: +g.ball.x.toFixed(2), y: +g.ball.y.toFixed(2), z: +g.ball.z.toFixed(2) },
    sc: g.score, t: g.time, ph: g.phase,
    ctrl: g.controlled,
    p: g.players.map(p => ({
      id: p.id, s: p.side, i: p.idx, r: p.role,
      x: +p.x.toFixed(2), y: +p.y.toFixed(2),
      f: p.facing, rn: p.running, rf: +p.runFrame.toFixed(1),
    })),
  };
}

function bcast(room, msg) {
  const d = JSON.stringify(msg);
  Object.values(room.ws).forEach(w => { if (w.readyState === 1) w.send(d); });
}

wss.on('connection', ws => {
  let room = null, myKey = null, mySide = -1;

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      const code = uid();
      const mysterious = !!msg.mysterious;
      const teams = mysterious
        ? [ALL_TEAMS[Math.floor(Math.random()*ALL_TEAMS.length)], null]
        : [msg.team, null];
      rooms[code] = { code, ws: {}, inp: { 0: null, 1: null }, state: null, iv: null, teams, mysterious, count: 1 };
      room = rooms[code]; myKey = 'h'; mySide = 0;
      room.ws.h = ws;
      ws.send(JSON.stringify({ type: 'created', code, side: 0, team: teams[0], mysterious }));
    }

    else if (msg.type === 'join') {
      const r = rooms[msg.code];
      if (!r) return ws.send(JSON.stringify({ type: 'error', msg: 'Комната не найдена' }));
      if (r.count >= 2) return ws.send(JSON.stringify({ type: 'error', msg: 'Комната заполнена' }));
      if (r.mysterious) {
        const others = ALL_TEAMS.filter(t => t !== r.teams[0]);
        r.teams[1] = others[Math.floor(Math.random() * others.length)];
      } else {
        r.teams[1] = msg.team;
      }
      room = r; myKey = 'g'; mySide = 1; r.count = 2;
      r.ws.g = ws;
      r.inp = { 0: { u:0,d:0,l:0,r:0,shoot:0,pass:0,switchBtn:false }, 1: { u:0,d:0,l:0,r:0,shoot:0,pass:0,switchBtn:false } };
      const g = makeState(r.teams);
      g.controlled = [10, 10]; // forwards by default
      r.state = g;
      Object.entries(r.ws).forEach(([k, w]) => {
        w.send(JSON.stringify({ type: 'start', side: k === 'h' ? 0 : 1, teams: r.teams, mysterious: r.mysterious }));
      });
      r.iv = setInterval(() => gameTick(r), 1000/60);
    }

    else if (msg.type === 'inp') {
      if (room && room.inp[mySide]) {
        Object.assign(room.inp[mySide], msg.d);
      }
    }

    else if (msg.type === 'shoot') {
      if (!room || !room.state) return;
      const g = room.state;
      const ctrl = g.controlled[mySide];
      if (ctrl < 0) return;
      const p = g.players[mySide * 11 + ctrl];
      if (!p) return;
      const b = g.ball;
      const distToBall = Math.hypot(p.x - b.x, p.y - b.y);
      if (distToBall > 2.5) return;
      const gx = mySide === 0 ? FW : 0;
      const gy = GY1 + GW/2;
      const spread = (Math.random() - 0.5) * (msg.finesse ? 1.5 : 3);
      const ang = Math.atan2(gy + spread - b.y, gx - b.x);
      const pwr = 22 + Math.random() * 4;
      b.vx = Math.cos(ang) * pwr * p.shootMult;
      b.vy = Math.sin(ang) * pwr;
      b.vz = msg.chip ? 8 : (msg.low ? 0 : 3 + Math.random() * 3);
      b.lastTouch = mySide;
    }

    else if (msg.type === 'pass') {
      if (!room || !room.state) return;
      const g = room.state;
      const ctrl = g.controlled[mySide];
      if (ctrl < 0) return;
      const p = g.players[mySide * 11 + ctrl];
      if (!p) return;
      const b = g.ball;
      const distToBall = Math.hypot(p.x - b.x, p.y - b.y);
      if (distToBall > 2.5) return;
      // Find best pass target (forward-most teammate not controlled)
      const dir = mySide === 0 ? 1 : -1;
      let best = null, bestScore = -999;
      for (let i = 0; i < 11; i++) {
        if (i === ctrl) continue;
        const t = g.players[mySide * 11 + i];
        const forwardness = (t.x - p.x) * dir;
        const openness = 99; // simplified
        const score = forwardness * 0.6 + openness * 0.4;
        if (score > bestScore) { bestScore = score; best = t; }
      }
      if (best) {
        const ang = Math.atan2(best.y - b.y, best.x - b.x);
        const dist = Math.hypot(best.x - b.x, best.y - b.y);
        const pwr = Math.min(dist * 1.8, 20);
        b.vx = Math.cos(ang) * pwr;
        b.vy = Math.sin(ang) * pwr;
        b.vz = msg.lob ? dist * 0.15 : 0;
        b.lastTouch = mySide;
        g.controlled[mySide] = best.idx;
      }
    }

    else if (msg.type === 'switch') {
      if (!room || !room.state) return;
      const g = room.state;
      let best = g.controlled[mySide], bestDist = 9999;
      for (let i = 0; i < 11; i++) {
        if (i === g.controlled[mySide]) continue;
        const pp = g.players[mySide*11+i];
        const d = Math.hypot(pp.x - g.ball.x, pp.y - g.ball.y);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      g.controlled[mySide] = best;
    }
  });

  ws.on('close', () => {
    if (!room) return;
    delete room.ws[myKey];
    if (Object.keys(room.ws).length === 0) { clearInterval(room.iv); delete rooms[room.code]; }
    else bcast(room, { t: 'opleft' });
  });
});

server.listen(PORT, () => console.log(`⚽ FIFA сервер: http://localhost:${PORT}`));
