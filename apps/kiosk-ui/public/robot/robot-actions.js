(function initRobotActions(global) {
  'use strict';

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function scaledMs(baseMs, speed) {
    const safeSpeed = Math.max(0.35, Math.min(2.5, Number(speed) || 1));
    return Math.max(40, Math.round(baseMs / safeSpeed));
  }

  class RobotActions {
    constructor(ctx) {
      this.ctx = ctx;
      this.graphRunToken = 0;
      this.actionCooldownUntil = new Map();
      this.actionMap = {
        plasmaSurge: (payload) => this.playPlasmaSurge(payload),
        heroLanding: (payload) => this.playHeroLanding(payload),
        zeroG: (payload) => this.playZeroG(payload),
        dance: (payload) => this.playDance(payload),
        scan: (payload) => this.playScan(payload),
        glitch: (payload) => this.playGlitch(payload),
        overdrive: (payload) => this.playOverdrive(payload),
        waveHello: (payload) => this.playWaveHello(payload),
        nodYes: (payload) => this.playNodYes(payload),
        bowElegant: (payload) => this.playBowElegant(payload),
        spinTwirl: (payload) => this.playSpinTwirl(payload),
        jumpJoy: (payload) => this.playJumpJoy(payload),
        lightPulse: (payload) => this.playLightPulse(payload),
        laserSweep: (payload) => this.playLaserSweep(payload),
        confettiBurst: (payload) => this.playConfettiBurst(payload),
        blowKissHearts: (payload) => this.playBlowKissHearts(payload),
        winkPulse: (payload) => this.playWinkPulse(payload),
        blushShy: (payload) => this.playBlushShy(payload),
        heartRain: (payload) => this.playHeartRain(payload),
        cheerSparkle: (payload) => this.playCheerSparkle(payload),
        noseScrunch: (payload) => this.playNoseScrunch(payload),
        smileBounce: (payload) => this.playSmileBounce(payload),
        hugGesture: (payload) => this.playHugGesture(payload),
        clapHappy: (payload) => this.playClapHappy(payload),
        peacePose: (payload) => this.playPeacePose(payload),
        maidCurtseyBloom: (payload) => this.playMaidCurtseyBloom(payload),
        waiterServingSpin: (payload) => this.playWaiterServingSpin(payload),
        animeStarTrail: (payload) => this.playAnimeStarTrail(payload),
        pixelHeartStorm: (payload) => this.playPixelHeartStorm(payload),
        auroraOrbit: (payload) => this.playAuroraOrbit(payload),
      };
    }

    async trigger(type, options = {}) {
      const actionId = this.ctx.resolveActionAlias(type);
      if (!actionId || !this.actionMap[actionId]) return false;
      if (!this.ctx.isActionEnabled(actionId)) return false;

      const cooldownMs = this.ctx.getActionCooldown(actionId);
      const now = Date.now();
      const coolingUntil = this.actionCooldownUntil.get(actionId) || 0;
      if (!options.force && now < coolingUntil) {
        return false;
      }

      const speed = this.ctx.getActionSpeed(actionId);
      const intensity = this.ctx.getActionIntensity(actionId);
      this.ctx.setCurrentAction(actionId);
      try {
        await this.actionMap[actionId]({ speed, intensity, options });
        return true;
      } finally {
        this.actionCooldownUntil.set(actionId, Date.now() + cooldownMs);
        this.ctx.clearCurrentAction();
      }
    }

    stopGraph() {
      this.graphRunToken += 1;
    }

    async runGraph(graphDefinition, context = {}) {
      if (!graphDefinition || !Array.isArray(graphDefinition.nodes) || graphDefinition.nodes.length === 0) {
        return;
      }

      const runToken = ++this.graphRunToken;
      const nodesById = new Map(graphDefinition.nodes.map((node) => [node.id, node]));
      let currentNodeId = graphDefinition.startNodeId || graphDefinition.nodes[0].id;
      let guard = 0;
      while (currentNodeId && guard < 120) {
        guard += 1;
        if (runToken !== this.graphRunToken) return;
        const node = nodesById.get(currentNodeId);
        if (!node) return;

        if (node.type === 'action') {
          await this.trigger(node.actionId, { ...context, force: true });
          currentNodeId = node.nextNodeId || null;
          continue;
        }

        if (node.type === 'wait') {
          const delay = Number.isFinite(node.delayMs) ? Math.max(0, node.delayMs) : 350;
          await sleep(delay);
          currentNodeId = node.nextNodeId || null;
          continue;
        }

        if (node.type === 'condition') {
          const isTrue = this.ctx.evaluateCondition(node.condition, context);
          currentNodeId = isTrue ? (node.trueNodeId || node.nextNodeId || null) : (node.falseNodeId || null);
          continue;
        }

        return;
      }
    }

    async withPose(setup, holdMs = 300, teardown) {
      setup();
      await sleep(holdMs);
      if (teardown) teardown();
    }

    async pulseCore(color, loops = 3, intervalMs = 120) {
      const c = this.ctx;
      for (let i = 0; i < loops; i += 1) {
        c.core.style.transform = 'scale(1.8)';
        c.core.style.background = color;
        c.core.style.boxShadow = `0 0 32px ${color}`;
        await sleep(intervalMs);
        c.core.style.transform = 'scale(1)';
        await sleep(intervalMs);
      }
    }

    async playPlasmaSurge({ intensity = 82, speed = 1 } = {}) {
      const c = this.ctx;
      c.setFaceState('angry');
      c.setFaceDetails({ mouth: 'tiny', noseScrunch: true });
      c.viewport.classList.add('shake-heavy');
      c.robot.style.transform = 'scale(1.84) translateY(-10px) rotate(-2deg)';
      await this.pulseCore('#00d2fd', Math.max(3, Math.round(intensity / 28)), scaledMs(92, speed));
      c.spawnBurst('laser', 12 + Math.round(intensity / 9));
      c.createShockwave();
      c.spawnBurst('sparkle', 14 + Math.round(intensity / 5));
      c.spawnBurst('orb', 8 + Math.round(intensity / 12));
      c.spawnSmoke();
      await sleep(scaledMs(540, speed));
      c.setFaceDetails({ mouth: 'neutral', noseScrunch: false });
      c.viewport.classList.remove('shake-heavy');
    }

    async playHeroLanding({ intensity = 82, speed = 1 } = {}) {
      const c = this.ctx;
      c.setFaceState('surprised');
      c.setFaceDetails({ mouth: 'tiny' });
      c.robot.style.transform = 'scale(0.45) translateY(-920px)';
      await sleep(scaledMs(360, speed));
      c.robot.style.transform = 'scale(1.85) translateY(58px)';
      await sleep(scaledMs(290, speed));
      c.createShockwave();
      c.spawnBurst('confetti', 20 + Math.round(intensity / 3));
      c.spawnBurst('petal', 14 + Math.round(intensity / 6));
      c.spawnBurst('sparkle', 12 + Math.round(intensity / 8));
      c.setFaceState('happy');
      c.setFaceDetails({ mouth: 'smile', blush: true });
      await sleep(scaledMs(520, speed));
    }

    async playZeroG() {
      const c = this.ctx;
      c.setFaceState('surprised');
      c.robot.style.transform = 'scale(1.65) translateY(-140px)';
      c.head.style.animation = 'orbit-parts 3.8s linear infinite';
      c.body.style.animation = 'orbit-parts 3.8s linear infinite reverse';
      c.leftArm.style.animation = 'orbit-parts 3.8s linear infinite 0.35s';
      c.rightArm.style.animation = 'orbit-parts 3.8s linear infinite 0.68s';
      await sleep(2100);
      c.head.style.animation = 'none';
      c.body.style.animation = 'none';
      c.leftArm.style.animation = 'none';
      c.rightArm.style.animation = 'none';
      c.setFaceState('happy');
    }

    async playDance({ intensity = 82, speed = 1 } = {}) {
      const c = this.ctx;
      await c.enterDiscoMode();
      c.setFaceState('happy');
      c.setFaceDetails({ mouth: 'smile', blush: true });
      const loops = Math.max(8, Math.round(8 + intensity / 15));
      for (let i = 0; i < loops; i += 1) {
        const tilt = i % 2 ? 18 : -18;
        const jump = i % 3 === 0 ? -132 : -92;
        c.robot.style.transform = `scale(1.62) translateY(${jump}px) rotate(${tilt}deg)`;
        c.leftArm.style.transform = `rotate(${i % 2 ? -140 : -22}deg)`;
        c.rightArm.style.transform = `rotate(${i % 2 ? 30 : 138}deg)`;
        if (i % 3 === 0) c.setFaceDetails({ wink: true });
        else c.setFaceDetails({ wink: false });
        c.spawnBurst('sparkle', 4 + Math.round(intensity / 30));
        if (i % 2 === 0) c.spawnBurst('orb', 2);
        await sleep(scaledMs(120, speed));
      }
      c.setFaceDetails({ wink: false });
      await c.exitDiscoMode();
    }

    async playScan({ speed = 1, intensity = 82 } = {}) {
      const c = this.ctx;
      c.setFaceState('attentive');
      c.setFaceDetails({ mouth: 'tiny' });
      c.head.style.transform = 'rotateY(150deg)';
      c.spawnBurst('laser', 6 + Math.round(intensity / 20));
      c.spawnBurst('orb', 3);
      await sleep(scaledMs(220, speed));
      c.head.style.transform = 'rotateY(-140deg)';
      c.spawnBurst('laser', 5 + Math.round(intensity / 22));
      await sleep(scaledMs(240, speed));
      c.head.style.transform = 'rotateY(0deg)';
      c.setFaceDetails({ mouth: 'neutral' });
      await sleep(scaledMs(180, speed));
    }

    async playGlitch() {
      const c = this.ctx;
      for (let i = 0; i < 12; i += 1) {
        c.robot.style.opacity = Math.random() > 0.5 ? '0.28' : '1';
        c.robot.style.transform = `scale(1.6) translate(${Math.random() * 18 - 9}px, ${Math.random() * 18 - 9}px)`;
        await sleep(45);
      }
      c.robot.style.opacity = '1';
    }

    async playOverdrive({ intensity = 82, speed = 1 } = {}) {
      const c = this.ctx;
      c.setFaceState('angry');
      c.setFaceDetails({ mouth: 'tiny', noseScrunch: true });
      c.core.style.background = '#ff1d48';
      c.core.style.boxShadow = '0 0 38px #ff1d48';
      c.robot.style.transform = 'scale(1.9)';
      c.spawnBurst('laser', 10 + Math.round(intensity / 9));
      c.spawnBurst('confetti', 12 + Math.round(intensity / 8));
      c.spawnBurst('ribbon', 8 + Math.round(intensity / 15));
      await sleep(scaledMs(820, speed));
      c.setFaceDetails({ noseScrunch: false, mouth: 'neutral' });
    }

    async playWaveHello() {
      const c = this.ctx;
      c.setFaceState('happy');
      for (let i = 0; i < 3; i += 1) {
        c.rightArm.style.transform = 'rotate(122deg)';
        await sleep(150);
        c.rightArm.style.transform = 'rotate(24deg)';
        await sleep(140);
      }
    }

    async playNodYes() {
      const c = this.ctx;
      c.setFaceState('attentive');
      for (let i = 0; i < 3; i += 1) {
        c.head.style.transform = 'translateY(10px)';
        await sleep(120);
        c.head.style.transform = 'translateY(0px)';
        await sleep(120);
      }
    }

    async playBowElegant() {
      const c = this.ctx;
      c.setFaceState('happy');
      c.robot.style.transform = 'scale(1.52) translateY(14px)';
      c.head.style.transform = 'translateY(16px)';
      await sleep(360);
      c.robot.style.transform = 'scale(1.6)';
      c.head.style.transform = '';
    }

    async playSpinTwirl() {
      const c = this.ctx;
      c.setFaceState('surprised');
      c.robot.style.transition = 'transform 0.22s ease';
      for (let i = 0; i < 6; i += 1) {
        c.robot.style.transform = `scale(1.6) rotate(${i * 60}deg)`;
        await sleep(120);
      }
      c.spawnBurst('sparkle', 18);
    }

    async playJumpJoy() {
      const c = this.ctx;
      c.setFaceState('happy');
      for (let i = 0; i < 3; i += 1) {
        c.robot.style.transform = 'scale(1.64) translateY(-120px)';
        await sleep(130);
        c.robot.style.transform = 'scale(1.6) translateY(0px)';
        await sleep(140);
      }
    }

    async playLightPulse({ intensity }) {
      await this.pulseCore('#4ee9ff', Math.max(3, Math.round(intensity / 22)), 100);
    }

    async playLaserSweep() {
      const c = this.ctx;
      c.setFaceState('attentive');
      c.spawnBurst('laser', 20);
      await sleep(450);
    }

    async playConfettiBurst({ intensity = 82, speed = 1 } = {}) {
      const c = this.ctx;
      c.setFaceState('happy');
      c.setFaceDetails({ mouth: 'smile', blush: true });
      c.spawnBurst('confetti', 20 + Math.round(intensity / 4));
      c.spawnBurst('ribbon', 10 + Math.round(intensity / 8));
      await sleep(scaledMs(280, speed));
      c.spawnBurst('sparkle', 8 + Math.round(intensity / 12));
      await sleep(scaledMs(260, speed));
    }

    async playBlowKissHearts({ intensity, speed } = {}) {
      const c = this.ctx;
      c.setFaceState('cute');
      c.setFaceDetails({ wink: true, mouth: 'kiss', blush: true });
      c.rightArm.style.transform = 'rotate(118deg)';
      c.leftArm.style.transform = 'rotate(-30deg)';
      c.robot.style.transform = 'scale(1.63) translateY(-14px)';
      c.spawnBurst('heart', 22 + Math.round(intensity / 3));
      await sleep(scaledMs(220, speed));
      c.spawnRain('heart', 20 + Math.round(intensity / 2));
      c.spawnBurst('sparkle', 10 + Math.round(intensity / 10));
      await sleep(scaledMs(430, speed));
      c.setFaceDetails({ wink: false, mouth: 'smile', blush: true });
      c.robot.style.transform = 'scale(1.6)';
      c.leftArm.style.transform = '';
      c.rightArm.style.transform = '';
    }

    async playWinkPulse({ speed } = {}) {
      const c = this.ctx;
      c.setFaceState('cute');
      c.setFaceDetails({ wink: true, blush: true });
      c.spawnBurst('sparkle', 12);
      await this.pulseCore('#ff89d6', 1, scaledMs(90, speed));
      await sleep(scaledMs(320, speed));
      c.setFaceDetails({ wink: false });
    }

    async playBlushShy({ speed } = {}) {
      const c = this.ctx;
      c.setFaceState('cute');
      c.setFaceDetails({ blush: true, mouth: 'tiny' });
      c.head.style.transform = 'translateY(8px)';
      await sleep(scaledMs(420, speed));
      c.head.style.transform = '';
    }

    async playHeartRain({ intensity, speed } = {}) {
      const c = this.ctx;
      c.setFaceState('cute');
      c.setFaceDetails({ mouth: 'smile', blush: true });
      c.spawnRain('heart', 24 + Math.round(intensity / 2));
      c.spawnBurst('sparkle', 8 + Math.round(intensity / 12));
      await sleep(scaledMs(820, speed));
    }

    async playCheerSparkle({ intensity, speed } = {}) {
      const c = this.ctx;
      c.setFaceState('happy');
      c.leftArm.style.transform = 'rotate(-128deg)';
      c.rightArm.style.transform = 'rotate(128deg)';
      c.spawnBurst('sparkle', 16 + Math.round(intensity / 4));
      if (c.getQualityProfile && c.getQualityProfile() === 'cinema') {
        c.spawnBurst('confetti', 10 + Math.round(intensity / 8));
      }
      await sleep(scaledMs(420, speed));
    }

    async playNoseScrunch({ speed } = {}) {
      const c = this.ctx;
      c.setFaceState('cute');
      c.setFaceDetails({ noseScrunch: true, mouth: 'tiny', blush: true });
      await sleep(scaledMs(260, speed));
      c.setFaceDetails({ noseScrunch: false, mouth: 'smile', blush: true });
    }

    async playSmileBounce({ speed } = {}) {
      const c = this.ctx;
      c.setFaceState('happy');
      c.setFaceDetails({ mouth: 'smile', blush: true });
      for (let i = 0; i < 3; i += 1) {
        c.robot.style.transform = 'scale(1.65) translateY(-45px)';
        await sleep(scaledMs(100, speed));
        c.robot.style.transform = 'scale(1.6)';
        await sleep(scaledMs(100, speed));
      }
    }

    async playHugGesture({ speed } = {}) {
      const c = this.ctx;
      c.setFaceState('cute');
      c.setFaceDetails({ mouth: 'smile', blush: true });
      c.leftArm.style.transform = 'rotate(-104deg)';
      c.rightArm.style.transform = 'rotate(104deg)';
      c.spawnBurst('heart', 14);
      await sleep(scaledMs(180, speed));
      c.leftArm.style.transform = 'rotate(-72deg)';
      c.rightArm.style.transform = 'rotate(72deg)';
      c.spawnBurst('sparkle', 8);
      await sleep(scaledMs(180, speed));
      c.leftArm.style.transform = 'rotate(-104deg)';
      c.rightArm.style.transform = 'rotate(104deg)';
      c.spawnBurst('heart', 10);
      await sleep(scaledMs(220, speed));
    }

    async playClapHappy({ speed = 1, intensity = 82 } = {}) {
      const c = this.ctx;
      c.setFaceState('happy');
      c.setFaceDetails({ mouth: 'smile', blush: true });
      for (let i = 0; i < 4; i += 1) {
        c.leftArm.style.transform = 'rotate(-68deg)';
        c.rightArm.style.transform = 'rotate(68deg)';
        c.spawnBurst('sparkle', 2 + Math.round(intensity / 40));
        await sleep(scaledMs(90, speed));
        c.leftArm.style.transform = 'rotate(-20deg)';
        c.rightArm.style.transform = 'rotate(20deg)';
        await sleep(scaledMs(90, speed));
      }
    }

    async playPeacePose({ speed = 1, intensity = 82 } = {}) {
      const c = this.ctx;
      c.setFaceState('cute');
      c.setFaceDetails({ wink: true, mouth: 'smile', blush: true });
      c.leftArm.style.transform = 'rotate(-138deg)';
      c.rightArm.style.transform = 'rotate(38deg)';
      c.spawnBurst('sparkle', 8 + Math.round(intensity / 16));
      c.spawnBurst('heart', 7 + Math.round(intensity / 20));
      await sleep(scaledMs(500, speed));
      c.setFaceDetails({ wink: false });
    }

    async playMaidCurtseyBloom({ intensity = 82, speed = 1 } = {}) {
      const c = this.ctx;
      c.setFaceState('cute');
      c.setFaceDetails({ mouth: 'smile', blush: true });
      c.leftArm.style.transform = 'rotate(-92deg)';
      c.rightArm.style.transform = 'rotate(16deg)';
      c.robot.style.transform = 'scale(1.54) translateY(20px)';
      c.head.style.transform = 'translateY(10px)';
      c.spawnBurst('petal', 14 + Math.round(intensity / 7));
      await sleep(scaledMs(380, speed));
      c.robot.style.transform = 'scale(1.63) translateY(-16px) rotate(8deg)';
      c.spawnBurst('sparkle', 10 + Math.round(intensity / 12));
      c.spawnBurst('heart', 8 + Math.round(intensity / 14));
      await sleep(scaledMs(340, speed));
      c.head.style.transform = '';
    }

    async playWaiterServingSpin({ intensity = 82, speed = 1 } = {}) {
      const c = this.ctx;
      c.setFaceState('attentive');
      c.setFaceDetails({ mouth: 'smile' });
      c.leftArm.style.transform = 'rotate(-18deg)';
      c.rightArm.style.transform = 'rotate(88deg)';
      c.robot.style.transform = 'scale(1.62) translateY(-12px)';
      c.spawnBurst('orb', 8 + Math.round(intensity / 14));
      await sleep(scaledMs(230, speed));
      for (let i = 0; i < 3; i += 1) {
        c.robot.style.transform = `scale(1.62) translateY(-12px) rotate(${(i + 1) * 120}deg)`;
        c.spawnBurst('sparkle', 4 + Math.round(intensity / 28));
        await sleep(scaledMs(130, speed));
      }
      c.spawnBurst('ribbon', 6 + Math.round(intensity / 20));
      await sleep(scaledMs(260, speed));
    }

    async playAnimeStarTrail({ intensity = 82, speed = 1 } = {}) {
      const c = this.ctx;
      c.setFaceState('surprised');
      c.setFaceDetails({ mouth: 'tiny' });
      for (let i = 0; i < 5; i += 1) {
        c.robot.style.transform = `scale(1.67) translateY(${i % 2 === 0 ? -88 : -46}px) rotate(${i * 72}deg)`;
        c.spawnBurst('sparkle', 6 + Math.round(intensity / 24));
        c.spawnBurst('orb', 4 + Math.round(intensity / 30));
        await sleep(scaledMs(110, speed));
      }
      c.spawnBurst('laser', 10 + Math.round(intensity / 10));
      c.setFaceState('happy');
      c.setFaceDetails({ mouth: 'smile' });
      await sleep(scaledMs(280, speed));
    }

    async playPixelHeartStorm({ intensity = 82, speed = 1 } = {}) {
      const c = this.ctx;
      c.setFaceState('cute');
      c.setFaceDetails({ wink: true, mouth: 'kiss', blush: true });
      c.leftArm.style.transform = 'rotate(-42deg)';
      c.rightArm.style.transform = 'rotate(118deg)';
      c.spawnBurst('heart', 28 + Math.round(intensity / 2));
      c.spawnRain('heart', 24 + Math.round(intensity / 2));
      c.spawnBurst('ribbon', 10 + Math.round(intensity / 10));
      await sleep(scaledMs(430, speed));
      c.spawnBurst('sparkle', 14 + Math.round(intensity / 12));
      await sleep(scaledMs(320, speed));
      c.setFaceDetails({ wink: false, mouth: 'smile' });
    }

    async playAuroraOrbit({ intensity = 82, speed = 1 } = {}) {
      const c = this.ctx;
      c.setFaceState('attentive');
      c.setFaceDetails({ mouth: 'tiny' });
      c.robot.style.transform = 'scale(1.66) translateY(-96px)';
      c.head.style.animation = 'orbit-parts 3.3s linear infinite';
      c.body.style.animation = 'orbit-parts 3.3s linear infinite reverse';
      c.spawnRain('orb', 16 + Math.round(intensity / 4));
      c.spawnBurst('laser', 8 + Math.round(intensity / 13));
      await sleep(scaledMs(1480, speed));
      c.head.style.animation = 'none';
      c.body.style.animation = 'none';
      c.spawnBurst('petal', 10 + Math.round(intensity / 14));
      c.setFaceState('happy');
      c.setFaceDetails({ mouth: 'smile', blush: true });
      await sleep(scaledMs(260, speed));
    }
  }

  global.OrderRobot = global.OrderRobot || {};
  global.OrderRobot.RobotActions = RobotActions;
})(window);

