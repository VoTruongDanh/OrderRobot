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
      this.currentSkinId = this.loadSkin();
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

    setFaceState(state) {
      if (!this.face) return;
      this.face.className = `w-24 h-10 bg-slate-900 rounded-full flex flex-col items-center justify-center gap-1 overflow-hidden transition-all duration-300 state-${state}`;
    }

    createShockwave() {
      const holder = document.getElementById('shockwave-holder');
      const wave = document.createElement('div');
      wave.className = 'shockwave animate-shockwave';
      holder.appendChild(wave);
      setTimeout(() => wave.remove(), 1000);
    }

    spawnSmoke() {
      const source = document.getElementById('breath-source');
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
      await new Promise((resolve) => setTimeout(resolve, 550));
    }

    async exitDiscoMode() {
      this.discoBall.classList.remove('active');
      this.discoBall.classList.add('retract');
      await new Promise((resolve) => setTimeout(resolve, 420));
      document.body.classList.remove('disco-on');
      this.discoBall.classList.remove('retract');
    }

    async triggerCinematic(type) {
      if (this.isCinematicRunning) return;
      this.isCinematicRunning = true;
      if (this.getIsMenuOpen()) {
        this.onRequestCloseMenu();
      }
      await this.actions.trigger(type);
      this.isCinematicRunning = false;
      this.reset();
    }

    reset() {
      this.robot.style.transition = 'transform 0.8s cubic-bezier(0.4, 0, 0.2, 1)';
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
      this.viewport.classList.remove('shake-heavy');
      this.applySkin(this.currentSkinId);
    }

    applySkin(skinId) {
      const applied = global.OrderRobot.skins.applySkin(skinId);
      this.currentSkinId = applied;
      localStorage.setItem(this.config.storageKeys.skinId, applied);
      return applied;
    }

    loadSkin() {
      const saved = localStorage.getItem(this.config.storageKeys.skinId) || this.config.defaultSkinId;
      return this.applySkin(saved);
    }

    getInfo() {
      return {
        version: this.config.version,
        currentSkinId: this.currentSkinId,
        availableSkins: global.OrderRobot.skins.listSkins(),
        supportedActions: [...this.config.supportedActions],
        scaleRange: [this.config.minScalePercent, this.config.maxScalePercent],
        modules: ['robot-config', 'robot-skins', 'robot-actions', 'robot-controller'],
      };
    }

    printInfo() {
      const info = this.getInfo();
      console.group('[OrderRobot] Architecture Info');
      console.log('version:', info.version);
      console.log('modules:', info.modules.join(', '));
      console.log('current skin:', info.currentSkinId);
      console.log('available skins:', info.availableSkins.join(', '));
      console.log('supported actions:', info.supportedActions.join(', '));
      console.log('scale range:', info.scaleRange[0], '->', info.scaleRange[1]);
      console.groupEnd();
      return info;
    }
  }

  global.OrderRobot.createRobotController = function createRobotController(options) {
    return new RobotController(options);
  };
})(window);
