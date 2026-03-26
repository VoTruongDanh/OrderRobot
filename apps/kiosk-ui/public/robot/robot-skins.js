(function initRobotSkins(global) {
  'use strict';

  global.OrderRobot = global.OrderRobot || {};

  const SKINS = {
    classic: {
      '--robot-core-color': '#00d2fd',
      '--robot-core-glow': 'rgba(0,210,253,0.5)',
    },
    mint: {
      '--robot-core-color': '#34d399',
      '--robot-core-glow': 'rgba(52,211,153,0.55)',
    },
    sunset: {
      '--robot-core-color': '#f97316',
      '--robot-core-glow': 'rgba(249,115,22,0.5)',
    },
  };

  function applySkin(skinId) {
    const nextId = SKINS[skinId] ? skinId : 'classic';
    const vars = SKINS[nextId];
    Object.entries(vars).forEach(([key, value]) => {
      document.documentElement.style.setProperty(key, value);
    });
    return nextId;
  }

  function listSkins() {
    return Object.keys(SKINS);
  }

  global.OrderRobot.skins = {
    applySkin,
    listSkins,
    getSkinMap: () => ({ ...SKINS }),
  };
})(window);
