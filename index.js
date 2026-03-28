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
    const result = await parseCS2Demo(demoPath, targetPlayer, req.file.originalname || '');
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Parse error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(demoPath, () => {});
  }
});

async function parseCS2Demo(demoPath, targetPlayer, originalName = '') {

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
  if (kills.length > 0) {
    const kX = kills.map(k => k.attackerX), kY = kills.map(k => k.attackerY);
    console.log(`Kill coord range: X[${Math.min(...kX).toFixed(0)}, ${Math.max(...kX).toFixed(0)}] Y[${Math.min(...kY).toFixed(0)}, ${Math.max(...kY).toFixed(0)}]`);
    // Sample tick range pour calculer durée rounds
    const r1kills = kills.filter(k => k.round === 1);
    if (r1kills.length > 0) console.log(`Round 1 tick range: ${Math.min(...r1kills.map(k=>k.tick))} - ${Math.max(...r1kills.map(k=>k.tick))}`);
  }

  // ── 3. Map — lire depuis le header binaire du fichier .dem ─────────────
  // Le format CS2 demo (.dem) commence par un magic "PBDEMS2" suivi d'un header
  // protobuf qui contient le nom de la map dans les premiers 1024 octets
  let mapName = 'unknown';
  try {
    const headerBuf = Buffer.alloc(1024);
    const fdHeader = fs.openSync(demoPath, 'r');
    fs.readSync(fdHeader, headerBuf, 0, 1024, 0);
    fs.closeSync(fdHeader);
    const headerStr = headerBuf.toString('latin1');
    // Chercher un pattern "de_XXX" dans le header
    const knownMaps = ['de_dust2','de_mirage','de_inferno','de_nuke','de_ancient','de_anubis','de_overpass','de_vertigo','de_cache','de_train','de_cbble','de_tuscan'];
    const foundInHeader = knownMaps.find(m => headerStr.includes(m));
    if (foundInHeader) {
      mapName = foundInHeader;
      console.log(`Map from binary header: ${mapName}`);
    }
  } catch(e) {
    console.warn('Header read error:', e.message);
  }

  // Fallback A : server_info event
  if (mapName === 'unknown') {
    try {
      const si = parseEvent(demoPath, 'server_info', [], ['map_name']);
      console.log(`server_info events: ${si.length}`);
      if (si.length > 0 && (si[0].map_name || si[0].map)) {
        const raw = si[0].map_name || si[0].map || '';
        mapName = raw.replace(/^workshop\/\d+\//, '').replace(/^.*[\/\\]/, '').trim();
        console.log(`Map from server_info: ${mapName}`);
      }
    } catch(e) { console.warn('server_info:', e.message); }
  }

  // Fallback B : nom du fichier uploadé
  if (mapName === 'unknown') {
    const fileBasename = require('path').basename(originalName || '', '.dem').toLowerCase();
    const knownMaps2 = ['de_dust2','de_mirage','de_inferno','de_nuke','de_ancient','de_anubis','de_overpass','de_vertigo','de_cache'];
    const foundMap = knownMaps2.find(m => fileBasename.includes(m) || fileBasename.includes(m.replace('de_','')));
    if (foundMap) { mapName = foundMap; console.log(`Map from filename: ${mapName}`); }
    else mapName = 'de_dust2'; // dernier fallback
  }

  console.log(`Map final: ${mapName}`);

  // ── 4. Rounds ────────────────────────────────────────────────────────────
  const roundEndEvents = parseEvent(demoPath, 'round_end', [], ['winner', 'reason', 'total_rounds_played', 'tick']);
  if (roundEndEvents.length > 0) {
    const s = roundEndEvents[0];
    console.log(`round_end sample keys: ${Object.keys(s).join(', ')}`);
    console.log(`round_end[0]: winner=${s.winner} reason=${s.reason} tick=${s.tick} rounds=${s.total_rounds_played}`);
  }
  // winner=null signifie que le champ existe mais est null dans demoparser2
  // Dans CS2, winner vient du champ 'winner' de round_end_reason
  // On déduit le gagnant depuis le round_official_end ou depuis les kills
  const rounds = roundEndEvents.map((e, i) => {
    // Tenter de lire winner (peut être null, 0, 2, ou 3)
    let winner = e.winner ?? e.winner_team ?? null;
    // Si winner est null ou 0, on le laisse à 0 — sera résolu côté frontend
    if (winner === null) winner = 0;
    return {
      round:   e.total_rounds_played ?? i + 1,
      winner,
      reason:  e.reason ?? 0,
      endTick: e.tick ?? 0,
    };
  });

  // Tenter round_official_end pour avoir le winner
  try {
    const officialEnd = parseEvent(demoPath, 'round_mvp', [], ['total_rounds_played', 'tick']);
    // round_announce_win a le winner
    const announceWin = parseEvent(demoPath, 'round_announce_win', [], ['winner', 'total_rounds_played', 'tick']);
    if (announceWin.length > 0) {
      console.log(`round_announce_win[0]: winner=${announceWin[0].winner} rounds=${announceWin[0].total_rounds_played}`);
      announceWin.forEach(e => {
        const r = (e.total_rounds_played ?? 1) - 1; // index 0-based
        if (rounds[r] && e.winner != null) rounds[r].winner = e.winner;
      });
    }
  } catch(e) { console.warn('round_announce_win:', e.message); }

  const winnerCheck = rounds.slice(0,3).map(r=>`R${r.round}:w${r.winner}`).join(' ');
  console.log(`Rounds winner check: ${winnerCheck}`);

  // Récupérer le tick de fin de freeze (= début réel du round, joueurs peuvent bouger)
  const roundStartTicks = {}; // round → tick de début
  try {
    const freezeEndEvents = parseEvent(demoPath, 'round_freeze_end', [], ['total_rounds_played', 'tick']);
    freezeEndEvents.forEach(e => {
      roundStartTicks[e.total_rounds_played ?? 0] = e.tick ?? 0;
    });
    console.log(`Freeze end events: ${freezeEndEvents.length}`);
  } catch(e) {
    console.warn('round_freeze_end failed:', e.message);
  }

  console.log(`Rounds: ${rounds.length}`);

  // ── 5. Positions continues via parseTicks ────────────────────────────────
  // parseTicks donne X/Y/team_num à chaque tick enregistré dans la démo
  // On échantillonne 1 tick sur TICK_SAMPLE pour garder un payload raisonnable
  // tout en ayant ~8-16 positions/seconde par joueur → replay très fluide

  const { parseTicks } = require('@laihoe/demoparser2');
  let positions = {};
  const TICK_SAMPLE = 32; // 1 tick sur 32 → ~2-4fps positions, suffisant pour replay fluide
  // sessionStorage limite ~5MB — 32 donne ~3MB pour 10 joueurs

  try {
    const tickData = parseTicks(demoPath, ['X', 'Y', 'team_num', 'total_rounds_played']);
    console.log(`parseTicks raw rows: ${tickData.length}`);
    if (tickData.length > 0) {
      const sample = tickData[0];
      console.log(`parseTicks sample keys: ${Object.keys(sample).join(', ')}`);
      // Collecter steamids uniques et leurs noms
      const seenIds = new Map();
      tickData.slice(0,500).forEach(r => {
        const sid = String(r.steamid);
        if (!seenIds.has(sid)) seenIds.set(sid, r.name || r.player_name || 'NULL');
      });
      console.log(`parseTicks steamids sample: ${[...seenIds.entries()].map(([k,v])=>k+'='+v).join(', ')}`);
      console.log(`steamToName keys: ${Object.values(steamToName).join(', ')}`);
    }

    // Associer steamid → nom via steamToName
    // Logger le type exact des steamids dans parseTicks vs steamToName
    const sampleSids = new Map();
    tickData.slice(0, 1000).forEach(row => {
      const sid = row.steamid;
      const sidStr = String(sid);
      if (!sampleSids.has(sidStr)) {
        sampleSids.set(sidStr, { type: typeof sid, val: sid, name: row.name||'' });
      }
    });
    console.log('steamToName keys types:', Object.keys(steamToName).slice(0,3).map(k => `${k}(${typeof k})`).join(', '));
    console.log('parseTicks steamid types:', [...sampleSids.entries()].slice(0,3).map(([k,v]) => `${k}(${v.type})=${v.name}`).join(', '));
    
    // Construire sidToName en normalisant les deux côtés
    const sidToName = {};
    // Ajouter steamToName (clés = strings)
    Object.entries(steamToName).forEach(([k,v]) => { sidToName[String(k)] = v; });
    // Compléter avec noms parseTicks
    tickData.forEach(row => {
      const sid = String(row.steamid ?? '');
      if (!sid || sid === 'undefined' || sid === 'null') return;
      if (sidToName[sid]) return;
      const n = row.name || row.player_name || '';
      if (n && n !== 'unknown' && n !== '') sidToName[sid] = n;
    });
    console.log(`sidToName resolved (${Object.keys(sidToName).length}): ${Object.values(sidToName).join(', ')}`);

    // Debug : compter rows par joueur avant filtrage
    const rowCountBySid = {};
    const validCoordBySid = {};
    tickData.forEach(row => {
      const sid = String(row.steamid||'');
      if(!sid) return;
      rowCountBySid[sid] = (rowCountBySid[sid]||0) + 1;
      const x = row.X??row.x??null, y = row.Y??row.y??null;
      if(x!=null && y!=null && !(x===0&&y===0) && Math.abs(x)<=10000 && Math.abs(y)<=10000)
        validCoordBySid[sid] = (validCoordBySid[sid]||0) + 1;
    });
    Object.entries(sidToName).forEach(([sid,name]) => {
      console.log(`  ${name}: ${rowCountBySid[sid]||0} rows total, ${validCoordBySid[sid]||0} valid coords`);
    });

    tickData.forEach((row, idx) => {
      // Échantillonnage : garder 1 tick sur TICK_SAMPLE
      if (idx % TICK_SAMPLE !== 0) return;

      const sid = String(row.steamid || '');
      const name = sidToName[sid] || steamToName[sid] || null;
      if (!name) return;

      const x = row.X ?? row.x ?? null;
      const y = row.Y ?? row.y ?? null;
      if (x == null || y == null || (x === 0 && y === 0)) return;
      if (Math.abs(x) > 10000 || Math.abs(y) > 10000) return;

      const team  = row.team_num ?? 0;
      const round = row.total_rounds_played ?? 0;
      const tick  = row.tick ?? 0;

      if (!positions[name]) positions[name] = [];
      if (positions[name].length >= 8000) return;
      positions[name].push({
        x: Math.round(x),
        y: Math.round(y),
        team,
        round,
        tick,
      });
    });

    // Tri par round + tick
    Object.keys(positions).forEach(name => {
      positions[name].sort((a, b) => a.round !== b.round ? a.round - b.round : a.tick - b.tick);
    });

    const totalPos = Object.values(positions).reduce((s, v) => s + v.length, 0);
    console.log(`Positions parseTicks: ${Object.keys(positions).length} joueurs, ${totalPos} pts total`);
    console.log(`Joueurs dans positions: ${Object.keys(positions).join(', ')}`);
    const missing = playerNames.filter(n => !positions[n]);
    if (missing.length) console.log(`Joueurs MANQUANTS dans positions: ${missing.join(', ')}`);
    console.log(`Sample: ${Object.entries(positions).slice(0,4).map(([k,v])=>`${k}:${v.length}`).join(', ')}`);

  } catch(e) {
    console.warn('parseTicks failed:', e.message);
    // Fallback footstep si parseTicks non disponible
    try {
      const footEvents = parseEvent(demoPath, 'player_footstep', ['X', 'Y', 'team_num'], ['total_rounds_played', 'tick']);
      footEvents.forEach(e => {
        const name = e.user_name || steamToName[String(e.user_steamid)] || null;
        if (!name) return;
        const x = e.user_X ?? null, y = e.user_Y ?? null;
        if (x == null || y == null || (x === 0 && y === 0)) return;
        if (!positions[name]) positions[name] = [];
        positions[name].push({ x: Math.round(x), y: Math.round(y), team: e.user_team_num ?? 0, round: e.total_rounds_played ?? 0, tick: e.tick ?? 0 });
      });
      Object.keys(positions).forEach(n => positions[n].sort((a,b) => a.round!==b.round?a.round-b.round:a.tick-b.tick));
      console.log(`Fallback footstep: ${Object.values(positions).reduce((s,v)=>s+v.length,0)} pts`);
    } catch(e2) { console.warn('Fallback footstep also failed:', e2.message); }
  }

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

  // Compresser les kills pour réduire la taille du payload
  const compactKills = kills.slice(0, 3000).map(k => ({
    r: k.round, t: k.tick,
    a: k.attacker, at: k.attackerTeam,
    ax: Math.round(k.attackerX), ay: Math.round(k.attackerY),
    v: k.victim, vt: k.victimTeam,
    vx: Math.round(k.victimX), vy: Math.round(k.victimY),
    w: k.weapon, h: k.isHeadshot?1:0, s: k.thruSmoke?1:0, wb: k.isWallbang?1:0,
  }));

  return {
    meta: { map: mapName, rounds: rounds.length, totalKills: kills.length, players: allNames, parsedAt: new Date().toISOString(), targetPlayer: resolvedTarget },
    kills: compactKills,
    positions, grenades: grenades.slice(0, 500), rounds, roundStartTicks, playerStats, duelZones,
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
