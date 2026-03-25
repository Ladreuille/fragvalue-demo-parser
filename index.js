const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const os      = require('os');
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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'FragValue Demo Parser CS2', version: '6.2.0' }));

app.post('/parse', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  const demoPath   = req.file.path;
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

  // ── 1. Infos joueurs ──────────────────────────────────────────────────────
  const playerInfoRaw = parsePlayerInfo(demoPath);
  const playerNames = [...new Set(playerInfoRaw.map(p => p.name).filter(Boolean))];
  console.log(`Players: ${playerNames.join(', ')}`);

  // Map steamid → name
  const steamToName = {};
  playerInfoRaw.forEach(p => { if (p.steamid && p.name) steamToName[String(p.steamid)] = p.name; });

  // ── 2. Kills ──────────────────────────────────────────────────────────────
  const killEvents = parseEvent(
    demoPath,
    'player_death',
    ['X', 'Y', 'Z', 'team_num'],
    ['weapon', 'headshot', 'thrusmoke', 'penetrated', 'total_rounds_played']
  );

  const kills = killEvents.map(e => ({
    round:        e.total_rounds_played ?? 0,
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
    weapon:       e.weapon    || '',
    isHeadshot:   !!e.headshot,
    thruSmoke:    !!e.thrusmoke,
    isWallbang:   (e.penetrated ?? 0) > 0,
  })).filter(k => k.attacker !== 'Unknown' && k.victim !== 'Unknown');

  console.log(`Kills: ${kills.length}`);

  // ── 3. Map name ───────────────────────────────────────────────────────────
  let mapName = 'de_dust2';
  try {
    const serverInfo = parseEvent(demoPath, 'server_info', [], ['map_name']);
    if (serverInfo.length > 0 && serverInfo[0].map_name) {
      mapName = serverInfo[0].map_name.replace(/^workshop\/\d+\//, '');
    }
  } catch(e) {
    const known = ['de_dust2','de_mirage','de_inferno','de_nuke','de_ancient','de_anubis','de_overpass'];
    for (const m of known) { if (demoPath.includes(m)) { mapName = m; break; } }
  }
  console.log(`Map: ${mapName}`);

  // ── 4. Rounds ─────────────────────────────────────────────────────────────
  const roundEndEvents = parseEvent(demoPath, 'round_end', [], ['winner', 'reason', 'total_rounds_played']);
  const rounds = roundEndEvents.map((e, i) => ({
    round:  e.total_rounds_played ?? i + 1,
    winner: e.winner ?? 0,
    reason: e.reason ?? 0,
  }));
  const totalRounds = rounds.length || 1;
  console.log(`Rounds: ${totalRounds}`);

  // ── 5. Positions via parseTicks avec sample manuel ─────────────────────────
  // Stratégie : on essaie parseTicks, si ca crash on reconstruit depuis les kills
  let positions = {};

  try {
    console.log('Trying parseTicks...');
    const tickData = parseTicks(demoPath, ['X', 'Y', 'Z', 'team_num', 'steamid']);

    // Vérifier que tickData est bien itérable
    if (!tickData || typeof tickData[Symbol.iterator] !== 'function') {
      throw new Error('parseTicks did not return iterable');
    }

    let i = 0;
    const SAMPLE = 128; // 1 tick sur 128 pour éviter surcharge mémoire
    for (const t of tickData) {
      i++;
      if (i % SAMPLE !== 0) continue;
      if (t.X == null) continue;
      const name = steamToName[String(t.steamid)] || String(t.steamid);
      if (!name) continue;
      if (!positions[name]) positions[name] = [];
      // Limiter à 500 points par joueur max
      if (positions[name].length >= 500) continue;
      positions[name].push({ x: t.X, y: t.Y, z: t.Z, team: t.team_num });
    }

    const fp = Object.keys(positions)[0];
    if (fp) {
      console.log(`parseTicks OK — ${fp}: ${positions[fp].length} points`);
    } else {
      throw new Error('parseTicks returned no usable positions');
    }

  } catch(e) {
    console.warn('parseTicks failed:', e.message);
    console.log('Fallback: reconstructing positions from kills + hurt events...');

    // FALLBACK : reconstruire les positions depuis player_hurt + kills
    // player_hurt donne des positions fréquentes et fiables
    try {
      const hurtEvents = parseEvent(
        demoPath, 'player_hurt',
        ['X', 'Y', 'Z', 'team_num'],
        ['total_rounds_played']
      );

      hurtEvents.forEach(e => {
        // Attacker position
        const attName = e.attacker_name || e.attacker;
        if (attName && attName !== 'Unknown' && e.attacker_X != null) {
          if (!positions[attName]) positions[attName] = [];
          if (positions[attName].length < 400) {
            positions[attName].push({ x: e.attacker_X, y: e.attacker_Y, z: e.attacker_Z, team: e.attacker_team_num ?? 0 });
          }
        }
        // Victim position
        const vicName = e.user_name || e.user;
        if (vicName && vicName !== 'Unknown' && e.user_X != null) {
          if (!positions[vicName]) positions[vicName] = [];
          if (positions[vicName].length < 400) {
            positions[vicName].push({ x: e.user_X, y: e.user_Y, z: e.user_Z, team: e.user_team_num ?? 0 });
          }
        }
      });
      console.log(`Fallback positions from player_hurt: ${Object.keys(positions).length} players`);
    } catch(e2) {
      console.warn('player_hurt fallback failed:', e2.message);

      // FALLBACK 2 : utiliser uniquement les positions de kills (moins dense mais fiable)
      kills.forEach(k => {
        if (!positions[k.attacker]) positions[k.attacker] = [];
        positions[k.attacker].push({ x: k.attackerX, y: k.attackerY, z: k.attackerZ, team: k.attackerTeam });
        if (!positions[k.victim]) positions[k.victim] = [];
        positions[k.victim].push({ x: k.victimX, y: k.victimY, z: k.victimZ, team: k.victimTeam });
      });
      console.log(`Fallback positions from kills only: ${Object.keys(positions).length} players`);
    }
  }

  console.log(`Positions: ${Object.keys(positions).length} players, sample sizes: ${Object.entries(positions).slice(0,3).map(([k,v])=>`${k}:${v.length}`).join(', ')}`);

  // ── 6. Grenades ───────────────────────────────────────────────────────────
  let grenades = [];
  try {
    const grenadeEvents = parseEvent(
      demoPath, 'weapon_fire',
      ['X', 'Y', 'Z', 'team_num'],
      ['weapon']
    );
    const grenadeTypes = new Set(['weapon_flashbang','weapon_smokegrenade','weapon_hegrenade','weapon_molotov','weapon_incgrenade']);
    grenades = grenadeEvents
      .filter(e => grenadeTypes.has(e.weapon))
      .map(e => ({
        round:   e.total_rounds_played ?? 0,
        type:    e.weapon,
        thrower: e.user_name || e.user || 'Unknown',
        team:    e.user_team_num ?? 0,
        startX:  e.user_X ?? 0,
        startY:  e.user_Y ?? 0,
        startZ:  e.user_Z ?? 0,
      }));
  } catch(e) {
    console.warn('Grenades warning:', e.message);
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

  // ── 9. Target player ──────────────────────────────────────────────────────
  const allNames = playerStats.map(p => p.name);
  const resolvedTarget = targetPlayer && allNames.includes(targetPlayer)
    ? targetPlayer
    : playerStats[0]?.name || null;

  return {
    meta: {
      map: mapName, rounds: totalRounds, totalKills: kills.length,
      players: allNames, parsedAt: new Date().toISOString(), targetPlayer: resolvedTarget,
    },
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

app.listen(PORT, () => console.log(`FragValue Demo Parser CS2 v6.2 on port ${PORT}`));
