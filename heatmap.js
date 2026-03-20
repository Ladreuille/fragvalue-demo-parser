// heatmap.js — FragValue Heatmap Engine
// Moteur de rendu Canvas HTML5 pour les heatmaps de démos CS2

// ── Coordonnées des maps CS2 ───────────────────────────────────────────────
const MAP_BOUNDS = {
  'de_dust2':   { minX: -2476, maxX: 1444, minY: -1228, maxY: 3346, scale: 4 },
  'de_mirage':  { minX: -3230, maxX:  870, minY: -2750, maxY:  930, scale: 4 },
  'de_inferno': { minX: -2087, maxX: 2870, minY: -1200, maxY: 3110, scale: 4 },
  'de_nuke':    { minX: -3453, maxX: 2497, minY: -3000, maxY: 2200, scale: 4 },
  'de_ancient': { minX: -2953, maxX: 2164, minY: -1600, maxY: 3200, scale: 4 },
  'de_anubis':  { minX: -2100, maxX: 2500, minY: -2000, maxY: 2700, scale: 4 },
  'de_vertigo': { minX: -3168, maxX: 1886, minY: -3316, maxY: 1740, scale: 4 },
};

// ── Convertit coordonnées monde → pixels canvas ───────────────────────────
function worldToCanvas(x, y, mapName, canvasW, canvasH) {
  const b = MAP_BOUNDS[mapName] || { minX: -3000, maxX: 3000, minY: -3000, maxY: 3000 };
  const px = ((x - b.minX) / (b.maxX - b.minX)) * canvasW;
  const py = (1 - (y - b.minY) / (b.maxY - b.minY)) * canvasH;
  return { px, py };
}

// ── Classe principale HeatmapRenderer ────────────────────────────────────
class HeatmapRenderer {
  constructor(canvasId, mapName, canvasSize = 600) {
    this.canvas  = document.getElementById(canvasId);
    this.ctx     = this.canvas.getContext('2d');
    this.mapName = mapName;
    this.size    = canvasSize;
    this.canvas.width  = canvasSize;
    this.canvas.height = canvasSize;
    this.mapImage = null;
    this.loadMapImage();
  }

  loadMapImage() {
    // Images de maps depuis les ressources publiques CS2
    const mapUrls = {
      'de_dust2':   'https://cdn.csgostats.gg/maps/de_dust2/overview.png',
      'de_mirage':  'https://cdn.csgostats.gg/maps/de_mirage/overview.png',
      'de_inferno': 'https://cdn.csgostats.gg/maps/de_inferno/overview.png',
      'de_nuke':    'https://cdn.csgostats.gg/maps/de_nuke/overview.png',
      'de_ancient': 'https://cdn.csgostats.gg/maps/de_ancient/overview.png',
      'de_anubis':  'https://cdn.csgostats.gg/maps/de_anubis/overview.png',
      'de_vertigo': 'https://cdn.csgostats.gg/maps/de_vertigo/overview.png',
    };
    const url = mapUrls[this.mapName];
    if (url) {
      this.mapImage = new Image();
      this.mapImage.crossOrigin = 'anonymous';
      this.mapImage.src = url;
    }
  }

  clear() {
    this.ctx.clearRect(0, 0, this.size, this.size);
    // Fond sombre
    this.ctx.fillStyle = '#080C10';
    this.ctx.fillRect(0, 0, this.size, this.size);
    // Dessine l'image de map si chargée
    if (this.mapImage && this.mapImage.complete) {
      this.ctx.globalAlpha = 0.35;
      this.ctx.drawImage(this.mapImage, 0, 0, this.size, this.size);
      this.ctx.globalAlpha = 1;
    }
  }

  // ── KILL HEATMAP ──────────────────────────────────────────────────────────
  renderKillHeatmap(kills, mode = 'kills') {
    this.clear();
    const points = mode === 'kills'
      ? kills.map(k => ({ x: k.attackerX, y: k.attackerY }))
      : kills.map(k => ({ x: k.victimX,   y: k.victimY   }));

    // Grille de densité
    const gridSize = 20;
    const grid     = {};
    let maxDensity = 0;

    points.forEach(p => {
      const { px, py } = worldToCanvas(p.x, p.y, this.mapName, this.size, this.size);
      const gx = Math.floor(px / gridSize);
      const gy = Math.floor(py / gridSize);
      const key = `${gx}_${gy}`;
      grid[key] = (grid[key] || 0) + 1;
      if (grid[key] > maxDensity) maxDensity = grid[key];
    });

    // Dessine la heatmap
    Object.entries(grid).forEach(([key, count]) => {
      const [gx, gy] = key.split('_').map(Number);
      const intensity = count / maxDensity;
      const r = mode === 'kills' ? 255 : 255;
      const g = mode === 'kills' ? Math.floor(85 * (1 - intensity)) : Math.floor(69 * intensity);
      const b = mode === 'kills' ? 0 : Math.floor(96 * intensity);
      this.ctx.fillStyle = `rgba(${r},${g},${b},${0.3 + intensity * 0.6})`;
      this.ctx.fillRect(gx * gridSize, gy * gridSize, gridSize, gridSize);
    });

    // Points individuels
    points.forEach(p => {
      const { px, py } = worldToCanvas(p.x, p.y, this.mapName, this.size, this.size);
      this.ctx.beginPath();
      this.ctx.arc(px, py, 3, 0, Math.PI * 2);
      this.ctx.fillStyle = mode === 'kills' ? 'rgba(255,85,0,.8)' : 'rgba(255,69,96,.8)';
      this.ctx.fill();
    });

    this.addLegend(mode === 'kills' ? 'Kill heatmap' : 'Death heatmap');
  }

  // ── MOVEMENT HEATMAP ──────────────────────────────────────────────────────
  renderMovementHeatmap(positions, playerName) {
    this.clear();
    const pts = positions[playerName] || [];
    if (pts.length === 0) return;

    const gridSize = 15;
    const grid     = {};
    let maxDensity = 0;

    pts.forEach(p => {
      const { px, py } = worldToCanvas(p.x, p.y, this.mapName, this.size, this.size);
      const gx  = Math.floor(px / gridSize);
      const gy  = Math.floor(py / gridSize);
      const key = `${gx}_${gy}`;
      grid[key] = (grid[key] || 0) + 1;
      if (grid[key] > maxDensity) maxDensity = grid[key];
    });

    Object.entries(grid).forEach(([key, count]) => {
      const [gx, gy] = key.split('_').map(Number);
      const intensity = count / maxDensity;
      this.ctx.fillStyle = `rgba(0,229,255,${0.1 + intensity * 0.7})`;
      this.ctx.fillRect(gx * gridSize, gy * gridSize, gridSize, gridSize);
    });

    this.addLegend(`Déplacements — ${playerName}`);
  }

  // ── DUEL WIN ZONES ────────────────────────────────────────────────────────
  renderDuelZones(duelZones) {
    this.clear();
    const GRID     = 10;
    const cellSize = this.size / GRID;

    duelZones.forEach(z => {
      const wr  = parseFloat(z.winRate);
      const total = z.kills + z.deaths;
      if (total === 0) return;

      // Couleur selon win rate
      let color;
      if (wr >= 65)      color = `rgba(57,255,138,${0.2 + (wr/100)*0.5})`;
      else if (wr >= 45) color = `rgba(255,184,0,${0.2 + 0.3})`;
      else               color = `rgba(255,69,96,${0.2 + ((100-wr)/100)*0.5})`;

      const px = z.col * cellSize;
      const py = (GRID - 1 - z.row) * cellSize;

      this.ctx.fillStyle = color;
      this.ctx.fillRect(px, py, cellSize, cellSize);

      // Label win rate si assez de données
      if (total >= 3) {
        this.ctx.fillStyle = '#fff';
        this.ctx.font = `bold ${Math.floor(cellSize * 0.28)}px DM Mono, monospace`;
        this.ctx.textAlign = 'center';
        this.ctx.fillText(`${wr}%`, px + cellSize/2, py + cellSize/2 + 4);
        this.ctx.font = `${Math.floor(cellSize * 0.2)}px DM Mono, monospace`;
        this.ctx.fillStyle = 'rgba(255,255,255,.6)';
        this.ctx.fillText(`${total} duels`, px + cellSize/2, py + cellSize/2 + cellSize*0.25);
      }
    });

    this.addLegend('Duel win zones');
  }

  // ── UTILITY MAP ───────────────────────────────────────────────────────────
  renderUtilityMap(grenades, playerName = null) {
    this.clear();
    const filtered = playerName
      ? grenades.filter(g => g.thrower === playerName)
      : grenades;

    const colors = {
      'weapon_flashbang':     'rgba(255,255,100,.7)',
      'weapon_smokegrenade':  'rgba(100,200,255,.7)',
      'weapon_hegrenade':     'rgba(255,100,100,.7)',
      'weapon_molotov':       'rgba(255,140,0,.7)',
      'weapon_incgrenade':    'rgba(255,140,0,.7)',
      'weapon_decoy':         'rgba(150,150,150,.5)',
    };

    filtered.forEach(g => {
      const { px, py } = worldToCanvas(g.startX, g.startY, this.mapName, this.size, this.size);
      const color = colors[g.type] || 'rgba(200,200,200,.5)';

      this.ctx.beginPath();
      this.ctx.arc(px, py, 5, 0, Math.PI * 2);
      this.ctx.fillStyle = color;
      this.ctx.fill();
      this.ctx.strokeStyle = 'rgba(255,255,255,.3)';
      this.ctx.lineWidth = 1;
      this.ctx.stroke();
    });

    this.addLegend(`Utility — ${playerName || 'tous les joueurs'}`);
  }

  // ── Légende ───────────────────────────────────────────────────────────────
  addLegend(title) {
    this.ctx.fillStyle = 'rgba(7,9,13,.7)';
    this.ctx.fillRect(8, 8, 200, 28);
    this.ctx.fillStyle = '#E8F4FD';
    this.ctx.font = '500 12px DM Mono, monospace';
    this.ctx.textAlign = 'left';
    this.ctx.fillText(title.toUpperCase(), 16, 27);
  }

  // ── Export PNG ────────────────────────────────────────────────────────────
  exportPNG(filename = 'fragvalue-heatmap.png') {
    const link    = document.createElement('a');
    link.download = filename;
    link.href     = this.canvas.toDataURL('image/png');
    link.click();
  }
}

// Export global
window.HeatmapRenderer = HeatmapRenderer;
window.worldToCanvas   = worldToCanvas;
