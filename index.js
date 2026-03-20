// FragValue Demo Parser — index.js
// Service Node.js pour parser les fichiers .dem CS2
// Déployer sur Railway.app

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ───────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://frag-value.vercel.app',
    'http://localhost:3000',
    'http://localhost:5500',
  ]
}));
app.use(express.json());

// ── Upload config — stockage temporaire ───────────────────────────────────
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith('.dem')) {
      return cb(new Error('Seuls les fichiers .dem sont acceptés'));
    }
    cb(null, true);
  }
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FragValue Demo Parser', version: '1.0.0' });
});

// ── Route principale : parse une démo ─────────────────────────────────────
app.post('/parse', upload.single('demo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier reçu.' });
  }

  const demoPath   = req.file.path;
  const playerName = req.body.player || null;
  const options    = req.body.options ? JSON.parse(req.body.options) : {};

  console.log(`Parsing: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);

  try {
    const result = await parseDemo(demoPath, playerName, options);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Parse error:', err.message);
    res.status(500).json({ error: err.message || 'Erreur lors du parsing.' });
  } finally {
    // Supprime le fichier temporaire
    fs.unlink(demoPath, () => {});
  }
});

// ── Fonction de parsing principale ────────────────────────────────────────
async function parseDemo(demoPath, targetPlayer, options) {
  let DemoParser;
  try {
    const mod = await import('@laihoe/demoparser2');
    DemoParser = mod.DemoParser;
  } catch (e) {
    throw new Error('Module demoparser2 non disponible: ' + e.message);
  }

  return new Promise((resolve, reject) => {
    const parser = new DemoParser(demoPath);

    // Données collectées
    const kills      = [];
    const deaths     = [];
    const positions  = {};
    const grenades   = [];
    const rounds     = [];
    const economy    = [];
    const players    = {};

    let currentRound = 0;
    let roundData    = null;
    let mapName      = '';
    let tickRate     = 64;

    // ── Header ─────────────────────────────────────────────────────────────
    parser.on('start', (e) => {
      mapName  = e.mapName  || '';
      tickRate = e.tickRate || 64;
      console.log(`Map: ${mapName}, TickRate: ${tickRate}`);
    });

    // ── Round start ────────────────────────────────────────────────────────
    parser.on('roundStart', (e) => {
      currentRound++;
      roundData = {
        round:   currentRound,
        kills:   0,
        winner:  null,
        ctScore: 0,
        tScore:  0,
      };
    });

    // ── Round end ──────────────────────────────────────────────────────────
    parser.on('roundEnd', (e) => {
      if (roundData) {
        roundData.winner  = e.winner || null;
        roundData.ctScore = e.ctWins || 0;
        roundData.tScore  = e.tWins  || 0;
        rounds.push({ ...roundData });
      }
    });

    // ── Kill events ────────────────────────────────────────────────────────
    parser.on('playerDeath', (e) => {
      if (!e.attackerX || !e.attackerY) return;

      const killEvent = {
        round:       currentRound,
        tick:        e.tick || 0,
        // Position du tueur
        attackerX:   Math.round(e.attackerX),
        attackerY:   Math.round(e.attackerY),
        attackerZ:   Math.round(e.attackerZ || 0),
        attacker:    e.attackerName || '',
        attackerTeam: e.attackerTeam || '',
        // Position de la victime
        victimX:     Math.round(e.victimX || e.x || 0),
        victimY:     Math.round(e.victimY || e.y || 0),
        victimZ:     Math.round(e.victimZ || e.z || 0),
        victim:      e.victimName || e.userName || '',
        victimTeam:  e.victimTeam || '',
        // Détails
        weapon:      e.weapon || '',
        isHeadshot:  e.headshot || false,
        isWallbang:  e.penetratedObjects > 0,
        assistedFlash: e.assistedFlash || false,
        noscope:     e.noscope || false,
        thruSmoke:   e.thruSmoke || false,
        distance:    e.distance || 0,
      };

      kills.push(killEvent);
      if (roundData) roundData.kills++;

      // Track players
      if (e.attackerName) {
        if (!players[e.attackerName]) players[e.attackerName] = { name: e.attackerName, kills: 0, deaths: 0, hs: 0, team: e.attackerTeam };
        players[e.attackerName].kills++;
        if (e.headshot) players[e.attackerName].hs++;
      }
      if (e.victimName || e.userName) {
        const vName = e.victimName || e.userName;
        if (!players[vName]) players[vName] = { name: vName, kills: 0, deaths: 0, hs: 0, team: e.victimTeam };
        players[vName].deaths++;
      }
    });

    // ── Grenade events ─────────────────────────────────────────────────────
    parser.on('grenadeThrown', (e) => {
      if (!e.x || !e.y) return;
      grenades.push({
        round:   currentRound,
        tick:    e.tick || 0,
        type:    e.weapon || 'unknown',
        thrower: e.userName || '',
        team:    e.team || '',
        startX:  Math.round(e.x),
        startY:  Math.round(e.y),
        startZ:  Math.round(e.z || 0),
      });
    });

    // ── Player positions (tous les 4 ticks pour performance) ──────────────
    parser.on('tickDone', (e) => {
      if (!e.players || e.tick % 4 !== 0) return;
      e.players.forEach(p => {
        if (!p.name || !p.x || !p.y) return;
        if (!positions[p.name]) positions[p.name] = [];
        positions[p.name].push({
          tick: e.tick,
          x:    Math.round(p.x),
          y:    Math.round(p.y),
          z:    Math.round(p.z || 0),
          isAlive: p.isAlive || false,
          team:    p.team    || '',
        });
      });
    });

    // ── Economy ───────────────────────────────────────────────────────────
    parser.on('roundFreezetimeEnd', (e) => {
      if (!e.players) return;
      const roundEco = {
        round: currentRound,
        players: e.players.map(p => ({
          name:      p.name     || '',
          team:      p.team     || '',
          money:     p.money    || 0,
          equipment: p.equipmentValue || 0,
          weapon:    p.activeWeapon   || '',
          hasArmor:  p.hasHelmet || p.hasDefuser || false,
        }))
      };
      economy.push(roundEco);
    });

    // ── Fin du parsing ────────────────────────────────────────────────────
    parser.on('end', () => {
      console.log(`Parsed: ${kills.length} kills, ${rounds.length} rounds, ${Object.keys(positions).length} players tracked`);

      // Filtre par joueur si spécifié
      const filteredKills     = targetPlayer
        ? kills.filter(k => k.attacker === targetPlayer || k.victim === targetPlayer)
        : kills;

      const filteredPositions = targetPlayer
        ? { [targetPlayer]: positions[targetPlayer] || [] }
        : positions;

      const filteredGrenades  = targetPlayer
        ? grenades.filter(g => g.thrower === targetPlayer)
        : grenades;

      // Stats par joueur
      const playerStats = Object.values(players).map(p => ({
        ...p,
        kd:       p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills,
        hsPct:    p.kills  > 0 ? ((p.hs / p.kills) * 100).toFixed(1) : '0',
      })).sort((a, b) => b.kills - a.kills);

      // Zones de duels (grille 10x10)
      const duelZones = computeDuelZones(kills, mapName);

      resolve({
        meta: {
          map:       mapName,
          tickRate,
          rounds:    rounds.length,
          totalKills: kills.length,
          players:   Object.keys(players),
          parsedAt:  new Date().toISOString(),
          targetPlayer,
        },
        kills:      filteredKills.slice(0, 2000), // limite pour perf
        positions:  samplePositions(filteredPositions, 500), // 500 points max par joueur
        grenades:   filteredGrenades,
        rounds,
        economy:    economy.slice(0, 30),
        playerStats,
        duelZones,
      });
    });

    parser.on('error', reject);
    parser.parse();
  });
}

// ── Calcul des zones de duels ──────────────────────────────────────────────
function computeDuelZones(kills, mapName) {
  // Limites approximatives des maps CS2
  const mapBounds = {
    'de_dust2':   { minX: -2476, maxX: 1444, minY: -1228, maxY: 3346 },
    'de_mirage':  { minX: -3230, maxX:  870, minY: -2750, maxY:  930 },
    'de_inferno': { minX: -2087, maxX: 2870, minY: -1200, maxY: 3110 },
    'de_nuke':    { minX: -3453, maxX: 2497, minY: -3000, maxY: 2200 },
    'de_ancient': { minX: -2953, maxX: 2164, minY: -1600, maxY: 3200 },
    'de_anubis':  { minX: -2100, maxX: 2500, minY: -2000, maxY: 2700 },
    'de_vertigo': { minX: -3168, maxX: 1886, minY: -3316, maxY: 1740 },
  };

  const bounds = mapBounds[mapName] || { minX: -3000, maxX: 3000, minY: -3000, maxY: 3000 };
  const GRID   = 10;
  const zones  = {};

  kills.forEach(k => {
    const col = Math.floor(((k.attackerX - bounds.minX) / (bounds.maxX - bounds.minX)) * GRID);
    const row = Math.floor(((k.attackerY - bounds.minY) / (bounds.maxY - bounds.minY)) * GRID);
    const key = `${Math.max(0, Math.min(GRID-1, col))}_${Math.max(0, Math.min(GRID-1, row))}`;
    if (!zones[key]) zones[key] = { kills: 0, deaths: 0, col, row };
    zones[key].kills++;
  });

  kills.forEach(k => {
    const col = Math.floor(((k.victimX - bounds.minX) / (bounds.maxX - bounds.minX)) * GRID);
    const row = Math.floor(((k.victimY - bounds.minY) / (bounds.maxY - bounds.minY)) * GRID);
    const key = `${Math.max(0, Math.min(GRID-1, col))}_${Math.max(0, Math.min(GRID-1, row))}`;
    if (!zones[key]) zones[key] = { kills: 0, deaths: 0, col, row };
    zones[key].deaths++;
  });

  return Object.entries(zones).map(([key, z]) => ({
    key,
    col:     z.col,
    row:     z.row,
    kills:   z.kills,
    deaths:  z.deaths,
    winRate: z.kills + z.deaths > 0
      ? ((z.kills / (z.kills + z.deaths)) * 100).toFixed(0)
      : '50',
  }));
}

// ── Echantillonnage des positions pour limiter la taille ──────────────────
function samplePositions(positions, maxPerPlayer) {
  const result = {};
  Object.entries(positions).forEach(([player, pts]) => {
    if (pts.length <= maxPerPlayer) {
      result[player] = pts;
    } else {
      const step = Math.ceil(pts.length / maxPerPlayer);
      result[player] = pts.filter((_, i) => i % step === 0);
    }
  });
  return result;
}

// ── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FragValue Demo Parser running on port ${PORT}`);
});
