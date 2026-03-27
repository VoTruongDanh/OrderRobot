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
      this.ensureHeadAccessoryNode();
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

    ensureHeadAccessoryNode() {
      if (!this.head) return null;
      let node = this.head.querySelector('#robot-head-accessory');
      if (!node) {
        node = document.createElement('div');
        node.id = 'robot-head-accessory';
        this.head.appendChild(node);
      }
      return node;
    }

    applyVariantClass(element, prefix, allowed, value, fallback) {
      if (!element) return fallback;
      const safe = allowed.includes(value) ? value : fallback;
      const classes = Array.from(element.classList);
      classes.forEach((className) => {
        if (className.startsWith(`${prefix}-`)) {
          element.classList.remove(className);
        }
      });
      element.classList.add(`${prefix}-${safe}`);
      return safe;
    }

    applyAvatarParts(partsInput) {
      const defaults = this.config.defaultRobotStudioConfig?.avatarParts || {
        headShape: 'visor',
        headAccessory: 'none',
        eyeStyle: 'visor',
        mouthStyle: 'line',
        faceFrameScale: 100,
        faceFrameVisible: true,
        armStyle: 'sleek',
        armColor: 'aqua',
        bodyShape: 'core',
        outfitStyle: 'service',
        randomSeed: 420,
      };
      const raw = partsInput && typeof partsInput === 'object' ? partsInput : {};
      const safe = {
        headShape: String(raw.headShape || defaults.headShape),
        headAccessory: String(raw.headAccessory || defaults.headAccessory),
        eyeStyle: String(raw.eyeStyle || defaults.eyeStyle),
        mouthStyle: String(raw.mouthStyle || defaults.mouthStyle),
        faceFrameScale: Number.isFinite(Number(raw.faceFrameScale)) ? Math.max(65, Math.min(145, Math.round(Number(raw.faceFrameScale)))) : defaults.faceFrameScale,
        faceFrameVisible: typeof raw.faceFrameVisible === 'boolean' ? raw.faceFrameVisible : defaults.faceFrameVisible,
        armStyle: String(raw.armStyle || defaults.armStyle),
        armColor: String(raw.armColor || defaults.armColor),
        bodyShape: String(raw.bodyShape || defaults.bodyShape),
        outfitStyle: String(raw.outfitStyle || defaults.outfitStyle),
        randomSeed: Number.isFinite(Number(raw.randomSeed)) ? Math.max(0, Math.min(999999, Math.round(Number(raw.randomSeed)))) : defaults.randomSeed,
      };

      this.applyVariantClass(this.head, 'head-shape', ['soft-square', 'visor', 'hex', 'bubble'], safe.headShape, defaults.headShape);
      this.applyVariantClass(this.leftArm, 'arm-style', ['sleek', 'chunky', 'floating'], safe.armStyle, defaults.armStyle);
      this.applyVariantClass(this.rightArm, 'arm-style', ['sleek', 'chunky', 'floating'], safe.armStyle, defaults.armStyle);
      this.applyVariantClass(this.body, 'body-shape', ['core', 'shield', 'orb', 'compact'], safe.bodyShape, defaults.bodyShape);
      this.applyVariantClass(this.body, 'outfit-style', ['service', 'street', 'formal', 'battle'], safe.outfitStyle, defaults.outfitStyle);

      if (this.face) {
        this.face.dataset.eyeStyle = this.applyVariantClass(this.face, 'eye-style', ['visor', 'round', 'anime', 'mono', 'happy', 'wink', 'surprised', 'sleepy'], safe.eyeStyle, defaults.eyeStyle).replace('eye-style-', '');
        this.face.dataset.mouthStyle = this.applyVariantClass(this.face, 'mouth-style', ['line', 'smile', 'pixel', 'none', 'big-smile', 'surprised-o', 'sad', 'tongue-out'], safe.mouthStyle, defaults.mouthStyle).replace('mouth-style-', '');
      }
      document.documentElement.style.setProperty('--robot-face-frame-scale', String(safe.faceFrameScale / 100));
      document.documentElement.style.setProperty('--robot-face-frame-opacity', safe.faceFrameVisible ? '1' : '0');

      const armColorById = {
        aqua: '#22d3ee',
        sunset: '#fb7185',
        mint: '#34d399',
        violet: '#a78bfa',
        mono: '#94a3b8',
      };
      const armColor = armColorById[safe.armColor] || armColorById[defaults.armColor] || '#22d3ee';
      document.documentElement.style.setProperty('--robot-arm-custom-color', armColor);

      const outfitOverlayById = {
        service: 'linear-gradient(180deg, rgba(255,255,255,0.1), rgba(255,255,255,0))',
        street: 'linear-gradient(135deg, rgba(16,185,129,0.24), rgba(34,197,94,0.04))',
        formal: 'linear-gradient(135deg, rgba(148,163,184,0.24), rgba(30,41,59,0.08))',
        battle: 'linear-gradient(135deg, rgba(251,113,133,0.26), rgba(30,41,59,0.12))',
      };
      document.documentElement.style.setProperty('--robot-outfit-overlay', outfitOverlayById[safe.outfitStyle] || outfitOverlayById[defaults.outfitStyle] || 'none');

      const accessory = this.ensureHeadAccessoryNode();
      if (accessory) {
        this.applyVariantClass(accessory, 'head-accessory', ['none', 'antenna', 'halo', 'crown'], safe.headAccessory, defaults.headAccessory);
      }
    }

    setFaceState(state) {
      if (!this.face) return;
      const eyeStyle = String(this.face.dataset.eyeStyle || 'visor');
      const mouthStyle = String(this.face.dataset.mouthStyle || 'line');
      this.face.className = `face-screen-panel absolute inset-0 flex flex-col items-center justify-center gap-3 transition-all duration-300 relative eye-style-${eyeStyle} mouth-style-${mouthStyle} state-${state}`;
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

    getFaceAnchorPoint() {
      if (this.face && typeof this.face.getBoundingClientRect === 'function') {
        const rect = this.face.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        }
      }
      return {
        x: window.innerWidth * 0.5,
        y: window.innerHeight * 0.42,
      };
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
      const origin = this.getFaceAnchorPoint();
      const spreadScale = this.getQualityProfile() === 'lite' ? 0.65 : this.getQualityProfile() === 'standard' ? 0.85 : 1;
      const spreadX = window.innerWidth * 0.48 * spreadScale;
      const spreadY = window.innerHeight * 0.44 * spreadScale;
      for (let i = 0; i < total; i += 1) {
        const radial = Math.pow(Math.random(), 0.58);
        const angle = Math.random() * Math.PI * 2;
        const deltaX = Math.cos(angle) * spreadX * radial + (Math.random() * 60 - 30);
        const deltaY = Math.sin(angle) * spreadY * radial + (Math.random() * 44 - 22);
        this.spawnEffect(type, {
          x: origin.x + (Math.random() * 46 - 23),
          y: origin.y + (Math.random() * 28 - 14),
          driftX: deltaX,
          // Animation uses translateY(-riseY), so invert sign to support full 360 spread.
          riseY: -deltaY,
          durationMs: 760 + Math.random() * 780 + radial * 260,
        });
      }
    }

    spawnRain(type, count) {
      const total = this.getScaledEffectCount(count);
      const qualityScale = this.getQualityProfile() === 'lite' ? 0.65 : this.getQualityProfile() === 'standard' ? 0.82 : 1;
      for (let i = 0; i < total; i += 1) {
        this.spawnEffect(type, {
          x: Math.random() * window.innerWidth,
          y: -20 - Math.random() * 120,
          durationMs: (1280 + Math.random() * 1100) * qualityScale,
          driftX: (Math.random() * 140 - 70) * qualityScale,
          // Negative riseY means particles travel downward across the viewport.
          riseY: -(window.innerHeight * (0.72 + Math.random() * 0.55) * qualityScale),
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
      if (this.discoBall?.classList) {
        this.discoBall.classList.remove('retract');
        this.discoBall.classList.add('active');
      }
      document.body.classList.add('disco-on');
      await new Promise((resolve) => setTimeout(resolve, 450));
    }

    async exitDiscoMode() {
      if (this.discoBall?.classList) {
        this.discoBall.classList.remove('active');
        this.discoBall.classList.add('retract');
      }
      await new Promise((resolve) => setTimeout(resolve, 340));
      document.body.classList.remove('disco-on');
      if (this.discoBall?.classList) {
        this.discoBall.classList.remove('retract');
      }
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
      if (this.isCinematicRunning) return false;
      this.isCinematicRunning = true;
      try {
        if (this.getIsMenuOpen()) {
          this.onRequestCloseMenu();
        }
        return await this.actions.trigger(type, { force: true });
      } catch (error) {
        console.warn('[OrderRobot] triggerCinematic failed:', error);
        return false;
      } finally {
        this.isCinematicRunning = false;
        this.reset();
      }
    }

    async runGraph(graphId, context = {}) {
      const graph = this.graphById.get(graphId);
      if (!graph) return false;
      this.runtimeStats.graphTriggered += 1;
      try {
        await this.actions.runGraph(graph, context);
        return true;
      } catch (error) {
        console.warn('[OrderRobot] runGraph failed:', error);
        return false;
      } finally {
        this.reset();
      }
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
      if (this.discoBall?.classList) {
        this.discoBall.classList.remove('active', 'retract');
      }
      document.body.classList.remove('disco-on');
      this.setFaceState('normal');
      this.setFaceDetails({ wink: false, blush: false, noseScrunch: false, mouth: 'neutral' });
      if (this.viewport?.classList) {
        this.viewport.classList.remove('shake-heavy');
      }
      this.applySkin(this.currentSkinId);
    }

    applySkin(skinId) {
      const applied = global.OrderRobot.skins.applySkin(skinId);
      this.currentSkinId = applied;
      localStorage.setItem(this.config.storageKeys.skinId, applied);
      this.applyAvatarParts(this.activeStudioConfig?.avatarParts);

      const rootStyle = getComputedStyle(document.documentElement);
      const gradient = rootStyle.getPropertyValue('--robot-outfit-gradient').trim();
      const outfitOverlay = rootStyle.getPropertyValue('--robot-outfit-overlay').trim();
      const accentColor = rootStyle.getPropertyValue('--robot-accent-color').trim() || '#334155';
      const coreColor = rootStyle.getPropertyValue('--robot-core-color').trim() || '#00d2fd';
      const coreGlow = rootStyle.getPropertyValue('--robot-core-glow').trim() || 'rgba(0,210,253,0.5)';
      if (gradient) {
        this.body.style.background = gradient;
        this.body.style.backgroundImage = outfitOverlay && outfitOverlay !== 'none' ? `${outfitOverlay}, ${gradient}` : gradient;
        this.body.style.backgroundBlendMode = outfitOverlay && outfitOverlay !== 'none' ? 'soft-light,normal' : '';
      }
      this.head.style.background = 'linear-gradient(180deg,#ffffff 0%,#e2e8f0 100%)';
      this.head.style.border = `1px solid ${accentColor}`;
      this.head.style.boxShadow = `0 14px 28px ${coreGlow}`;
      this.neck.style.background = accentColor;
      this.neck.style.boxShadow = `0 0 16px ${coreGlow}`;
      this.leftArm.style.background = 'linear-gradient(180deg,#ffffff 0%,#e5e7eb 68%,var(--robot-arm-custom-color) 100%)';
      this.rightArm.style.background = 'linear-gradient(180deg,#ffffff 0%,#e5e7eb 68%,var(--robot-arm-custom-color) 100%)';
      this.core.style.background = coreColor;
      this.core.style.boxShadow = `0 0 18px ${coreGlow}`;
      this.robot.style.filter = `drop-shadow(0 16px 30px ${coreGlow})`;

      const skinAssetId = this.activeStudioConfig.skinAssetBindings?.[applied];
      if (skinAssetId) {
        global.OrderRobot.skins.resolveUploadedAssetDataUrl(skinAssetId).then((dataUrl) => {
          if (!dataUrl) return;
          const overlayLayer = outfitOverlay && outfitOverlay !== 'none' ? `${outfitOverlay},` : '';
          const gradientLayer = gradient ? `${gradient},` : '';
          this.body.style.backgroundImage = `${overlayLayer}${gradientLayer}url(${dataUrl})`;
          this.body.style.backgroundSize = 'cover';
          this.body.style.backgroundBlendMode = overlayLayer ? 'soft-light,normal,overlay' : 'overlay';
        }).catch(() => {
          // ignore asset errors
        });
      } else {
        this.body.style.backgroundImage = gradient
          ? (outfitOverlay && outfitOverlay !== 'none' ? `${outfitOverlay}, ${gradient}` : gradient)
          : '';
        this.body.style.backgroundBlendMode = outfitOverlay && outfitOverlay !== 'none' ? 'soft-light,normal' : '';
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

