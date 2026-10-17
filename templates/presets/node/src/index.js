// {{PROJECT_NAME}} — 源码入口(preset: node)
// 结构约定:源码只进 src/,测试只进 tests/,构建/工具脚本进 scripts/;
// 新顶层目录需修宪(.relay/manifest.json 白名单),详见 AGENTS.md。
export function main() {
  return '{{PROJECT_NAME}} ready';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(main());
}
