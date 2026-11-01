#!/usr/bin/env node
// 发布护栏(P2-19):package.json 移除 private:true 后,npm 不再机器级拒绝 publish。
// 本脚本作为 prepublishOnly 钩子:没有显式人工批准(RELAY_ALLOW_PUBLISH=1)就拒绝发布。
// 护栏是可被环境变量绕过的(发布者本来就有发布权),但它把"误按回车"变成"必须显式声明"。
const allowed = process.env.RELAY_ALLOW_PUBLISH === '1';
if (!allowed) {
  console.error('relay 发布护栏:已阻断 npm publish。');
  console.error('- 本仓库默认不允许自动发布;确认要发布时,显式执行:');
  console.error('    RELAY_ALLOW_PUBLISH=1 npm publish --provenance');
  console.error('- 发布前请先跑 npm test(含 smoke-pack 的打包面断言)。');
  process.exit(1);
}
console.error('relay 发布护栏:检测到 RELAY_ALLOW_PUBLISH=1,允许本次发布。');
