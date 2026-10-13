// 红绿灯几何（纯函数，main.js 与 tests/desktop-chrome.spec.js 共用）。
//
// 顶栏高 46px，红绿灯组垂直中心要落在 23px。组宽随系统版本变：
//   macOS 26（Darwin 25）起：三颗 14pt 灯、间距 9pt → 组宽 60pt（实测 x = 18–32 / 41–55 / 64–78）
//   更早：三颗 12pt 灯、间距 8pt → 组宽 52pt
// 侧栏头 / 收起时主顶栏的左内边距 = 灯组左缘 + 组宽 + 12pt 留白（原先按 52pt 估的 76px，
// 在 macOS 26 上和第三颗灯重叠 2pt，见 .agents/tasks/ui-starmap/client-fix/diagnosis.md §1）。
'use strict';

const HEADER_H = 46;
const LEFT = 18;
const GAP_AFTER = 12;

function darwinMajor(osRelease) {
  const m = /^(\d+)/.exec(String(osRelease || ''));
  return m ? parseInt(m[1], 10) : 0;
}

function trafficLightGeometry(platform, osRelease) {
  const modern = platform === 'darwin' && darwinMajor(osRelease) >= 25;
  const d = modern ? 14 : 12;            // 单颗直径
  const groupWidth = modern ? 60 : 52;
  const y = Math.round(HEADER_H / 2 - d / 2);
  return {
    position: { x: LEFT, y },
    diameter: d,
    groupWidth,
    inset: LEFT + groupWidth + GAP_AFTER,
  };
}

module.exports = { trafficLightGeometry, darwinMajor, HEADER_H };
