'use strict';

/**
 * 首次开场：把「用户第一次点召唤时该看到什么」变成可从命令行复现的一句话。
 *
 * 为什么单独做成脚本：
 *   开场白是专家最容易写飘的地方——新人一进来就抛文件路径、命令、七个平台，
 *   或者没初始化就直接算"我现在该干什么"。把开场白固定在脚本里，
 *   任何人（包括回归测试）都能看到当前状态下**实际会输出什么**，不用靠印象。
 *
 * 三种状态对应三种开场（口径见 GOLDEN-PATH.md 与 agents 说明）：
 *   uninitialized → 两句话讲清价值 + 明确"第一次要初始化" + 只给一个下一步
 *   partial       → 直接说上次差什么，只给一条恢复路径
 *   completed     → 不再介绍功能，直接引导问「我现在该干什么」
 *
 * 用法：
 *   node intro.js
 *   node intro.js --json      # 机器可读，便于验收脚本断言
 *
 * 输出（逐行 KEY:VALUE）：
 *   INTRO_STATE / INTRO_NEXT / INTRO_BLOCK_NOW / INTRO_MISSING / INTRO_TEXT
 */

const { displayPath, configPath, readSetupState } = require('./huayuan-paths');
const { readPreferences } = require('./preferences');

const HAS_ARG = (name) => process.argv.includes(name);

// 固定开场：与 README「专家介绍」、GOLDEN-PATH 第 1 步同一口径，改这里就要同步改那两处
const CAPABILITY =
  '我是华园日程管家，可以把你分散在教务、eCourse、雨课堂和校园门户里的课表、作业与通知，整理成有优先级、有理由、可调整的每日和本周计划。';
const FIRST_TIME_TAIL =
  '第一次使用时，我会先带你完成平台授权、作息偏好、课表读取和当前教学周确认；完成后，你只要问「我现在该干什么」，我就会告诉你下一步。现在开始初始化吗？';

function missingList(setup) {
  return [...(setup.missing || []), ...(setup.partial || [])].filter(Boolean).slice(0, 4);
}

function buildIntro() {
  const setup = readSetupState();
  const state = setup.state;
  const missing = missingList(setup);
  const college = readPreferences().preferences?.college || null;

  if (state === 'completed') {
    const collegeTail = college ? '' : '还差一项：请告诉我你所在的学院/书院，活动推送才能包含本学院内容。';
    return {
      state,
      next: 'ask_now',
      block_now: false,
      missing,
      college,
      text: `${CAPABILITY}你的课表和任务已经整理好了：直接问我「我现在该干什么」，我会给出唯一的第一动作和接下来的安排；要临时加课、加任务或加一段休息，也直接说。${collegeTail}`,
    };
  }

  if (state === 'partial') {
    const detail = missing.length ? `上次还差：${missing.join('；')}。` : '上次初始化没走完，关键来源还没读全。';
    return {
      state,
      next: 'resume_setup',
      block_now: true,
      missing,
      college,
      text: `${CAPABILITY}${detail}补上这一步，我才能把课表和待办对齐；在那之前算出来的「现在该干什么」只是估算。现在补齐吗？`,
    };
  }

  return {
    state: 'uninitialized',
    next: 'start_setup',
    block_now: true,
    missing,
    college,
    text: `${CAPABILITY}${FIRST_TIME_TAIL}`,
  };
}

function main() {
  const intro = buildIntro();
  if (HAS_ARG('--json')) {
    console.log(JSON.stringify({ ...intro, config: displayPath(configPath()) }, null, 2));
    return;
  }
  console.log(`INTRO_STATE:${intro.state}`);
  console.log(`INTRO_NEXT:${intro.next}`);
  console.log(`INTRO_BLOCK_NOW:${intro.block_now ? 1 : 0}`);
  if (intro.missing.length) console.log(`INTRO_MISSING:${intro.missing.join('；')}`);
  console.log(`INTRO_COLLEGE:${intro.college || 'missing'}`);
  console.log('INTRO_TEXT:');
  console.log(intro.text);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`INTRO_FAILED:${String(error.message || error).split('\n')[0]}`);
    process.exit(1);
  }
}

module.exports = { buildIntro, CAPABILITY, FIRST_TIME_TAIL };
