(function initRobotConfig(global) {
  'use strict';

  global.OrderRobot = global.OrderRobot || {};
  global.OrderRobot.config = {
    version: '2.0.0',
    storageKeys: {
      scalePercent: 'admin.robot.scalePercent',
      skinId: 'admin.robot.skinId',
    },
    defaultScalePercent: 100,
    minScalePercent: 60,
    maxScalePercent: 170,
    defaultSkinId: 'classic',
    supportedActions: [
      'plasmaSurge',
      'heroLanding',
      'zeroG',
      'dance',
      'scan',
      'glitch',
      'overdrive',
    ],
  };
})(window);
