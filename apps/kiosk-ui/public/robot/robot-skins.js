(function initRobotSkins(global) {
  'use strict';

  global.OrderRobot = global.OrderRobot || {};

  const ASSET_DB_NAME = 'orderrobot-robot-studio-assets';
  const ASSET_STORE_NAME = 'assets';

  const SKINS = {
    'maid-classic': { label: 'Maid Classic', pack: 'maid', vars: { '--robot-core-color': '#f472b6', '--robot-core-glow': 'rgba(244,114,182,0.52)', '--robot-accent-color': '#111827', '--robot-outfit-gradient': 'linear-gradient(180deg,#ffffff,#e5e7eb)' } },
    'maid-sakura': { label: 'Maid Sakura', pack: 'maid', vars: { '--robot-core-color': '#fb7185', '--robot-core-glow': 'rgba(251,113,133,0.56)', '--robot-accent-color': '#7f1d1d', '--robot-outfit-gradient': 'linear-gradient(180deg,#fff1f2,#fecdd3)' } },
    'maid-midnight': { label: 'Maid Midnight', pack: 'maid', vars: { '--robot-core-color': '#a78bfa', '--robot-core-glow': 'rgba(167,139,250,0.55)', '--robot-accent-color': '#1f2937', '--robot-outfit-gradient': 'linear-gradient(180deg,#0f172a,#1e293b)' } },
    'maid-royal': { label: 'Maid Royal', pack: 'maid', vars: { '--robot-core-color': '#60a5fa', '--robot-core-glow': 'rgba(96,165,250,0.54)', '--robot-accent-color': '#1d4ed8', '--robot-outfit-gradient': 'linear-gradient(180deg,#dbeafe,#93c5fd)' } },
    'maid-pastel': { label: 'Maid Pastel', pack: 'maid', vars: { '--robot-core-color': '#f9a8d4', '--robot-core-glow': 'rgba(249,168,212,0.56)', '--robot-accent-color': '#6b21a8', '--robot-outfit-gradient': 'linear-gradient(180deg,#fdf2f8,#fae8ff)' } },
    'waiter-amber': { label: 'Waiter Amber', pack: 'waiter', vars: { '--robot-core-color': '#f59e0b', '--robot-core-glow': 'rgba(245,158,11,0.52)', '--robot-accent-color': '#78350f', '--robot-outfit-gradient': 'linear-gradient(180deg,#fff7ed,#fed7aa)' } },
    'waiter-cobalt': { label: 'Waiter Cobalt', pack: 'waiter', vars: { '--robot-core-color': '#38bdf8', '--robot-core-glow': 'rgba(56,189,248,0.52)', '--robot-accent-color': '#0f172a', '--robot-outfit-gradient': 'linear-gradient(180deg,#e0f2fe,#7dd3fc)' } },
    'waiter-olive': { label: 'Waiter Olive', pack: 'waiter', vars: { '--robot-core-color': '#84cc16', '--robot-core-glow': 'rgba(132,204,22,0.5)', '--robot-accent-color': '#365314', '--robot-outfit-gradient': 'linear-gradient(180deg,#f7fee7,#bef264)' } },
    'waiter-charcoal': { label: 'Waiter Charcoal', pack: 'waiter', vars: { '--robot-core-color': '#94a3b8', '--robot-core-glow': 'rgba(148,163,184,0.5)', '--robot-accent-color': '#111827', '--robot-outfit-gradient': 'linear-gradient(180deg,#334155,#1f2937)' } },
    'waiter-sunrise': { label: 'Waiter Sunrise', pack: 'waiter', vars: { '--robot-core-color': '#fb7185', '--robot-core-glow': 'rgba(251,113,133,0.54)', '--robot-accent-color': '#9a3412', '--robot-outfit-gradient': 'linear-gradient(180deg,#fff7ed,#fdba74)' } },
    'cute-cotton': { label: 'Cute Cotton', pack: 'cute', vars: { '--robot-core-color': '#22d3ee', '--robot-core-glow': 'rgba(34,211,238,0.55)', '--robot-accent-color': '#0f766e', '--robot-outfit-gradient': 'linear-gradient(180deg,#ecfeff,#cffafe)' } },
    'cute-berry': { label: 'Cute Berry', pack: 'cute', vars: { '--robot-core-color': '#f43f5e', '--robot-core-glow': 'rgba(244,63,94,0.56)', '--robot-accent-color': '#881337', '--robot-outfit-gradient': 'linear-gradient(180deg,#ffe4e6,#fecdd3)' } },
    'cute-mintpop': { label: 'Cute Mintpop', pack: 'cute', vars: { '--robot-core-color': '#10b981', '--robot-core-glow': 'rgba(16,185,129,0.56)', '--robot-accent-color': '#065f46', '--robot-outfit-gradient': 'linear-gradient(180deg,#ecfdf5,#a7f3d0)' } },
    'cute-lemon': { label: 'Cute Lemon', pack: 'cute', vars: { '--robot-core-color': '#facc15', '--robot-core-glow': 'rgba(250,204,21,0.56)', '--robot-accent-color': '#854d0e', '--robot-outfit-gradient': 'linear-gradient(180deg,#fefce8,#fde68a)' } },
    'cute-cloud': { label: 'Cute Cloud', pack: 'cute', vars: { '--robot-core-color': '#93c5fd', '--robot-core-glow': 'rgba(147,197,253,0.54)', '--robot-accent-color': '#3730a3', '--robot-outfit-gradient': 'linear-gradient(180deg,#eff6ff,#dbeafe)' } },
    'anime-luna': { label: 'Anime Luna', pack: 'anime', vars: { '--robot-core-color': '#818cf8', '--robot-core-glow': 'rgba(129,140,248,0.56)', '--robot-accent-color': '#312e81', '--robot-outfit-gradient': 'linear-gradient(180deg,#eef2ff,#c7d2fe)' } },
    'anime-starlight': { label: 'Anime Starlight', pack: 'anime', vars: { '--robot-core-color': '#f472b6', '--robot-core-glow': 'rgba(244,114,182,0.56)', '--robot-accent-color': '#7c3aed', '--robot-outfit-gradient': 'linear-gradient(180deg,#f5f3ff,#e9d5ff)' } },
    'anime-neonfox': { label: 'Anime Neonfox', pack: 'anime', vars: { '--robot-core-color': '#22d3ee', '--robot-core-glow': 'rgba(34,211,238,0.56)', '--robot-accent-color': '#7f1d1d', '--robot-outfit-gradient': 'linear-gradient(180deg,#0f172a,#1e293b)' } },
    'anime-fantasyrose': { label: 'Anime Fantasyrose', pack: 'anime', vars: { '--robot-core-color': '#fb7185', '--robot-core-glow': 'rgba(251,113,133,0.56)', '--robot-accent-color': '#9d174d', '--robot-outfit-gradient': 'linear-gradient(180deg,#fdf2f8,#fbcfe8)' } },
    'anime-aurora': { label: 'Anime Aurora', pack: 'anime', vars: { '--robot-core-color': '#34d399', '--robot-core-glow': 'rgba(52,211,153,0.56)', '--robot-accent-color': '#0369a1', '--robot-outfit-gradient': 'linear-gradient(180deg,#ecfeff,#bae6fd)' } },
  };

  const uploadedAssetMetaById = new Map();
  const uploadedAssetDataUrlById = new Map();

  function applySkin(skinId) {
    const safeId = SKINS[skinId] ? skinId : 'maid-classic';
    const vars = SKINS[safeId].vars;
    Object.entries(vars).forEach(([key, value]) => {
      document.documentElement.style.setProperty(key, value);
    });
    return safeId;
  }

  function listSkins() {
    return Object.keys(SKINS);
  }

  function listSkinMetadata() {
    return Object.entries(SKINS).map(([id, payload]) => ({
      id,
      label: payload.label,
      pack: payload.pack,
    }));
  }

  function registerSkin(skin) {
    if (!skin || !skin.id || !skin.vars) return null;
    SKINS[skin.id] = {
      label: String(skin.label || skin.id),
      pack: String(skin.pack || 'custom'),
      vars: { ...skin.vars },
    };
    return skin.id;
  }

  function removeSkin(skinId) {
    if (!SKINS[skinId]) return false;
    delete SKINS[skinId];
    return true;
  }

  function sanitizeSvgText(input) {
    const text = String(input || '');
    const withoutScript = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    const withoutForeignObject = withoutScript.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');
    const withoutInlineHandlers = withoutForeignObject.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
    return withoutInlineHandlers.replace(/(href|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '');
  }

  function openAssetDb() {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(ASSET_DB_NAME, 1);
      request.onerror = () => reject(request.error || new Error('Cannot open asset DB'));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ASSET_STORE_NAME)) {
          db.createObjectStore(ASSET_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  function readRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function withStore(mode, task) {
    return openAssetDb().then(async (db) => {
      try {
        const tx = db.transaction(ASSET_STORE_NAME, mode);
        const store = tx.objectStore(ASSET_STORE_NAME);
        const result = await task(store);
        await new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
        return result;
      } finally {
        db.close();
      }
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function registerUploadedAsset(assetMeta) {
    if (!assetMeta || !assetMeta.id) return null;
    uploadedAssetMetaById.set(assetMeta.id, { ...assetMeta });
    return assetMeta.id;
  }

  async function resolveUploadedAssetDataUrl(assetId) {
    const key = String(assetId || '');
    if (!key) return null;
    if (uploadedAssetDataUrlById.has(key)) {
      return uploadedAssetDataUrlById.get(key);
    }

    const record = await withStore('readonly', async (store) => {
      const value = await readRequest(store.get(key));
      return value || null;
    });
    if (!record || !record.blob) return null;

    let dataUrl = await blobToDataUrl(record.blob);
    if (record.mimeType === 'image/svg+xml') {
      const svgText = atob(dataUrl.split(',')[1] || '');
      const safeSvg = sanitizeSvgText(svgText);
      dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(safeSvg)}`;
    }
    uploadedAssetDataUrlById.set(key, dataUrl);
    return dataUrl;
  }

  function getSkinMap() {
    return { ...SKINS };
  }

  global.OrderRobot.skins = {
    applySkin,
    listSkins,
    listSkinMetadata,
    getSkinMap,
    registerSkin,
    removeSkin,
    registerUploadedAsset,
    resolveUploadedAssetDataUrl,
  };
})(window);

