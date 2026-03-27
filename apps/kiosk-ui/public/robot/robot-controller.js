(function initRobotController(global) {
  'use strict';

  global.OrderRobot = global.OrderRobot || {};

  class RobotController {
    constructor(options) {
      this.robot = options.robot;
      this.head = options.head;
      this.body = options.body;
      this.neck = options.neck;
      this.leftArm = options.leftArm;
      this.rightArm = options.rightArm;
      this.core = options.core;
      this.face = options.face;
      this.viewport = options.viewport;
      this.discoBall = options.discoBall;
      this.getIsMenuOpen = options.getIsMenuOpen || (() => false);
      this.onRequestCloseMenu = options.onRequestCloseMenu || (() => {});
      this.isCinematicRunning = false;

      this.config = global.OrderRobot.config;
      this.actions = new global.OrderRobot.RobotActions(this);
      this.currentSkinId = this.config.defaultSkinId;
      this.currentActionId = null;
      this.effectPools = {
        heart: [],
        sparkle: [],
        confetti: [],
        laser: [],
        petal: [],
        orb: [],
        ribbon: [],
      };
      this.effectActive = new Set();
      this.triggerBindings = [];
      this.graphById = new Map();
      this.activeStudioConfig = global.OrderRobot.createDefaultRobotStudioConfig
        ? global.OrderRobot.createDefaultRobotStudioConfig()
        : this.config.defaultRobotStudioConfig;
      this.runtimeStats = {
        effectSpawned: 0,
        actionTriggered: 0,
        graphTriggered: 0,
      };
      this.actionAliases = {
        hero: 'heroLanding',
        heroLanding: 'heroLanding',
        dance: 'dance',
        scan: 'scan',
        wave: 'waveHello',
      };

      this.ensureFaceDecor();
      this.ensureEffectLayer();
      this.seedEffectPool();
      this.loadScalePercent(this.config.storageKeys.scalePercent);
      this.currentSkinId = this.loadSkin();
      this.applyStudioConfig(this.loadStudioConfig());
    }

    resolveActionAlias(actionId) {
      const safe = String(actionId || '').trim();
      if (!safe) return '';
      if (this.config.supportedActions.includes(safe)) return safe;
      return this.actionAliases[safe] || safe;
    }

    isActionEnabled(actionId) {
      const safe = this.resolveActionAlias(actionId);
      const enabledByList = this.activeStudioConfig.enabledActions.includes(safe);
      const enabledBySetting = this.activeStudioConfig.actionSettings?.[safe]?.enabled !== false;
      return enabledByList && enabledBySetting;
    }

    getActionSpeed(actionId) {
      const safe = this.resolveActionAlias(actionId);
      return Number(this.activeStudioConfig.actionSettings[safe]?.speed || 1);
    }

    getActionIntensity(actionId) {
      const safe = this.resolveActionAlias(actionId);
      return Number(this.activeStudioConfig.actionSettings[safe]?.intensity || this.activeStudioConfig.effectIntensity || 80);
    }

    getActionCooldown(actionId) {
      const safe = this.resolveActionAlias(actionId);
      return Number(this.activeStudioConfig.actionSettings[safe]?.cooldownMs || 350);
    }

    getQualityProfile() {
      const quality = String(this.activeStudioConfig.qualityProfile || 'cinema');
      if (quality === 'lite' || quality === 'standard' || quality === 'cinema') return quality;
      return 'cinema';
    }

    getEffectIntensityMultiplier() {
      const raw = Number(this.activeStudioConfig.effectIntensity || 85);
      const clamped = Math.max(0, Math.min(100, raw));
      return Math.max(0.12, clamped / 100);
    }

    getQualityEffectMultiplier() {
      const quality = this.getQualityProfile();
      if (quality === 'lite') return 0.34;
      if (quality === 'standard') return 0.68;
      return 1;
    }

    getMaxActiveEffects() {
      const quality = this.getQualityProfile();
      if (quality === 'lite') return 56;
      if (quality === 'standard') return 92;
      return 160;
    }

    getScaledEffectCount(baseCount) {
      const safeBase = Math.max(0, Number(baseCount) || 0);
      const scaled = Math.round(safeBase * this.getQualityEffectMultiplier() * this.getEffectIntensityMultiplier());
      return Math.max(1, scaled);
    }

    setCurrentAction(actionId) {
      this.currentActionId = actionId;
      this.runtimeStats.actionTriggered += 1;
    }

    clearCurrentAction() {
      this.currentActionId = null;
    }

    clampScalePercent(value) {
      if (!Number.isFinite(value)) return this.config.defaultScalePercent;
      return Math.max(this.config.minScalePercent, Math.min(this.config.maxScalePercent, Math.round(value)));
    }

    applyScalePercent(scalePercent) {
      const safePercent = this.clampScalePercent(scalePercent);
      document.documentElement.style.setProperty('--robot-scale-factor', String(safePercent / 100));
    }

    loadScalePercent(storageKey) {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw === null ? this.config.defaultScalePercent : Number(raw);
      this.applyScalePercent(parsed);
    }

    ensureFaceDecor() {
      if (!this.face) return;
      if (!this.face.querySelector('.face-nose')) {
        const nose = document.createElement('div');
        nose.className = 'face-nose';
        this.face.appendChild(nose);
      }
      if (!this.face.querySelector('.face-blush-left')) {
        const blushLeft = document.createElement('div');
        blushLeft.className = 'face-blush face-blush-left';
        this.face.appendChild(blushLeft);
      }
      if (!this.face.querySelector('.face-blush-right')) {
        const blushRight = document.createElement('div');
        blushRight.className = 'face-blush face-blush-right';
        this.face.appendChild(blushRight);
      }
      this.face.dataset.mouth = 'neutral';
      this.face.dataset.wink = 'false';
      this.face.dataset.blush = 'false';
      this.face.dataset.noseScrunch = 'false';
    }

    setFaceState(state) {
      if (!this.face) return;
      this.face.className = `w-24 h-10 bg-slate-900 rounded-full flex flex-col items-center justify-center gap-1 overflow-hidden transition-all duration-300 state-${state}`;
    }

    setFaceDetails(details = {}) {
      if (!this.face) return;
      if (typeof details.wink === 'boolean') this.face.dataset.wink = String(details.wink);
      if (typeof details.blush === 'boolean') this.face.dataset.blush = String(details.blush);
      if (typeof details.noseScrunch === 'boolean') this.face.dataset.noseScrunch = String(details.noseScrunch);
      if (typeof details.mouth === 'string') this.face.dataset.mouth = details.mouth;
    }

    ensureEffectLayer() {
      let layer = document.getElementById('robot-effects-layer');
      if (!layer) {
        layer = document.createElement('div');
        layer.id = 'robot-effects-layer';
        layer.className = 'robot-effects-layer';
        document.body.appendChild(layer);
      }
      this.effectLayer = layer;
    }

    seedEffectPool() {
      this.seedPoolType('heart', 20);
      this.seedPoolType('sparkle', 22);
      this.seedPoolType('confetti', 24);
      this.seedPoolType('laser', 12);
      this.seedPoolType('petal', 18);
      this.seedPoolType('orb', 18);
      this.seedPoolType('ribbon', 16);
    }

    seedPoolType(type, size) {
      if (!this.effectLayer) return;
      const pool = this.effectPools[type];
      for (let i = pool.length; i < size; i += 1) {
        const element = document.createElement('span');
        element.className = `robot-effect robot-effect-${type}`;
        element.dataset.type = type;
        element.style.display = 'none';
        this.effectLayer.appendChild(element);
        pool.push(element);
      }
    }

    spawnEffect(type, options = {}) {
      if (this.effectActive.size >= this.getMaxActiveEffects()) return;
      const pool = this.effectPools[type] || [];
      let element = pool.find((item) => !this.effectActive.has(item));
      if (!element) {
        this.seedPoolType(type, pool.length + 8);
        element = (this.effectPools[type] || []).find((item) => !this.effectActive.has(item));
      }
      if (!element) return;

      const quality = this.getQualityProfile();
      if (quality === 'lite' && (type === 'confetti' || type === 'laser' || type === 'ribbon')) return;

      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const x = Number.isFinite(options.x) ? options.x : Math.random() * viewportWidth;
      const y = Number.isFinite(options.y) ? options.y : Math.random() * viewportHeight;
      const sizeBase = Number.isFinite(options.size) ? options.size : 18 + Math.random() * 24;
      const driftX = Number.isFinite(options.driftX) ? options.driftX : Math.random() * 160 - 80;
      const riseY = Number.isFinite(options.riseY) ? options.riseY : 190 + Math.random() * 200;
      const durationBase = Number.isFinite(options.durationMs)
        ? options.durationMs
        : 920 + Math.random() * 920;
      const rotateDeg = Number.isFinite(options.rotateDeg) ? options.rotateDeg : Math.random() * 180 - 90;
      const qualityScale = quality === 'standard' ? 0.82 : quality === 'lite' ? 0.66 : 1;
      const intensityScale = Math.max(0.2, this.getEffectIntensityMultiplier());
      const size = Math.max(8, sizeBase * qualityScale * Math.max(0.7, intensityScale));
      const durationMs = Math.max(420, durationBase * qualityScale / Math.max(0.5, intensityScale));

      element.style.display = 'block';
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
      element.style.width = `${size}px`;
      element.style.height = `${size}px`;
      element.style.setProperty('--effect-size', `${size}px`);
      element.style.setProperty('--drift-x', `${driftX}px`);
      element.style.setProperty('--rise-y', `${riseY}px`);
      element.style.setProperty('--effect-duration', `${durationMs}ms`);
      element.style.setProperty('--effect-rotate', `${rotateDeg}deg`);
      element.classList.remove('active');
      element.offsetHeight;
      element.classList.add('active');
      this.effectActive.add(element);
      this.runtimeStats.effectSpawned += 1;

      const release = () => {
        element.classList.remove('active');
        element.style.display = 'none';
        this.effectActive.delete(element);
        element.removeEventListener('animationend', release);
      };
      element.addEventListener('animationend', release);
    }

    spawnBurst(type, count) {
      const total = this.getScaledEffectCount(count);
      for (let i = 0; i < total; i += 1) {
        this.spawnEffect(type, {
          x: window.innerWidth * 0.5 + (Math.random() * 220 - 110),
          y: window.innerHeight * 0.42 + (Math.random() * 110 - 55),
        });
      }
    }

    spawnRain(type, count) {
      const total = this.getScaledEffectCount(count);
      for (let i = 0; i < total; i += 1) {
        this.spawnEffect(type, {
          x: Math.random() * window.innerWidth,
          y: -40 - Math.random() * 100,
          durationMs: 1200 + Math.random() * 900,
          driftX: Math.random() * 100 - 50,
        });
      }
    }

    createShockwave() {
      const holder = document.getElementById('shockwave-holder');
      if (!holder) return;
      const wave = document.createElement('div');
      wave.className = 'shockwave animate-shockwave';
      holder.appendChild(wave);
      setTimeout(() => wave.remove(), 1000);
    }

    spawnSmoke() {
      const source = document.getElementById('breath-source');
      if (!source) return;
      const smoke = document.createElement('div');
      smoke.className = 'digital-smoke';
      smoke.style.left = `${Math.random() * 20 - 10}px`;
      smoke.style.animation = `smoke-rise ${1 + Math.random()}s forwards`;
      source.appendChild(smoke);
      setTimeout(() => smoke.remove(), 2000);
    }

    async enterDiscoMode() {
      this.discoBall.classList.remove('retract');
      this.discoBall.classList.add('active');
      document.body.classList.add('disco-on');
      await new Promise((resolve) => setTimeout(resolve, 450));
    }

    async exitDiscoMode() {
      this.discoBall.classList.remove('active');
      this.discoBall.classList.add('retract');
      await new Promise((resolve) => setTimeout(resolve, 340));
      document.body.classList.remove('disco-on');
      this.discoBall.classList.remove('retract');
    }

    loadStudioConfig() {
      const raw = localStorage.getItem(this.config.storageKeys.studioConfig);
      if (!raw) {
        return { ...this.config.defaultRobotStudioConfig };
      }
      try {
        const parsed = JSON.parse(raw);
        return { ...this.config.defaultRobotStudioConfig, ...parsed };
      } catch {
        return { ...this.config.defaultRobotStudioConfig };
      }
    }

    applyStudioConfig(configInput) {
      const incoming = configInput || {};
      const base = this.config.defaultRobotStudioConfig || {};
      const requiredLegacyActions = [
        'maidCurtseyBloom',
        'waiterServingSpin',
        'animeStarTrail',
        'pixelHeartStorm',
        'auroraOrbit',
      ];
      const incomingEnabled = Array.isArray(incoming.enabledActions)
        ? incoming.enabledActions.map((item) => String(item))
        : [];
      const incomingActionSettings = incoming.actionSettings && typeof incoming.actionSettings === 'object'
        ? incoming.actionSettings
        : {};
      const hasAnyRequiredAction = incomingEnabled.some((actionId) => requiredLegacyActions.includes(actionId))
        || requiredLegacyActions.some((actionId) => Object.prototype.hasOwnProperty.call(incomingActionSettings, actionId));
      const mergedEnabledActions = incomingEnabled.length > 0
        ? [...incomingEnabled]
        : [...(Array.isArray(base.enabledActions) ? base.enabledActions : [])];
      if (!hasAnyRequiredAction) {
        requiredLegacyActions.forEach((actionId) => {
          if (!mergedEnabledActions.includes(actionId)) {
            mergedEnabledActions.push(actionId);
          }
        });
      }
      const merged = {
        ...base,
        ...incoming,
        enabledActions: mergedEnabledActions,
        actionSettings: {
          ...(base.actionSettings || {}),
          ...(incomingActionSettings || {}),
        },
      };
      this.activeStudioConfig = merged;
      const enabledSkinIds = Array.isArray(merged.enabledSkinIds) ? merged.enabledSkinIds : [];
      if (enabledSkinIds.length > 0 && !enabledSkinIds.includes(merged.activeSkinId)) {
        this.activeStudioConfig.activeSkinId = enabledSkinIds[0];
      }

      if (Array.isArray(merged.graphBindings)) {
        this.graphById = new Map(merged.graphBindings.map((graph) => [graph.id, graph]));
      } else {
        this.graphById = new Map();
      }
      this.bindTriggers(Array.isArray(merged.triggerBindings) ? merged.triggerBindings : []);

      if (merged.activeSkinId) {
        this.applySkin(merged.activeSkinId);
      }

      if (Array.isArray(merged.uploadedAssets)) {
        for (const asset of merged.uploadedAssets) {
          global.OrderRobot.skins.registerUploadedAsset(asset);
        }
      }

      localStorage.setItem(this.config.storageKeys.studioConfig, JSON.stringify(merged));
      return merged;
    }

    bindTriggers(bindings) {
      this.triggerBindings = Array.isArray(bindings) ? bindings.filter((binding) => binding && binding.enabled !== false) : [];
    }

    evaluateCondition(condition, context = {}) {
      if (!condition) return true;
      const source = String(condition.source || '');
      const operator = String(condition.operator || 'equals');
      const expected = String(condition.value || '').toLowerCase();

      const sourceMap = {
        scene: context.scene,
        intent: context.intent,
        menu: this.getIsMenuOpen() ? 'open' : 'closed',
        presence: context.presence,
        emotion: context.emotion,
        action: this.currentActionId,
      };
      const rawValue = sourceMap[source] === undefined ? '' : String(sourceMap[source]);
      const actual = rawValue.toLowerCase();

      if (operator === 'contains') return actual.includes(expected);
      if (operator === 'notEquals') return actual !== expected;
      return actual === expected;
    }

    async dispatchTrigger(eventName, context = {}) {
      const safeEvent = String(eventName || '').trim();
      if (!safeEvent) return;
      for (const binding of this.triggerBindings) {
        if (!binding || binding.enabled === false || binding.event !== safeEvent) continue;
        const conditions = Array.isArray(binding.conditions) ? binding.conditions : [];
        const passed = conditions.every((condition) => this.evaluateCondition(condition, context));
        if (!passed) continue;

        if (binding.targetType === 'graph') {
          const graph = this.graphById.get(binding.targetId);
          if (graph) {
            this.runtimeStats.graphTriggered += 1;
            await this.actions.runGraph(graph, context);
          }
          continue;
        }

        if (binding.targetType === 'action') {
          await this.actions.trigger(binding.targetId, { ...context, force: true });
        }
      }
    }

    async triggerCinematic(type) {
      if (this.isCinematicRunning) return;
      this.isCinematicRunning = true;
      if (this.getIsMenuOpen()) {
        this.onRequestCloseMenu();
      }
      await this.actions.trigger(type, { force: true });
      this.isCinematicRunning = false;
      this.reset();
    }

    async runGraph(graphId, context = {}) {
      const graph = this.graphById.get(graphId);
      if (!graph) return;
      this.runtimeStats.graphTriggered += 1;
      await this.actions.runGraph(graph, context);
      this.reset();
    }

    stopGraph() {
      this.actions.stopGraph();
    }

    reactToConversation(meta = {}) {
      const scene = String(meta.scene || '').toLowerCase();
      const emotion = String(meta.emotionHint || '').toLowerCase();
      const actionHints = Array.isArray(meta.actionHints) ? meta.actionHints : [];
      const context = { scene, emotion, intent: meta.intent || '' };

      if (scene) {
        void this.dispatchTrigger(`voice.scene.${scene}`, context);
      }
      if (Array.isArray(actionHints)) {
        actionHints.forEach((actionId) => {
          void this.actions.trigger(actionId, { ...context, force: true });
        });
      }
      if (emotion && emotion.includes('cute')) {
        this.setFaceState('cute');
      }
    }

    reset() {
      this.robot.style.transition = 'transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
      this.robot.style.transform = '';
      this.robot.style.opacity = '1';
      this.head.style.transform = '';
      this.head.style.animation = 'none';
      this.body.style.animation = 'none';
      this.leftArm.style.transform = '';
      this.leftArm.style.animation = 'none';
      this.rightArm.style.transform = '';
      this.rightArm.style.animation = 'none';
      this.core.style.transform = '';
      this.core.style.boxShadow = '';
      this.core.style.background = '';
      this.body.style.transform = '';
      this.neck.style.transform = '';
      this.discoBall.classList.remove('active', 'retract');
      document.body.classList.remove('disco-on');
      this.setFaceState('normal');
      this.setFaceDetails({ wink: false, blush: false, noseScrunch: false, mouth: 'neutral' });
      this.viewport.classList.remove('shake-heavy');
      this.applySkin(this.currentSkinId);
    }

    applySkin(skinId) {
      const applied = global.OrderRobot.skins.applySkin(skinId);
      this.currentSkinId = applied;
      localStorage.setItem(this.config.storageKeys.skinId, applied);

      const gradient = getComputedStyle(document.documentElement).getPropertyValue('--robot-outfit-gradient');
      if (gradient) {
        this.body.style.background = gradient;
        this.head.style.background = '#ffffff';
      }

      const skinAssetId = this.activeStudioConfig.skinAssetBindings?.[applied];
      if (skinAssetId) {
        global.OrderRobot.skins.resolveUploadedAssetDataUrl(skinAssetId).then((dataUrl) => {
          if (!dataUrl) return;
          const gradientLayer = gradient ? `${gradient},` : '';
          this.body.style.backgroundImage = `${gradientLayer}url(${dataUrl})`;
          this.body.style.backgroundSize = 'cover';
          this.body.style.backgroundBlendMode = 'overlay';
        }).catch(() => {
          // ignore asset errors
        });
      } else {
        this.body.style.backgroundImage = '';
      }

      return applied;
    }

    loadSkin() {
      const saved = localStorage.getItem(this.config.storageKeys.skinId) || this.config.defaultSkinId;
      return this.applySkin(saved);
    }

    getRuntimeStats() {
      return {
        ...this.runtimeStats,
        activeEffects: this.effectActive.size,
        activeActionId: this.currentActionId,
      };
    }

    getInfo() {
      return {
        version: this.config.version,
        schemaVersion: this.config.schemaVersion,
        currentSkinId: this.currentSkinId,
        availableSkins: global.OrderRobot.skins.listSkins(),
        supportedActions: [...this.config.supportedActions],
        scaleRange: [this.config.minScalePercent, this.config.maxScalePercent],
        qualityProfile: this.activeStudioConfig.qualityProfile,
        expressiveMode: this.activeStudioConfig.expressiveMode,
        enabledActionsCount: this.activeStudioConfig.enabledActions.length,
        graphCount: this.graphById.size,
        modules: ['robot-config', 'robot-skins', 'robot-actions', 'robot-controller'],
      };
    }

    printInfo() {
      const info = this.getInfo();
      console.group('[OrderRobot] Architecture Info');
      console.log('version:', info.version);
      console.log('schema:', info.schemaVersion);
      console.log('modules:', info.modules.join(', '));
      console.log('current skin:', info.currentSkinId);
      console.log('available skins:', info.availableSkins.join(', '));
      console.log('supported actions:', info.supportedActions.join(', '));
      console.log('enabled actions:', info.enabledActionsCount);
      console.log('quality profile:', info.qualityProfile);
      console.log('expressive mode:', info.expressiveMode);
      console.log('graph count:', info.graphCount);
      console.log('scale range:', info.scaleRange[0], '->', info.scaleRange[1]);
      console.groupEnd();
      return info;
    }
  }

  global.OrderRobot.createRobotController = function createRobotController(options) {
    const controller = new RobotController(options);
    global.OrderRobot.controller = controller;
    global.OrderRobot.actions = {
      runGraph: (graphOrId, context = {}) => {
        if (typeof graphOrId === 'string') {
          return controller.runGraph(graphOrId, context);
        }
        if (graphOrId && Array.isArray(graphOrId.nodes)) {
          return controller.actions.runGraph(graphOrId, context);
        }
        return Promise.resolve();
      },
      stopGraph: () => controller.stopGraph(),
    };
    return controller;
  };
})(window);

