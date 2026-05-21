// 首次启动交互引导：写入 ~/.atlas/config.json
// 用 prompts 库，单文件 13KB，零额外依赖

const fs = require('fs');
const path = require('path');
const os = require('os');
const prompts = require('prompts');
const { configPath, ensureConfigDir, expand } = require('./paths');

const DEFAULT_IGNORE = [
  'node_modules', '.git', '.venv', 'venv', '__pycache__',
  'dist', 'build', '.next', '.cache', '.nuxt', 'out', 'target',
];

function defaultRoot() {
  return path.join(os.homedir(), 'Documents');
}

function parseRootList(input) {
  if (!input) return [];
  return input.split(',').map(s => s.trim()).filter(Boolean).map(expand);
}

async function runInit({ existingConfig = null, force = false } = {}) {
  console.log('');
  console.log(force
    ? '🔧 重新配置 Atlas'
    : '👋 欢迎使用 Atlas — 一次性配置后即可使用');
  console.log('');

  const initialRoots = existingConfig && existingConfig.scanRoots && existingConfig.scanRoots.length
    ? existingConfig.scanRoots.join(', ')
    : defaultRoot();
  const initialPort = existingConfig && existingConfig.port ? String(existingConfig.port) : '4321';
  const initialIgnore = (existingConfig && existingConfig.ignore && existingConfig.ignore.length
    ? existingConfig.ignore
    : DEFAULT_IGNORE).join(',');

  const responses = await prompts([
    {
      type: 'text',
      name: 'roots',
      message: '要扫描哪些目录的 HTML 文件？(多个用逗号分隔，支持 ~)',
      initial: initialRoots,
      validate(input) {
        const list = parseRootList(input);
        if (list.length === 0) return '至少给一个目录';
        for (const p of list) {
          if (!fs.existsSync(p)) return `路径不存在：${p}`;
          if (!fs.statSync(p).isDirectory()) return `不是目录：${p}`;
        }
        return true;
      },
    },
    {
      type: 'number',
      name: 'port',
      message: '监听端口？',
      initial: parseInt(initialPort, 10),
      min: 1024,
      max: 65535,
    },
    {
      type: 'text',
      name: 'ignore',
      message: '要忽略的目录名？(逗号分隔)',
      initial: initialIgnore,
    },
    {
      type: 'number',
      name: 'maxDepth',
      message: '扫描最大深度？',
      initial: existingConfig && existingConfig.maxDepth ? existingConfig.maxDepth : 6,
      min: 1,
      max: 20,
    },
  ], {
    onCancel() {
      console.log('\n已取消。');
      process.exit(0);
    },
  });

  const config = {
    scanRoots: parseRootList(responses.roots),
    ignore: responses.ignore.split(',').map(s => s.trim()).filter(Boolean),
    port: responses.port,
    maxDepth: responses.maxDepth,
  };

  ensureConfigDir();
  const cp = configPath();
  fs.writeFileSync(cp, JSON.stringify(config, null, 2), 'utf8');

  console.log('');
  console.log(`✓ 已写入 ${cp}`);
  console.log(`✓ 将扫描 ${config.scanRoots.length} 个目录：`);
  config.scanRoots.forEach(r => console.log(`  · ${r}`));
  console.log('');

  return config;
}

module.exports = { runInit, DEFAULT_IGNORE };
