// FragValue Demo Parser — index.js
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const os      = require('os');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: ['https://frag-value.vercel.app', 'http://localhost:3000', 'http://localhost:5500']
}));
app.use(express.json());

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith('.dem')) {
      return cb(new Error('Seuls les fichiers .dem sont acceptés'));
    }
    cb(null, true);
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FragValue Demo Parser', version: '1.0.0' });
});

app.post('/parse', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });

  const demoPath   = req.file.path;
  const playerName = req.body.player || null;
  const options    = req.body.options ? JSON.parse(req.body.options) : {};

  console.log(`Parsing: ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(1)} MB)`);

  try {
    const result = await parseDemo(demoPath, playerName, options);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Parse error:', err.message);
    res.status(500).json({ error: err.message || 'Erreur lors du parsing.' });
  } finally {
    fs.unlink(demoPath, () => {});
  }
});

async function parseDemo(demoPath, targetPlayer, options) {
  const DemoFile = require('demofile');

  return new Promise((resolve, reject) => {
    const demoFile = new DemoFile.DemoFile();

    const kills     = [];
    const positions = {};
    const grenades  = [];
    const rounds    = [];
    const players   = {};
    let mapName     = '';
    let currentRound = 0;

    demoFile.header.on('parsed', header => {
      mapName = header.mapName || '';
      console.log(`Map: ${mapName}`);
    });

    demoFile.gameEvents.on('round_start', () => {
      currentRound++;
    });

    demoFile.gameEvents.on('round_end', e => {
      rounds.push({
        round:  currentRound,
        winner: e.winner,
      });
    });

    demoFile.gameEvents.on('player_death', e => {
      const attacker = demoFile.entities.getByUserId(e.attacker);
      const victim   = demoFile.entities.getByUserId(e.userid);
      if (!attacker || !victim) return;

      const aPos = attacker.position;
      const vPos = victim.position;

      const killEvent = {
        round:        currentRound,
        attacker:     attacker.name,
        attackerTeam: attacker.teamNumber,
        attackerX:    Math.round(aPos.x),
        attackerY:    Math.round(aPos.y),
        attackerZ:    Math.round(aPos.z),
        victim:       victim.name,
        victimTeam:   victim.teamNumber,
        victimX:      Math.round(vPos.x),
        victimY:      Math.round(vPos.y),
        victimZ:      Math.round(vPos.z),
        weapon:       e.weapon,
        isHeadshot:   e.headshot,
        thruSmoke:    e.through_smoke,
        noscope:      e.noscope,
        isWallbang:   e.penetrated_objects > 0,
      };

      kills.push(killEvent);

      // Track player stats
      if (!players[attacker.name]) players[attacker.name] = { name: attacker.name, kills: 0, deaths: 0, hs: 0 };
      if (!players[victim.name])   players[victim.name]   = { name: victim.name,   kills: 0, deaths: 0, hs: 0 };
      players[attacker.name].kills++;
      players[victim.name].deaths++;
      if (e.headshot) players[attacker.name].hs++;
    });

    // Positions toutes les 64 ticks (~1 seconde)
    demoFile.on('tickend', tick => {
      if (tick % 64 !== 0) return;
      demoFile.entities.players.forEach(p => {
        if (!p.isAlive) return;
        const pos = p.position;
        if (!pos) return;
        if (!positions[p.name]) positions[p.name] = [];
        positions[p.name].push({
          tick,
          x: Math.round(pos.x),
          y: Math.round(pos.y),
          z: Math.round(pos.z),
          team: p.teamNumber,
        });
      });
    });

    demoFile.gameEvents.on('grenade_thrown', e => {
      const player = demoFile.entities.getByUserId(e.userid);
      if (!player) return;
      const pos = player.position;
      grenades.push({
        round:   currentRound,
        type:    e.weapon,
        thrower: player.name,
        team:    player.teamNumber,
        startX:  Math.round(pos.x),
        startY:  Math.round(pos.y),
        startZ:  Math.round(pos.z),
      });
    });

    demoFile.on('end', () => {
      console.log(`Done: ${kills.length} kills, ${rounds.length} rounds`);

      const filteredKills     = targetPlayer ? kills.filter(k => k.attacker === targetPlayer || k.victim === targetPlayer) : kills;
      const filteredPositions = targetPlayer ? { [targetPlayer]: positions[targetPlayer] || [] } : positions;
      const filteredGrenades  = targetPlayer ? grenades.filter(g => g.thrower === targetPlayer) : grenades;

      const playerStats = Object.values(players).map(p => ({
        ...p,
        kd:    p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills,
        hsPct: p.kills  > 0 ? ((p.hs / p.kills) * 100).toFixed(1) : '0',
      })).sort((a, b) => b.kills - a.kills);

      const duelZones = computeDuelZones(kills, mapName);

      resolve({
        meta: { map: mapName, rounds: rounds.length, totalKills: kills.length, players: Object.keys(players), parsedAt: new Date().toISOString(), targetPlayer },
        kills:      filteredKills.slice(0, 2000),
        positions:  samplePositions(filteredPositions, 500),
        grenades:   filteredGrenades,
        rounds,
        playerStats,
        duelZones,
      });
    });

    demoFile.on('error', reject);

    const buffer = fs.readFileSync(demoPath);
    demoFile.parse(buffer);
  });
}

function computeDuelZones(kills, mapName) {
  const mapBounds = {
    'de_dust2':   { minX: -2476, maxX: 1444, minY: -1228, maxY: 3346 },
    'de_mirage':  { minX: -3230, maxX:  870, minY: -2750, maxY:  930 },
    'de_inferno': { minX: -2087, maxX: 2870, minY: -1200, maxY: 3110 },
    'de_nuke':    { minX: -3453, maxX: 2497, minY: -3000, maxY: 2200 },
    'de_ancient': { minX: -2953, maxX: 2164, minY: -1600, maxY: 3200 },
    'de_anubis':  { minX: -2100, maxX: 2500, minY: -2000, maxY: 2700 },
  };
  const bounds = mapBounds[mapName] || { minX: -3000, maxX: 3000, minY: -3000, maxY: 3000 };
  const GRID   = 10;
  const zones  = {};

  kills.forEach(k => {
    const col = Math.floor(((k.attackerX - bounds.minX) / (bounds.maxX - bounds.minX)) * GRID);
    const row = Math.floor(((k.attackerY - bounds.minY) / (bounds.maxY - bounds.minY)) * GRID);
    const key = `${Math.max(0,Math.min(GRID-1,col))}_${Math.max(0,Math.min(GRID-1,row))}`;
    if (!zones[key]) zones[key] = { kills: 0, deaths: 0, col: Math.max(0,Math.min(GRID-1,col)), row: Math.max(0,Math.min(GRID-1,row)) };
    zones[key].kills++;
  });

  kills.forEach(k => {
    const col = Math.floor(((k.victimX - bounds.minX) / (bounds.maxX - bounds.minX)) * GRID);
    const row = Math.floor(((k.victimY - bounds.minY) / (bounds.maxY - bounds.minY)) * GRID);
    const key = `${Math.max(0,Math.min(GRID-1,col))}_${Math.max(0,Math.min(GRID-1,row))}`;
    if (!zones[key]) zones[key] = { kills: 0, deaths: 0, col: Math.max(0,Math.min(GRID-1,col)), row: Math.max(0,Math.min(GRID-1,row)) };
    zones[key].deaths++;
  });

  return Object.entries(zones).map(([key, z]) => ({
    key, col: z.col, row: z.row, kills: z.kills, deaths: z.deaths,
    winRate: z.kills + z.deaths > 0 ? ((z.kills / (z.kills + z.deaths)) * 100).toFixed(0) : '50',
  }));
}

function samplePositions(positions, maxPerPlayer) {
  const result = {};
  Object.entries(positions).forEach(([player, pts]) => {
    if (!pts || pts.length === 0) { result[player] = []; return; }
    const step = Math.ceil(pts.length / maxPerPlayer);
    result[player] = pts.filter((_, i) => i % step === 0);
  });
  return result;
}

app.listen(PORT, () => console.log(`FragValue Demo Parser on port ${PORT}`));
