const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { parseEvent, parsePlayerInfo, parseTicks } = require('@laihoe/demoparser2');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 600 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith('.dem')) return cb(new Error('Seuls les fichiers .dem sont acceptés'));
    cb(null, true);
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'FragValue Demo Parser CS2', version: '6.0.0' }));

app.post('/parse', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });

  const demoPath   = req.file.path;
  const targetPlayer = req.body.player || null;
  console.log(`Parsing CS2 demo: ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(1)} MB)`);

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

// ─── PARSER PRINCIPAL ─────────────────────────────────────────────────────────
async function parseCS2Demo(demoPath, targetPlayer) {

  // ── 1. Infos joueurs (vrais pseudos + steamid) ────────────────────────────
  const playerInfoRaw = parsePlayerInfo(demoPath);
  // playerInfoRaw = [{ name, steamid, team_number, ... }]
  const playerInfoMap = {}; // steamid → name
  playerInfoRaw.forEach(p => { if (p.steamid) playerInfoMap[p.steamid] = p.name; });
  const playerNames = [...new Set(playerInfoRaw.map(p => p.name).filter(Boolean))];
  console.log(`Players found: ${playerNames.join(', ')}`);

  // ── 2. Kills ──────────────────────────────────────────────────────────────
  const killEvents = parseEvent(demoPath, 'player_death', [
    'attacker_name', 'attacker_team_num', 'attacker_X', 'attacker_Y', 'attacker_Z',
    'user_name',     'user_team_num',     'user_X',     'user_Y',     'user_Z',
    'weapon', 'headshot', 'thrusmoke', 'penetrated',
  ]);

  const kills = killEvents.map(e => ({
    round:        e.round ?? 0,
    attacker:     e.attacker_name  || 'Unknown',
    attackerTeam: e.attacker_team_num ?? 0,
    attackerX:    e.attacker_X    ?? 0,
    attackerY:    e.attacker_Y    ?? 0,
    attackerZ:    e.attacker_Z    ?? 0,
    victim:       e.user_name     || 'Unknown',
    victimTeam:   e.user_team_num ?? 0,
    victimX:      e.user_X        ?? 0,
    victimY:      e.user_Y        ?? 0,
    victimZ:      e.user_Z        ?? 0,
    weapon:       e.weapon        || '',
    isHeadshot:   !!e.headshot,
    thruSmoke:    !!e.thrusmoke,
    isWallbang:   (e.penetrated ?? 0) > 0,
  })).filter(k => k.attacker !== 'Unknown' && k.victim !== 'Unknown');

  console.log(`Kills parsed: ${kills.length}`);

  // ── 3. Map name ───────────────────────────────────────────────────────────
  const roundStartEvents = parseEvent(demoPath, 'round_start', []);
  let mapName = 'de_dust2';
  try {
    // map_name est dans les infos header — chercher via round_announce ou server_info
    const serverInfo = parseEvent(demoPath, 'server_info', ['map_name']);
    if (serverInfo.length > 0 && serverInfo[0].map_name) {
      mapName = serverInfo[0].map_name;
    }
  } catch(e) {
    // Fallback : chercher dans le nom du fichier ou laisser dust2
    const known = ['de_dust2','de_mirage','de_inferno','de_nuke','de_ancient','de_anubis','de_overpass'];
    for (const m of known) { if (demoPath.includes(m)) { mapName = m; break; } }
  }
  console.log(`Map: ${mapName}`);

  // ── 4. Rounds ─────────────────────────────────────────────────────────────
  const roundEndEvents = parseEvent(demoPath, 'round_end', ['winner', 'reason']);
  const rounds = roundEndEvents.map((e, i) => ({
    round:  i + 1,
    winner: e.winner ?? 0,
    reason: e.reason ?? 0,
  }));
  const totalRounds = rounds.length || 1;
  console.log(`Rounds: ${totalRounds}`);

  // ── 5. Positions (ticks) ──────────────────────────────────────────────────
  // On sample 1 tick toutes les 256 ticks pour ne pas exploser la mémoire
  let positions = {};
  try {
    const tickData = parseTicks(demoPath, ['X', 'Y', 'Z', 'name', 'team_num'], { every_nth_tick: 256 });
    tickData.forEach(t => {
      if (!t.name || t.X == null) return;
      if (!positions[t.name]) positions[t.name] = [];
      positions[t.name].push({ tick: t.tick, x: t.X, y: t.Y, z: t.Z, team: t.team_num });
    });
  } catch(e) {
    console.warn('Positions parse warning:', e.message);
    // positions reste vide — pas bloquant
  }
  console.log(`Positions for ${Object.keys(positions).length} players`);

  // ── 6. Grenades ───────────────────────────────────────────────────────────
  let grenades = [];
  try {
    const grenadeEvents = parseEvent(demoPath, 'weapon_fire', [
      'user_name', 'user_team_num', 'user_X', 'user_Y', 'user_Z', 'weapon'
    ]);
    const grenadeTypes = new Set(['weapon_flashbang','weapon_smokegrenade','weapon_hegrenade','weapon_molotov','weapon_incgrenade']);
    grenades = grenadeEvents
      .filter(e => grenadeTypes.has(e.weapon))
      .map(e => ({
        round:   e.round ?? 0,
        type:    e.weapon,
        thrower: e.user_name || 'Unknown',
        team:    e.user_team_num ?? 0,
        startX:  e.user_X ?? 0,
        startY:  e.user_Y ?? 0,
        startZ:  e.user_Z ?? 0,
      }));
  } catch(e) {
    console.warn('Grenades parse warning:', e.message);
  }
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
    name:   p.name,
    kills:  p.kills,
    deaths: p.deaths,
    hs:     p.hs,
    kd:     p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2),
    hsPct:  p.kills > 0  ? ((p.hs / p.kills) * 100).toFixed(1) : '0.0',
  })).sort((a, b) => b.kills - a.kills);

  // ── 8. Duel zones ─────────────────────────────────────────────────────────
  const duelZones = computeDuelZones(kills, mapName);

  // ── 9. targetPlayer ───────────────────────────────────────────────────────
  // Si le nom passé est un pseudo exact → ok, sinon prendre le 1er joueur
  const resolvedTarget = targetPlayer && playerNames.includes(targetPlayer)
    ? targetPlayer
    : playerStats[0]?.name || null;

  return {
    meta: {
      map:         mapName,
      rounds:      totalRounds,
      totalKills:  kills.length,
      players:     playerNames,
      parsedAt:    new Date().toISOString(),
      targetPlayer: resolvedTarget,
    },
    kills:       kills.slice(0, 5000),
    positions,
    grenades,
    rounds,
    playerStats,
    duelZones,
  };
}

// ─── DUEL ZONES ───────────────────────────────────────────────────────────────
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
    key, col: z.col, row: z.row,
    kills: z.kills, deaths: z.deaths,
    winRate: z.kills+z.deaths > 0 ? ((z.kills/(z.kills+z.deaths))*100).toFixed(0) : '50',
  }));
}

app.listen(PORT, () => console.log(`FragValue Demo Parser CS2 v6.0 on port ${PORT}`));
