(function initRobotActions(global) {
  'use strict';

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  class RobotActions {
    constructor(ctx) {
      this.ctx = ctx;
    }

    async trigger(type) {
      switch (type) {
        case 'plasmaSurge':
          await this.playPlasmaSurge();
          break;
        case 'heroLanding':
          await this.playHeroLanding();
          break;
        case 'zeroG':
          await this.playZeroG();
          break;
        case 'dance':
          await this.playDance();
          break;
        case 'scan':
          await this.playScan();
          break;
        case 'glitch':
          await this.playGlitch();
          break;
        case 'overdrive':
          await this.playOverdrive();
          break;
        default:
          break;
      }
    }

    async playPlasmaSurge() {
      const c = this.ctx;
      c.setFaceState('angry');
      c.viewport.classList.add('shake-heavy');
      c.core.style.transform = 'scale(2.5)';
      c.core.style.boxShadow = '0 0 40px #00d2fd';
      c.robot.style.transform = 'scale(1.8) translateY(-10px)';
      await sleep(1500);

      c.viewport.classList.remove('shake-heavy');
      const flash = document.createElement('div');
      flash.className = 'fixed inset-0 bg-white z-[300] opacity-0 transition-opacity duration-75 pointer-events-none';
      document.body.appendChild(flash);
      flash.style.opacity = '1';
      c.createShockwave();
      await sleep(100);
      flash.style.opacity = '0';
      setTimeout(() => flash.remove(), 200);

      c.setFaceState('sleep');
      c.robot.style.transform = 'scale(1.5) translateY(40px)';
      c.core.style.background = '#444';
      c.core.style.boxShadow = 'none';
      for (let i = 0; i < 15; i += 1) {
        c.spawnSmoke();
        await sleep(100);
      }
      await sleep(1000);
    }

    async playHeroLanding() {
      const c = this.ctx;
      c.setFaceState('surprised');
      c.robot.style.transform = 'scale(0.4) translateY(-1000px)';
      await sleep(600);

      c.robot.style.transition = 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
      c.robot.style.transform = 'scale(2) translateY(50px)';
      await sleep(400);

      c.createShockwave();
      c.viewport.classList.add('shake-heavy');
      setTimeout(() => c.viewport.classList.remove('shake-heavy'), 400);
      c.setFaceState('happy');
      await sleep(1000);
    }

    async playZeroG() {
      const c = this.ctx;
      c.setFaceState('surprised');
      c.robot.style.transform = 'scale(1.6) translateY(-150px)';
      c.head.style.animation = 'orbit-parts 4s infinite linear';
      c.body.style.animation = 'orbit-parts 4s infinite linear reverse';
      c.leftArm.style.animation = 'orbit-parts 4s infinite linear 0.5s';
      c.rightArm.style.animation = 'orbit-parts 4s infinite linear 0.8s';
      await sleep(4000);
      c.head.style.animation = 'none';
      c.body.style.animation = 'none';
      c.leftArm.style.animation = 'none';
      c.rightArm.style.animation = 'none';
      c.setFaceState('happy');
      c.robot.style.transform = 'scale(1.6) translateY(0)';
      await sleep(500);
    }

    async playDance() {
      const c = this.ctx;
      await c.enterDiscoMode();
      c.setFaceState('happy');
      c.robot.style.transition = 'transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)';
      c.leftArm.style.transition = 'transform 0.15s ease';
      c.rightArm.style.transition = 'transform 0.15s ease';
      c.head.style.transition = 'transform 0.2s ease';
      c.body.style.transition = 'transform 0.2s ease';
      c.core.style.transition = 'transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease';

      const palette = ['#ff3f80', '#ff9f1c', '#ffe45e', '#42ff87', '#4ee9ff', '#7b61ff', '#ff4de3'];
      for (let i = 0; i < 12; i += 1) {
        const tilt = i % 2 ? 18 : -18;
        const jump = i % 3 === 0 ? -145 : -95;
        const armUp = i % 2 ? -145 : -35;
        const armDown = i % 2 ? 35 : 145;
        const color = palette[i % palette.length];

        c.robot.style.transform = `scale(1.62) translateY(${jump}px) rotate(${tilt}deg)`;
        c.head.style.transform = `rotate(${tilt * 0.45}deg)`;
        c.body.style.transform = `rotate(${tilt * -0.25}deg)`;
        c.leftArm.style.transform = `rotate(${armUp}deg)`;
        c.rightArm.style.transform = `rotate(${armDown}deg)`;
        c.core.style.background = color;
        c.core.style.boxShadow = `0 0 34px ${color}`;
        c.core.style.transform = i % 2 ? 'scale(1.9)' : 'scale(1.2)';
        if (i % 4 === 0) c.createShockwave();
        await sleep(200);
      }

      c.robot.style.transform = 'scale(1.6) translateY(-20px)';
      c.leftArm.style.transform = 'rotate(-20deg)';
      c.rightArm.style.transform = 'rotate(20deg)';
      await sleep(260);
      await c.exitDiscoMode();
    }

    async playScan() {
      const c = this.ctx;
      c.setFaceState('surprised');
      c.head.style.transform = 'rotateY(180deg)';
      await sleep(500);
      c.head.style.transform = 'rotateY(0deg)';
      await sleep(500);
    }

    async playGlitch() {
      const c = this.ctx;
      for (let i = 0; i < 10; i += 1) {
        c.robot.style.opacity = Math.random() > 0.5 ? '0.2' : '1';
        c.robot.style.transform = `scale(1.6) translate(${Math.random() * 20 - 10}px, ${Math.random() * 20 - 10}px)`;
        await sleep(50);
      }
      c.robot.style.opacity = '1';
    }

    async playOverdrive() {
      const c = this.ctx;
      c.setFaceState('angry');
      c.core.style.background = '#ff0000';
      c.core.style.boxShadow = '0 0 30px #ff0000';
      c.robot.style.transform = 'scale(1.9)';
      await sleep(2000);
    }
  }

  global.OrderRobot = global.OrderRobot || {};
  global.OrderRobot.RobotActions = RobotActions;
})(window);
