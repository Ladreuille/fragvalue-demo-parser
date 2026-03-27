const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const os      = require('os');
const { parseEvent, parsePlayerInfo } = require('@laihoe/demoparser2');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: [
    'https://frag-value.vercel.app',
    'https://frag-value-git-main-ladreuilles-projects.vercel.app',
    /\.vercel\.app$/,
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));
app.options('*', cors());
app.use(express.json());

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 600 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith('.dem')) return cb(new Error('Seuls les fichiers .dem sont acceptés'));
    cb(null, true);
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'FragValue Demo Parser CS2', version: '6.3.0' }));

app.post('/parse', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  const demoPath     = req.file.path;
  const targetPlayer = req.body.player || null;
  console.log(`Parsing: ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(1)} MB)`);
  res.setTimeout(300000);
  try {
    const result = await parseCS2Demo(demoPath, targetPlayer);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Parse error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(demoPath, () => {});
  }
});

async function parseCS2Demo(demoPath, targetPlayer) {

  // ── 1. Infos joueurs ─────────────────────────────────────────────────────
  const playerInfoRaw = parsePlayerInfo(demoPath);
  const playerNames   = [...new Set(playerInfoRaw.map(p => p.name).filter(Boolean))];
  console.log(`Players: ${playerNames.join(', ')}`);

  const steamToName = {};
  playerInfoRaw.forEach(p => { if (p.steamid && p.name) steamToName[String(p.steamid)] = p.name; });

  // ── 2. Kills ─────────────────────────────────────────────────────────────
  const killEvents = parseEvent(
    demoPath, 'player_death',
    ['X', 'Y', 'Z', 'team_num'],
    ['weapon', 'headshot', 'thrusmoke', 'penetrated', 'total_rounds_played', 'tick']
  );

  const kills = killEvents.map(e => ({
    round:        e.total_rounds_played ?? 0,
    tick:         e.tick ?? 0,
    attacker:     e.attacker_name  || e.attacker || 'Unknown',
    attackerTeam: e.attacker_team_num ?? 0,
    attackerX:    e.attacker_X ?? 0,
    attackerY:    e.attacker_Y ?? 0,
    attackerZ:    e.attacker_Z ?? 0,
    victim:       e.user_name || e.user || 'Unknown',
    victimTeam:   e.user_team_num ?? 0,
    victimX:      e.user_X ?? 0,
    victimY:      e.user_Y ?? 0,
    victimZ:      e.user_Z ?? 0,
    weapon:       e.weapon  || '',
    isHeadshot:   !!e.headshot,
    thruSmoke:    !!e.thrusmoke,
    isWallbang:   (e.penetrated ?? 0) > 0,
  })).filter(k => k.attacker !== 'Unknown' && k.victim !== 'Unknown');
  console.log(`Kills: ${kills.length}`);

  // ── 3. Map ───────────────────────────────────────────────────────────────
  let mapName = 'de_dust2';
  try {
    const si = parseEvent(demoPath, 'server_info', [], ['map_name']);
    if (si.length > 0 && si[0].map_name)
      mapName = si[0].map_name.replace(/^workshop\/\d+\//, '');
  } catch(e) {}
  console.log(`Map: ${mapName}`);

  // ── 4. Rounds ────────────────────────────────────────────────────────────
  const roundEndEvents = parseEvent(demoPath, 'round_end', [], ['winner', 'reason', 'total_rounds_played']);
  const rounds = roundEndEvents.map((e, i) => ({
    round:  e.total_rounds_played ?? i + 1,
    winner: e.winner ?? 0,
    reason: e.reason ?? 0,
  }));
  console.log(`Rounds: ${rounds.length}`);

  // ── 5. Positions ─────────────────────────────────────────────────────────
  // Stratégie multi-sources pour maximiser la couverture :
  // Source A : player_footstep   → position à chaque pas (~3-5/seconde)
  // Source B : weapon_fire       → position à chaque tir
  // Source C : player_hurt       → position lors de dégâts
  // Source D : kills             → position à la mort
  // Toutes sources fusionnées, triées par tick, limitées à 3000/joueur

  let positions = {};
  const MAX_POS = 3000;

  const addPos = (name, x, y, z, team, round, tick) => {
    if (!name || name === 'Unknown' || x == null || x === 0 && y === 0) return;
    if (!positions[name]) positions[name] = [];
    if (positions[name].length >= MAX_POS) return;
    positions[name].push({ x, y, z: z||0, team: team||0, round: round||0, tick: tick||0 });
  };

  // Source A — player_footstep (meilleure couverture des déplacements)
  // demoparser2 : pour player_footstep, le joueur est dans 'user', coords dans player props
  let footstepCount = 0;
  try {
    // Tester les deux signatures possibles selon version demoparser2
    let footEvents = [];
    try {
      // Signature v1 : user props = X,Y,Z,team_num
      footEvents = parseEvent(demoPath, 'player_footstep', ['X', 'Y', 'Z', 'team_num'], ['total_rounds_played', 'tick']);
      if (footEvents.length > 0) {
        const sample = footEvents[0];
        console.log(`Footstep sample keys: ${Object.keys(sample).join(', ')}`);
        footEvents.forEach(e => {
          // user_ prefix pour le joueur principal de l'event
          const name = e.user_name || e.user || steamToName[String(e.user_steamid)] || steamToName[String(e.userid)];
          const x = e.user_X ?? e.X ?? null;
          const y = e.user_Y ?? e.Y ?? null;
          const z = e.user_Z ?? e.Z ?? null;
          const team = e.user_team_num ?? e.team_num ?? 0;
          addPos(name, x, y, z, team, e.total_rounds_played, e.tick);
        });
        footstepCount = Object.values(positions).reduce((s, v) => s + v.length, 0);
        console.log(`Footstep positions added: ${footstepCount} total`);
      }
    } catch(e1) {
      console.warn('Footstep v1 failed:', e1.message);
      // Signature v2 : pas de player props
      try {
        footEvents = parseEvent(demoPath, 'player_footstep', [], ['total_rounds_played', 'tick', 'userid']);
        console.log(`Footstep v2 sample: ${footEvents.length > 0 ? Object.keys(footEvents[0]).join(', ') : 'empty'}`);
      } catch(e2) {
        console.warn('Footstep v2 failed:', e2.message);
      }
    }
  } catch(e) {
    console.warn('Footstep outer error:', e.message);
  }

  // Source B — weapon_fire (position à chaque tir, très précis)
  try {
    const fireEvents = parseEvent(demoPath, 'weapon_fire', ['X', 'Y', 'Z', 'team_num'], ['total_rounds_played', 'tick']);
    fireEvents.forEach(e => {
      const name = e.user_name || e.user;
      addPos(name, e.user_X ?? e.X, e.user_Y ?? e.Y, e.user_Z ?? e.Z,
             e.user_team_num ?? e.team_num, e.total_rounds_played, e.tick);
    });
    console.log(`After weapon_fire: ${Object.entries(positions).slice(0,3).map(([k,v])=>`${k}:${v.length}`).join(', ')}`);
  } catch(e) { console.warn('weapon_fire positions:', e.message); }

  // Source C — player_hurt (positions aux échanges)
  try {
    const hurtEvents = parseEvent(demoPath, 'player_hurt', ['X', 'Y', 'Z', 'team_num'], ['total_rounds_played', 'tick']);
    hurtEvents.forEach(e => {
      const r = e.total_rounds_played ?? 0, t = e.tick ?? 0;
      addPos(e.attacker_name || e.attacker, e.attacker_X, e.attacker_Y, e.attacker_Z, e.attacker_team_num, r, t);
      addPos(e.user_name     || e.user,     e.user_X,     e.user_Y,     e.user_Z,     e.user_team_num,     r, t);
    });
  } catch(e) { console.warn('player_hurt positions:', e.message); }

  // Source D — kills
  kills.forEach(k => {
    addPos(k.attacker, k.attackerX, k.attackerY, k.attackerZ, k.attackerTeam, k.round, k.tick);
    addPos(k.victim,   k.victimX,   k.victimY,   k.victimZ,   k.victimTeam,   k.round, k.tick + 1);
  });

  // Tri final par round+tick
  Object.keys(positions).forEach(name => {
    positions[name].sort((a, b) => a.round !== b.round ? a.round - b.round : a.tick - b.tick);
  });

  const totalPos = Object.values(positions).reduce((s, v) => s + v.length, 0);
  console.log(`Positions final: ${Object.keys(positions).length} players, ${totalPos} total pts`);
  console.log(`Sample: ${Object.entries(positions).slice(0,4).map(([k,v])=>`${k}:${v.length}`).join(', ')}`);

  // ── 6. Grenades ──────────────────────────────────────────────────────────
  let grenades = [];
  try {
    const grenadeTypes = new Set(['weapon_flashbang','weapon_smokegrenade','weapon_hegrenade','weapon_molotov','weapon_incgrenade']);
    const gEvents = parseEvent(demoPath, 'weapon_fire', ['X', 'Y', 'Z', 'team_num'], ['weapon', 'total_rounds_played', 'tick']);
    grenades = gEvents.filter(e => grenadeTypes.has(e.weapon)).map(e => ({
      round:   e.total_rounds_played ?? 0,
      type:    e.weapon,
      thrower: e.user_name || e.user || 'Unknown',
      team:    e.user_team_num ?? 0,
      startX:  e.user_X ?? 0,
      startY:  e.user_Y ?? 0,
      startZ:  e.user_Z ?? 0,
    }));
  } catch(e) { console.warn('Grenades warning:', e.message); }
  console.log(`Grenades: ${grenades.length}`);

  // ── 7. Player stats ───────────────────────────────────────────────────────
  const statsMap = {};
  kills.forEach(k => {
    if (!statsMap[k.attacker]) statsMap[k.attacker] = { name: k.attacker, kills: 0, deaths: 0, hs: 0 };
    if (!statsMap[k.victim])   statsMap[k.victim]   = { name: k.victim,   kills: 0, deaths: 0, hs: 0 };
    statsMap[k.attacker].kills++;
    statsMap[k.victim].deaths++;
    if (k.isHeadshot) statsMap[k.attacker].hs++;
  });
  const playerStats = Object.values(statsMap).map(p => ({
    name:  p.name, kills: p.kills, deaths: p.deaths, hs: p.hs,
    kd:    p.deaths > 0 ? (p.kills/p.deaths).toFixed(2) : p.kills.toFixed(2),
    hsPct: p.kills  > 0 ? ((p.hs/p.kills)*100).toFixed(1) : '0.0',
  })).sort((a, b) => b.kills - a.kills);

  // ── 8. Duel zones ─────────────────────────────────────────────────────────
  const duelZones = computeDuelZones(kills, mapName);

  // ── 9. Target player ──────────────────────────────────────────────────────
  const allNames = playerStats.map(p => p.name);
  const resolvedTarget = targetPlayer && allNames.includes(targetPlayer)
    ? targetPlayer : playerStats[0]?.name || null;

  return {
    meta: { map: mapName, rounds: rounds.length, totalKills: kills.length, players: allNames, parsedAt: new Date().toISOString(), targetPlayer: resolvedTarget },
    kills: kills.slice(0, 5000),
    positions, grenades, rounds, playerStats, duelZones,
  };
}

function computeDuelZones(kills, mapName) {
  const BOUNDS = {
    'de_dust2':   {minX:-2476,maxX:1444,minY:-1228,maxY:3346},
    'de_mirage':  {minX:-3230,maxX:870, minY:-2750,maxY:930},
    'de_inferno': {minX:-2087,maxX:2870,minY:-1200,maxY:3110},
    'de_nuke':    {minX:-3453,maxX:2497,minY:-3000,maxY:2200},
    'de_ancient': {minX:-2953,maxX:2164,minY:-1600,maxY:3200},
    'de_anubis':  {minX:-2796,maxX:2500,minY:-2000,maxY:3328},
    'de_overpass':{minX:-4831,maxX:1781,minY:-1600,maxY:3200},
  };
  const b = BOUNDS[mapName] || {minX:-3000,maxX:3000,minY:-3000,maxY:3000};
  const G = 10, zones = {};
  const clamp = v => Math.max(0, Math.min(G-1, v));
  kills.forEach(k => {
    const col = clamp(Math.floor(((k.attackerX-b.minX)/(b.maxX-b.minX))*G));
    const row = clamp(Math.floor(((k.attackerY-b.minY)/(b.maxY-b.minY))*G));
    const key = `${col}_${row}`;
    if (!zones[key]) zones[key] = {kills:0,deaths:0,col,row};
    zones[key].kills++;
  });
  kills.forEach(k => {
    const col = clamp(Math.floor(((k.victimX-b.minX)/(b.maxX-b.minX))*G));
    const row = clamp(Math.floor(((k.victimY-b.minY)/(b.maxY-b.minY))*G));
    const key = `${col}_${row}`;
    if (!zones[key]) zones[key] = {kills:0,deaths:0,col,row};
    zones[key].deaths++;
  });
  return Object.entries(zones).map(([key, z]) => ({
    key, col: z.col, row: z.row, kills: z.kills, deaths: z.deaths,
    winRate: z.kills+z.deaths > 0 ? ((z.kills/(z.kills+z.deaths))*100).toFixed(0) : '50',
  }));
}

app.listen(PORT, () => console.log(`FragValue Demo Parser CS2 v6.3 on port ${PORT}`));
