const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const fs       = require('fs');
const os       = require('os');
const { DemoFile, parseEvent } = require('demofile');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: ['https://frag-value.vercel.app', 'http://localhost:3000', 'http://localhost:5500'] }));
app.use(express.json());

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 600 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith('.dem')) return cb(new Error('Seuls les fichiers .dem sont acceptés'));
    cb(null, true);
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'FragValue Demo Parser', version: '2.0.0' }));

app.post('/parse', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  const demoPath   = req.file.path;
  const playerName = req.body.player || null;
  console.log(`Parsing: ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(1)} MB)`);
  try {
    const result = await parseDemo(demoPath, playerName);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Parse error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(demoPath, () => {});
  }
});

function parseDemo(demoPath, targetPlayer) {
  return new Promise((resolve, reject) => {
    const demoFile = new DemoFile();

    const kills     = [];
    const positions = {};
    const grenades  = [];
    const rounds    = [];
    const players   = {};
    let mapName     = '';
    let currentRound = 0;

    demoFile.on('start', () => {
      mapName = demoFile.header.mapName || '';
      console.log(`Map: ${mapName}`);
    });

    demoFile.gameEvents.on('round_start', () => { currentRound++; });

    demoFile.gameEvents.on('round_end', e => {
      rounds.push({ round: currentRound, winner: e.winner });
    });

    demoFile.gameEvents.on('player_death', e => {
      try {
        const attacker = demoFile.entities.getByUserId(e.attacker);
        const victim   = demoFile.entities.getByUserId(e.userid);
        if (!attacker || !victim) return;
        const aPos = attacker.position, vPos = victim.position;
        if (!aPos || !vPos) return;

        kills.push({
          round: currentRound,
          attacker: attacker.name, attackerTeam: attacker.teamNumber,
          attackerX: Math.round(aPos.x), attackerY: Math.round(aPos.y), attackerZ: Math.round(aPos.z),
          victim: victim.name, victimTeam: victim.teamNumber,
          victimX: Math.round(vPos.x), victimY: Math.round(vPos.y), victimZ: Math.round(vPos.z),
          weapon: e.weapon, isHeadshot: e.headshot,
          thruSmoke: e.through_smoke || false, noscope: e.noscope || false,
          isWallbang: (e.penetrated_objects || 0) > 0,
        });

        if (!players[attacker.name]) players[attacker.name] = { name: attacker.name, kills: 0, deaths: 0, hs: 0 };
        if (!players[victim.name])   players[victim.name]   = { name: victim.name,   kills: 0, deaths: 0, hs: 0 };
        players[attacker.name].kills++;
        players[victim.name].deaths++;
        if (e.headshot) players[attacker.name].hs++;
      } catch(err) {}
    });

    // Positions toutes les 128 ticks
    demoFile.on('tickend', tick => {
      if (tick % 128 !== 0) return;
      try {
        demoFile.entities.players.forEach(p => {
          if (!p.isAlive || !p.position) return;
          if (!positions[p.name]) positions[p.name] = [];
          positions[p.name].push({ tick, x: Math.round(p.position.x), y: Math.round(p.position.y), z: Math.round(p.position.z), team: p.teamNumber });
        });
      } catch(err) {}
    });

    demoFile.gameEvents.on('weapon_fire', e => {
      try {
        if (!e.weapon || !e.weapon.includes('grenade') && !e.weapon.includes('flash') && !e.weapon.includes('smoke') && !e.weapon.includes('molotov') && !e.weapon.includes('incgrenade') && !e.weapon.includes('decoy')) return;
        const player = demoFile.entities.getByUserId(e.userid);
        if (!player || !player.position) return;
        grenades.push({ round: currentRound, type: e.weapon, thrower: player.name, team: player.teamNumber, startX: Math.round(player.position.x), startY: Math.round(player.position.y), startZ: Math.round(player.position.z) });
      } catch(err) {}
    });

    demoFile.on('end', () => {
      console.log(`Done: ${kills.length} kills, ${rounds.length} rounds, ${Object.keys(players).length} players`);

      const fKills     = targetPlayer ? kills.filter(k => k.attacker === targetPlayer || k.victim === targetPlayer) : kills;
      const fPositions = targetPlayer ? { [targetPlayer]: positions[targetPlayer] || [] } : positions;
      const fGrenades  = targetPlayer ? grenades.filter(g => g.thrower === targetPlayer) : grenades;

      const playerStats = Object.values(players).map(p => ({
        ...p,
        kd:    p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : String(p.kills),
        hsPct: p.kills  > 0 ? ((p.hs / p.kills) * 100).toFixed(1) : '0',
      })).sort((a, b) => b.kills - a.kills);

      resolve({
        meta: { map: mapName, rounds: rounds.length, totalKills: kills.length, players: Object.keys(players), parsedAt: new Date().toISOString(), targetPlayer },
        kills:       fKills.slice(0, 3000),
        positions:   samplePositions(fPositions, 600),
        grenades:    fGrenades,
        rounds,
        playerStats,
        duelZones:   computeDuelZones(kills, mapName),
      });
    });

    demoFile.on('error', err => reject(err));

    try {
      const buffer = fs.readFileSync(demoPath);
      demoFile.parse(buffer);
    } catch(err) {
      reject(err);
    }
  });
}

function computeDuelZones(kills, mapName) {
  const MAP_BOUNDS = { 'de_dust2':{minX:-2476,maxX:1444,minY:-1228,maxY:3346},'de_mirage':{minX:-3230,maxX:870,minY:-2750,maxY:930},'de_inferno':{minX:-2087,maxX:2870,minY:-1200,maxY:3110},'de_nuke':{minX:-3453,maxX:2497,minY:-3000,maxY:2200},'de_ancient':{minX:-2953,maxX:2164,minY:-1600,maxY:3200},'de_anubis':{minX:-2100,maxX:2500,minY:-2000,maxY:2700} };
  const b = MAP_BOUNDS[mapName] || { minX:-3000, maxX:3000, minY:-3000, maxY:3000 };
  const GRID = 10, zones = {};
  const clamp = v => Math.max(0, Math.min(GRID-1, v));
  kills.forEach(k => {
    const col = clamp(Math.floor(((k.attackerX-b.minX)/(b.maxX-b.minX))*GRID));
    const row = clamp(Math.floor(((k.attackerY-b.minY)/(b.maxY-b.minY))*GRID));
    const key = `${col}_${row}`;
    if (!zones[key]) zones[key] = { kills:0, deaths:0, col, row };
    zones[key].kills++;
  });
  kills.forEach(k => {
    const col = clamp(Math.floor(((k.victimX-b.minX)/(b.maxX-b.minX))*GRID));
    const row = clamp(Math.floor(((k.victimY-b.minY)/(b.maxY-b.minY))*GRID));
    const key = `${col}_${row}`;
    if (!zones[key]) zones[key] = { kills:0, deaths:0, col, row };
    zones[key].deaths++;
  });
  return Object.entries(zones).map(([key, z]) => ({ key, col:z.col, row:z.row, kills:z.kills, deaths:z.deaths, winRate: z.kills+z.deaths>0 ? ((z.kills/(z.kills+z.deaths))*100).toFixed(0) : '50' }));
}

function samplePositions(positions, max) {
  const result = {};
  Object.entries(positions).forEach(([p, pts]) => {
    if (!pts || pts.length === 0) { result[p] = []; return; }
    const step = Math.ceil(pts.length / max);
    result[p] = pts.filter((_, i) => i % step === 0);
  });
  return result;
}

app.listen(PORT, () => console.log(`FragValue Demo Parser on port ${PORT}`));
