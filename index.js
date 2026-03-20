const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const fs       = require('fs');
const os       = require('os');
const { DemoFile } = require('demofile');

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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'FragValue Demo Parser', version: '3.0.0' }));

app.post('/parse', upload.single('demo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  const demoPath   = req.file.path;
  const playerName = req.body.player || null;
  console.log(`Parsing: ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(1)} MB)`);

  // Timeout de 5 minutes
  res.setTimeout(300000);

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
    const demoFile   = new DemoFile();
    const kills      = [];
    const positions  = {};
    const grenades   = [];
    const rounds     = [];
    const players    = {};
    let mapName      = '';
    let currentRound = 0;
    let tickCount    = 0;

    demoFile.on('start', () => {
      mapName = demoFile.header.mapName || '';
      console.log(`Map: ${mapName}`);
    });

    demoFile.gameEvents.on('round_start', () => { currentRound++; });
    demoFile.gameEvents.on('round_end', e => { rounds.push({ round: currentRound, winner: e.winner }); });

    demoFile.gameEvents.on('player_death', e => {
      try {
        const atk = demoFile.entities.getByUserId(e.attacker);
        const vic = demoFile.entities.getByUserId(e.userid);
        if (!atk || !vic || !atk.position || !vic.position) return;
        kills.push({
          round: currentRound,
          attacker: atk.name, attackerTeam: atk.teamNumber,
          attackerX: Math.round(atk.position.x), attackerY: Math.round(atk.position.y), attackerZ: Math.round(atk.position.z),
          victim: vic.name, victimTeam: vic.teamNumber,
          victimX: Math.round(vic.position.x), victimY: Math.round(vic.position.y), victimZ: Math.round(vic.position.z),
          weapon: e.weapon, isHeadshot: e.headshot,
          thruSmoke: e.through_smoke || false,
          isWallbang: (e.penetrated_objects || 0) > 0,
        });
        if (!players[atk.name]) players[atk.name] = { name: atk.name, kills: 0, deaths: 0, hs: 0 };
        if (!players[vic.name]) players[vic.name] = { name: vic.name, kills: 0, deaths: 0, hs: 0 };
        players[atk.name].kills++;
        players[vic.name].deaths++;
        if (e.headshot) players[atk.name].hs++;
      } catch(e) {}
    });

    // Positions toutes les 256 ticks pour économiser la mémoire
    demoFile.on('tickend', tick => {
      tickCount++;
      if (tickCount % 256 !== 0) return;
      try {
        demoFile.entities.players.forEach(p => {
          if (!p.isAlive || !p.position) return;
          if (!positions[p.name]) positions[p.name] = [];
          // Limite 300 points par joueur
          if (positions[p.name].length >= 300) return;
          positions[p.name].push({ tick, x: Math.round(p.position.x), y: Math.round(p.position.y), z: Math.round(p.position.z), team: p.teamNumber });
        });
      } catch(e) {}
    });

    demoFile.gameEvents.on('weapon_fire', e => {
      try {
        const w = e.weapon || '';
        if (!['flash','smoke','grenade','molotov','incgrenade','decoy'].some(t => w.includes(t))) return;
        const p = demoFile.entities.getByUserId(e.userid);
        if (!p || !p.position) return;
        grenades.push({ round: currentRound, type: w, thrower: p.name, team: p.teamNumber, startX: Math.round(p.position.x), startY: Math.round(p.position.y), startZ: Math.round(p.position.z) });
      } catch(e) {}
    });

    demoFile.on('end', () => {
      console.log(`Done: ${kills.length} kills, ${rounds.length} rounds, ${Object.keys(players).length} players`);
      const fKills = targetPlayer ? kills.filter(k => k.attacker === targetPlayer || k.victim === targetPlayer) : kills;
      const fPos   = targetPlayer ? { [targetPlayer]: positions[targetPlayer] || [] } : positions;
      const fGren  = targetPlayer ? grenades.filter(g => g.thrower === targetPlayer) : grenades;
      const stats  = Object.values(players).map(p => ({
        ...p,
        kd:    p.deaths > 0 ? (p.kills/p.deaths).toFixed(2) : String(p.kills),
        hsPct: p.kills  > 0 ? ((p.hs/p.kills)*100).toFixed(1) : '0',
      })).sort((a,b) => b.kills - a.kills);

      resolve({
        meta: { map: mapName, rounds: rounds.length, totalKills: kills.length, players: Object.keys(players), parsedAt: new Date().toISOString(), targetPlayer },
        kills:       fKills.slice(0, 2000),
        positions:   fPos,
        grenades:    fGren,
        rounds,
        playerStats: stats,
        duelZones:   computeDuelZones(kills, mapName),
      });
    });

    demoFile.on('error', err => {
      console.error('DemoFile error:', err.message);
      reject(err);
    });

    // Lecture en stream
    const stream = fs.createReadStream(demoPath);
    stream.on('error', reject);
    stream.pipe(demoFile);
  });
}

function computeDuelZones(kills, mapName) {
  const B = { 'de_dust2':{minX:-2476,maxX:1444,minY:-1228,maxY:3346},'de_mirage':{minX:-3230,maxX:870,minY:-2750,maxY:930},'de_inferno':{minX:-2087,maxX:2870,minY:-1200,maxY:3110},'de_nuke':{minX:-3453,maxX:2497,minY:-3000,maxY:2200},'de_ancient':{minX:-2953,maxX:2164,minY:-1600,maxY:3200},'de_anubis':{minX:-2100,maxX:2500,minY:-2000,maxY:2700} };
  const b = B[mapName] || { minX:-3000, maxX:3000, minY:-3000, maxY:3000 };
  const G = 10, zones = {};
  const c = v => Math.max(0, Math.min(G-1, v));
  kills.forEach(k => {
    const col = c(Math.floor(((k.attackerX-b.minX)/(b.maxX-b.minX))*G));
    const row = c(Math.floor(((k.attackerY-b.minY)/(b.maxY-b.minY))*G));
    const key = `${col}_${row}`;
    if (!zones[key]) zones[key] = { kills:0, deaths:0, col, row };
    zones[key].kills++;
  });
  kills.forEach(k => {
    const col = c(Math.floor(((k.victimX-b.minX)/(b.maxX-b.minX))*G));
    const row = c(Math.floor(((k.victimY-b.minY)/(b.maxY-b.minY))*G));
    const key = `${col}_${row}`;
    if (!zones[key]) zones[key] = { kills:0, deaths:0, col, row };
    zones[key].deaths++;
  });
  return Object.entries(zones).map(([key,z]) => ({ key, col:z.col, row:z.row, kills:z.kills, deaths:z.deaths, winRate: z.kills+z.deaths>0 ? ((z.kills/(z.kills+z.deaths))*100).toFixed(0) : '50' }));
}

app.listen(PORT, () => console.log(`FragValue Demo Parser on port ${PORT}`));
