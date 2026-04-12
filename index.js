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
app.get('/ping', (req, res) => { res.setHeader('Access-Control-Allow-Origin','*'); res.json({ ok: true, ts: Date.now() }); });

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
  // Sources utilisées :
  // - round_freeze_end → tick de début réel du round (après achat)
  // - round_officially_ended → tick de fin réel du round
  // - round_end → winner (mais souvent null dans CS2 demos)
  // - round_announce_win → winner fiable
  // - parseTicks total_rounds_played → numéro de round natif CS2 (1-based)

  // Collecter tous les freeze_end (début de round) et officially_ended (fin de round)
  const roundStartTicks = {};
  const roundEndTicks = {};

  try {
    const freezeEndEvents = parseEvent(demoPath, 'round_freeze_end', [], ['total_rounds_played', 'tick']);
    freezeEndEvents.forEach(e => {
      const r = e.total_rounds_played ?? 0;
      roundStartTicks[r] = e.tick ?? 0;
    });
    console.log(`Freeze end events: ${freezeEndEvents.length}, sample: R${freezeEndEvents[0]?.total_rounds_played} tick=${freezeEndEvents[0]?.tick}`);
  } catch(e) { console.warn('round_freeze_end failed:', e.message); }

  // round_officially_ended désactivé — les ticks sont mal alignés avec freezeR
  // On calculera endTick = startTick du round suivant dans la construction des rounds
  console.log('endTick calculé via startTick du round suivant');

  // Collecter les winners via round_announce_win (plus fiable que round_end)
  const roundWinners = {}; // round_num → winner (2=CT, 3=T)
  try {
    const announceWin = parseEvent(demoPath, 'round_announce_win', [], ['winner', 'total_rounds_played', 'tick']);
    announceWin.forEach(e => {
      const r = e.total_rounds_played ?? 0;
      if (e.winner != null) roundWinners[r] = e.winner;
    });
    console.log(`round_announce_win: ${announceWin.length}, sample: R${announceWin[0]?.total_rounds_played} winner=${announceWin[0]?.winner}`);
  } catch(e) { console.warn('round_announce_win failed:', e.message); }

  // Les round nums de freeze_end sont 0-based (R0=knife, R1=round1...)
  // Les kills sont 1-based (round=1=knife, round=2=round1...)
  // → offset : roundNum_freeze = roundNum_kills - 1
  const roundNums = Object.keys(roundStartTicks).map(Number).sort((a,b)=>a-b);
  console.log(`Round nums from freeze_end: ${roundNums.join(',')}`);

  // Le round 0 (freezeR=0) est TOUJOURS le knife round en CS2 compétitif
  const knifeRounds = new Set([0]);
  // Vérifier aussi les autres rounds (kills couteau)
  roundNums.forEach(freezeR => {
    if (freezeR === 0) return; // déjà ajouté
    const killsR = freezeR + 1;
    const rKills = kills.filter(k => k.round === killsR);
    if (rKills.length > 0) {
      const knifeK = rKills.filter(k => k.weapon && (k.weapon.includes('knife') || k.weapon.includes('bayonet')));
      if (knifeK.length / rKills.length > 0.5) knifeRounds.add(freezeR);
    }
  });
  console.log(`Knife rounds detected (freeze nums): ${[...knifeRounds].join(',')}`);

  // Déduire winner depuis le dernier kill du round si round_announce_win absent
  const computedWinners = {...roundWinners};
  if (Object.keys(roundWinners).length === 0) {
    roundNums.forEach(freezeR => {
      const killsR = freezeR + 1;
      const rKills = kills.filter(k => k.round === killsR);
      if (!rKills.length) return;
      const lastKill = rKills.reduce((a,b)=>(a.tick||0)>=(b.tick||0)?a:b);
      // CT=3 gagne si attaquant est CT, T=2 gagne si attaquant est T
      if (lastKill.attackerTeam === 3) computedWinners[freezeR] = 2; // CT win
      else if (lastKill.attackerTeam === 2) computedWinners[freezeR] = 3; // T win
    });
    console.log(`Winners computed from kills: ${roundNums.slice(0,5).map(r=>`R${r}:${computedWinners[r]||0}`).join(' ')}`);
  }

  const rounds = roundNums.map((freezeR, i) => {
    const startTick = roundStartTicks[freezeR] ?? 0;
    // endTick = startTick du round suivant (source la plus fiable)
    const nextFreezeR = roundNums[i+1];
    const endTick = nextFreezeR !== undefined
      ? (roundStartTicks[nextFreezeR] ?? 0) - 1
      : startTick + 15000; // dernier round : estimer ~2min max
    return {
      round:      freezeR,
      killsRound: freezeR + 1,
      displayNum: i + 1,
      winner:     computedWinners[freezeR] ?? 0,
      startTick,
      endTick,
      isKnife:    knifeRounds.has(freezeR),
    };
  });

  const winnerCheck = rounds.slice(0,4).map(r=>`R${r.round}(k${r.killsRound}):w${r.winner}:knife${r.isKnife?1:0}`).join(' ');
  console.log(`Rounds check: ${winnerCheck}`);
  console.log(`Rounds: ${rounds.length}`);

  // ── 5. Positions continues via parseTicks ────────────────────────────────
  // parseTicks donne X/Y/team_num à chaque tick enregistré dans la démo
  // On échantillonne 1 tick sur TICK_SAMPLE pour garder un payload raisonnable
  // tout en ayant ~8-16 positions/seconde par joueur → replay très fluide

  const { parseTicks } = require('@laihoe/demoparser2');
  let positions = {};
  const TICK_SAMPLE = 16; // 1 tick sur 16 → ~4-8fps positions, mouvements fluides
  // ~75000 pts total ≈ 1.5MB JSON → bien sous la limite sessionStorage

  try {
    const tickData = parseTicks(demoPath, ['X', 'Y', 'team_num']);
    // On assigne le round via les limites de ticks cumulatifs
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
    // Logger les types exacts pour debug
    const stKeys = Object.keys(steamToName);
    console.log('steamToName sample:', stKeys.slice(0,2).map(k=>`"${k}"(${typeof k})=${steamToName[k]}`).join(', '));
    const firstRow = tickData[0];
    console.log('parseTicks row[0] steamid:', firstRow?.steamid, 'type:', typeof firstRow?.steamid, 'BigInt?', typeof firstRow?.steamid === 'bigint');

    // Construire sidToName en gérant BigInt
    const sidToName = {};
    // steamToName a des string keys
    Object.entries(steamToName).forEach(([k,v]) => { sidToName[k] = v; });
    // parseTicks peut avoir des BigInt steamids
    tickData.forEach(row => {
      if (!row.steamid) return;
      // Convertir BigInt → string sans le "n" suffix
      const sid = typeof row.steamid === 'bigint'
        ? row.steamid.toString()
        : String(row.steamid);
      if (!sid || sid === 'undefined' || sid === 'null' || sid === '0') return;
      if (sidToName[sid]) return; // déjà résolu via steamToName
      const n = row.name || row.player_name || '';
      if (n && n !== 'unknown' && n !== '') sidToName[sid] = n;
    });
    console.log(`sidToName resolved (${Object.keys(sidToName).length}): ${Object.values(sidToName).join(', ')}`);

    // Debug : compter rows par joueur avant filtrage
    const rowCountBySid = {};
    const validCoordBySid = {};
    tickData.forEach(row => {
      const sid = typeof row.steamid === 'bigint'
        ? row.steamid.toString() : String(row.steamid||'');
      if(!sid || sid==='0') return;
      rowCountBySid[sid] = (rowCountBySid[sid]||0) + 1;
      const x = row.X??row.x??null, y = row.Y??row.y??null;
      if(x!=null && y!=null && !(x===0&&y===0) && Math.abs(x)<=10000 && Math.abs(y)<=10000)
        validCoordBySid[sid] = (validCoordBySid[sid]||0) + 1;
    });
    Object.entries(sidToName).forEach(([sid,name]) => {
      console.log(`  ${name}: ${rowCountBySid[sid]||0} rows total, ${validCoordBySid[sid]||0} valid coords`);
    });

    // Compteur par joueur pour l'échantillonnage (pas par index global)
    const playerRowCount = {};
    // Rounds triés par startTick pour l'assignation du round via tick absolu
    const sortedFreezeRounds = Object.keys(roundStartTicks)
      .map(Number).sort((a,b) => roundStartTicks[a]-roundStartTicks[b]);

    tickData.forEach((row) => {
      const sid = typeof row.steamid === 'bigint'
        ? row.steamid.toString()
        : String(row.steamid ?? '');
      const name = sidToName[sid] || null;
      if (!name) return;

      // Incrémenter le compteur de ce joueur
      playerRowCount[name] = (playerRowCount[name] || 0) + 1;

      // Échantillonnage PAR JOUEUR : garder 1 row sur TICK_SAMPLE
      if (playerRowCount[name] % TICK_SAMPLE !== 0) return;

      const x = row.X ?? row.x ?? null;
      const y = row.Y ?? row.y ?? null;
      if (x == null || y == null || (x === 0 && y === 0)) return;
      if (Math.abs(x) > 10000 || Math.abs(y) > 10000) return;

      const team    = row.team_num ?? 0;
      const absTick = row.tick ?? 0; // tick ABSOLU depuis le début de la démo

      // Assigner le round via tick absolu : trouver freezeR dont startTick <= absTick < startTick_suivant
      let assignedFreezeR = sortedFreezeRounds[0] ?? 0;
      for (let ri = 0; ri < sortedFreezeRounds.length; ri++) {
        const fr = sortedFreezeRounds[ri];
        const st = roundStartTicks[fr] ?? 0;
        if (st <= absTick) assignedFreezeR = fr;
        else break;
      }
      const killsRound = assignedFreezeR + 1;

      if (!positions[name]) positions[name] = [];
      if (positions[name].length >= 7500) return;
      positions[name].push({
        x: Math.round(x),
        y: Math.round(y),
        team,
        round: killsRound,
        tick:  absTick,
      });
    });

    // Tri par tick absolu (le round est déjà assigné correctement)
    Object.keys(positions).forEach(name => {
      positions[name].sort((a, b) => a.tick - b.tick);
    });

    const totalPos = Object.values(positions).reduce((s, v) => s + v.length, 0);
    const sampleAbsTick0 = Object.values(positions)[0]?.[0]?.tick ?? 0;
    const sampleAbsTick1 = Object.values(positions)[0]?.find(p=>p.round===2)?.tick ?? 0;
    const p0 = Object.values(positions)[0] || [];
    console.log(`Positions parseTicks: ${Object.keys(positions).length} joueurs, ${totalPos} pts total`);
    console.log(`Tick samples: [${p0.slice(0,5).map(p=>p.tick).join(',')}]`);
    console.log(`Round samples: [${p0.slice(0,5).map(p=>p.round).join(',')}]`);
    // Compter combien de positions par round
    const rndCounts = {};
    p0.forEach(p => { rndCounts[p.round] = (rndCounts[p.round]||0)+1; });
    console.log(`Positions par round: ${JSON.stringify(rndCounts)}`);
    console.log(`Joueurs dans positions: ${Object.keys(positions).join(', ')}`);
    const missing = playerNames.filter(n => !positions[n]);
    if (missing.length) {
      console.log(`Joueurs MANQUANTS dans positions: ${missing.join(', ')}`);
      // Trouver leurs steamids dans sidToName pour voir si le match se fait
      const sidToNameInv = {};
      Object.entries(sidToName).forEach(([sid,name]) => { sidToNameInv[name] = sid; });
      missing.forEach(name => {
        const sid = sidToNameInv[name];
        console.log(`  MANQUANT ${name}: sid=${sid}, sidToName[sid]=${sidToName[sid]}, posCount=${positions[name]?.length||0}`);
        // Compter combien de rows parseTicks ont ce steamid
        const cnt = tickData.filter(r => {
          const s = typeof r.steamid==='bigint' ? r.steamid.toString() : String(r.steamid??'');
          return s === sid;
        }).length;
        console.log(`  parseTicks rows avec ce sid: ${cnt}`);
      });
    }
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

  // ── 6. Grenades avec ticks absolus et events de détonation ─────────────
  let grenades = [];
  let shots = [];
  try {
    const grenadeTypes = new Set(['weapon_flashbang','weapon_smokegrenade','weapon_hegrenade','weapon_molotov','weapon_incgrenade','weapon_decoy']);
    
    // Lancer de grenade (position du lanceur + tick absolu)
    const gEvents = parseEvent(demoPath, 'weapon_fire', ['X', 'Y', 'Z', 'team_num'], ['weapon', 'tick', 'total_rounds_played']);
    const thrown = gEvents.filter(e => grenadeTypes.has(e.weapon)).map(e => {
      const relTick = e.tick ?? 0;
      let absTick = relTick;
      if (relTick < 10000 && relTick > 0) {
        // Relatif — ajouter le startTick du round le plus récent avant ce tick
        const sortedRounds = Object.entries(roundStartTicks)
          .map(([r,st]) => ({r:Number(r), st:Number(st)}))
          .filter(({st}) => st > 0)
          .sort((a,b) => a.st - b.st);
        if (sortedRounds.length) absTick = sortedRounds[sortedRounds.length-1].st + relTick;
      }
      return {
        tick:    absTick,
        type:    e.weapon,
        thrower: e.user_name || e.user || 'Unknown',
        team:    e.user_team_num ?? 0,
        x:       Math.round(e.user_X ?? 0),
        y:       Math.round(e.user_Y ?? 0),
      };
    });

    // Détonations : smoke_started, flashbang_detonate, hegrenade_detonate, molotov_detonate, decoy_started
    const detonations = {};
    const detonEvents = [
      ['smokegrenade_detonate', 'smoke'],
      ['flashbang_detonate',    'flash'],
      ['hegrenade_detonate',    'he'],
      ['molotov_detonate',      'molotov'],
      ['inferno_startburn',     'inferno'],
      ['decoy_started',         'decoy'],
    ];
    for (const [evName, key] of detonEvents) {
      try {
        // Pour les events de détonation, les coords sont dans other props (pas player props)
        let evs = [];
        try { evs = parseEvent(demoPath, evName, [], ['tick', 'x', 'y']); }
        catch(e2) {
          try { evs = parseEvent(demoPath, evName, ['X','Y'], ['tick']); }
          catch(e3) { evs = parseEvent(demoPath, evName, [], ['tick']); }
        }
        evs.forEach(e => {
          if (!detonations[key]) detonations[key] = [];
          const ex = e.x ?? e.X ?? e.user_X ?? 0;
          const ey = e.y ?? e.Y ?? e.user_Y ?? 0;
          const dt = e.tick ?? 0;
          // Trouver le tick absolu : chercher le roundStartTick dont start <= dt
          // Si dt > 10000, déjà absolu
          let absDetTick = dt;
          if (dt < 10000 && dt > 0) {
            // Relatif — trouver le bon round via les roundStartTicks
            const sortedRounds = Object.entries(roundStartTicks)
              .map(([r,st]) => ({r:Number(r), st:Number(st)}))
              .sort((a,b) => a.st - b.st);
            // Chercher le round dont on est dans la durée
            for (let ri = sortedRounds.length-1; ri >= 0; ri--) {
              const {r, st} = sortedRounds[ri];
              if (st > 0) { absDetTick = st + dt; break; }
            }
          }
          // Les coords sont dans e.x, e.y (other props) selon les logs
          const ex2 = e.x ?? e.X ?? e.user_X ?? 0;
          const ey2 = e.y ?? e.Y ?? e.user_Y ?? 0;
          detonations[key].push({ tick: absDetTick, x: Math.round(ex2), y: Math.round(ey2) });
        });
        if (evs.length > 0) {
          const s = evs[0];
          console.log(`${evName}: ${evs.length} events, sample keys=${Object.keys(s).join(',')}, x=${s.x??s.X??'?'} y=${s.y??s.Y??'?'}`);
        }
      } catch(e) { console.warn(`${evName} failed:`, e.message); }
    }

    // Smoke end (durée ~18sec = 2304 ticks)
    let smokeEnds = {};
    try {
      const se = parseEvent(demoPath, 'smokegrenade_expired', ['X','Y'], ['tick']);
      se.forEach(e => { smokeEnds[e.tick??0] = true; });
    } catch(e) {}

    // Inferno end
    let infernoEnds = {};
    try {
      const ie = parseEvent(demoPath, 'inferno_expire', ['X','Y'], ['tick']);
      ie.forEach(e => { infernoEnds[e.tick??0] = true; });
    } catch(e) {}

    grenades = thrown.map(g => {
      // Trouver la détonation correspondante (tick le plus proche après le lancer)
      const key = g.type.includes('smoke') ? 'smoke'
        : g.type.includes('flash')  ? 'flash'
        : g.type.includes('hegre')  ? 'he'
        : g.type.includes('molotov')|| g.type.includes('incgren') ? 'molotov'
        : g.type.includes('decoy')  ? 'decoy' : null;
      
      let detonTick = g.tick + 128; // fallback: 1sec après lancer
      let detonX = g.x, detonY = g.y;
      if (key && detonations[key]) {
        // Chercher la détonation la plus proche après le lancer
        // Les ticks sont absolus des deux côtés maintenant
        const candidates = detonations[key]
          .filter(d => d.x !== 0 && d.y !== 0 && d.tick >= g.tick - 512 && d.tick < g.tick + 20000)
          .sort((a,b) => Math.abs(a.tick - g.tick) - Math.abs(b.tick - g.tick));
        if (candidates.length > 0) {
          const det = candidates[0];
          detonTick = det.tick > g.tick ? det.tick : g.tick + 256;
          detonX = det.x;
          detonY = det.y;
        }
      }

      // Durée de l'effet visuel selon le type
      const duration = g.type.includes('smoke') ? 2304      // ~18sec
        : g.type.includes('flash')  ? 192                    // ~1.5sec
        : g.type.includes('hegre')  ? 64                     // ~0.5sec
        : g.type.includes('molotov')|| g.type.includes('incgren') ? 896 // ~7sec
        : g.type.includes('decoy')  ? 1920                   // ~15sec
        : 128;

      return {
        tick:      g.tick,
        detonTick,
        endTick:   detonTick + duration,
        type:      g.type,
        thrower:   g.thrower,
        team:      g.team,
        x:         g.x,       // position du lanceur
        y:         g.y,
        detonX,               // position d'explosion
        detonY,
      };
    });

    // Tirs séparément pour avoir le tick absolu
    // On mappe chaque tir sur le tick absolu via roundStartTicks
    const shootEvents = gEvents.filter(e => !grenadeTypes.has(e.weapon));
    shots = shootEvents.map(e => {
      // Trouver le tick absolu : e.tick est relatif au round
      // On cherche le roundStartTick correspondant au round du tir
      const relTick = e.tick ?? 0;
      // Trouver le freezeR dont le startTick <= tick absolu estimé
      // Heuristique : le tick absolu = relTick + roundStartTick[freezeR]
      // On trouve le bon round en cherchant dans roundStartTicks
      const rnd = e.total_rounds_played ?? 0;
      const absTick = (roundStartTicks[rnd] ?? 0) + relTick;
      return {
        tick:    absTick,
        shooter: e.user_name || e.user || 'Unknown',
        team:    e.user_team_num ?? 0,
        x:       Math.round(e.user_X ?? e.X ?? 0),
        y:       Math.round(e.user_Y ?? e.Y ?? 0),
        weapon:  e.weapon || '',
      };
    }).filter(s => s.x !== 0 || s.y !== 0);
    console.log(`Shots: ${shots.length}, sample tick=${shots[0]?.tick} x=${shots[0]?.x} y=${shots[0]?.y}`);

  } catch(e) { console.warn('Grenades warning:', e.message); }
  const matchedDeton = grenades.filter(g => g.detonX !== g.x || g.detonY !== g.y).length;
  console.log(`Grenades: ${grenades.length}, avec détonation distincte: ${matchedDeton}`);
  if (grenades.length > 0) console.log(`Grenade[0]: tick=${grenades[0].tick} detonTick=${grenades[0].detonTick} x=${grenades[0].x} detonX=${grenades[0].detonX}`);

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
    positions, grenades: grenades.slice(0, 800), shots: shots.slice(0, 3000), rounds, roundStartTicks, playerStats, duelZones,
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

const server = app.listen(PORT, () => {
  server.keepAliveTimeout = 620000;
  server.headersTimeout   = 630000;
  console.log(`FragValue Demo Parser CS2 v6.3 on port ${PORT}`);
});
