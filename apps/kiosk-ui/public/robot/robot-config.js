(function initRobotConfig(global) {
  'use strict';

  const SUPPORTED_ACTIONS = [
    'plasmaSurge',
    'heroLanding',
    'zeroG',
    'dance',
    'scan',
    'glitch',
    'overdrive',
    'waveHello',
    'nodYes',
    'bowElegant',
    'spinTwirl',
    'jumpJoy',
    'lightPulse',
    'laserSweep',
    'confettiBurst',
    'blowKissHearts',
    'winkPulse',
    'blushShy',
    'heartRain',
    'cheerSparkle',
    'noseScrunch',
    'smileBounce',
    'hugGesture',
    'clapHappy',
    'peacePose',
    'maidCurtseyBloom',
    'waiterServingSpin',
    'animeStarTrail',
    'pixelHeartStorm',
    'auroraOrbit',
  ];

  const SKIN_IDS = [
    'maid-classic', 'maid-sakura', 'maid-midnight', 'maid-royal', 'maid-pastel',
    'waiter-amber', 'waiter-cobalt', 'waiter-olive', 'waiter-charcoal', 'waiter-sunrise',
    'cute-cotton', 'cute-berry', 'cute-mintpop', 'cute-lemon', 'cute-cloud',
    'anime-luna', 'anime-starlight', 'anime-neonfox', 'anime-fantasyrose', 'anime-aurora',
  ];

  function defaultActionSettings() {
    return Object.fromEntries(
      SUPPORTED_ACTIONS.map((actionId) => [actionId, {
        enabled: true,
        intensity: 82,
        speed: 1,
        cooldownMs: 350,
      }]),
    );
  }

  function createDefaultRobotStudioConfig() {
    return {
      schema: 'robotStudio.v1',
      qualityProfile: 'cinema',
      expressiveMode: 'full',
      activeSkinId: SKIN_IDS[0],
      enabledSkinIds: [...SKIN_IDS],
      enabledActions: [...SUPPORTED_ACTIONS],
      triggerBindings: [],
      graphBindings: [],
      effectIntensity: 85,
      actionSettings: defaultActionSettings(),
      uploadedAssets: [],
      skinAssetBindings: {},
      avatarParts: {
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
      },
    };
  }

  global.OrderRobot = global.OrderRobot || {};
  global.OrderRobot.config = {
    version: '3.0.0',
    schemaVersion: 'robotStudio.v1',
    storageKeys: {
      scalePercent: 'admin.robot.scalePercent',
      skinId: 'admin.robot.skinId',
      studioConfig: 'admin.robot.studio.v1',
      cameraPreviewVisible: 'admin.camera.previewVisible',
    },
    defaultScalePercent: 100,
    minScalePercent: 60,
    maxScalePercent: 170,
    defaultSkinId: 'maid-classic',
    supportedActions: SUPPORTED_ACTIONS,
    defaultRobotStudioConfig: createDefaultRobotStudioConfig(),
  };

  global.OrderRobot.createDefaultRobotStudioConfig = createDefaultRobotStudioConfig;
})(window);

