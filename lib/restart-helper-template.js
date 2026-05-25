// Atlas 升级流程的 detached helper：等老 server 退出后启动新 atlas binary
// 这个脚本被 server 在升级时复制到 ~/.atlas/restart-helper-{ts}.js 然后 spawn
// 它必须独立——不能 require atlas-dashboard 包里的任何东西，因为升级时这些文件正被替换

const { spawn } = require('child_process');
const fs = require('fs');

const oldPid = parseInt(process.argv[2], 10);
const atlasBin = process.argv[3];
const logFile = process.argv[4];

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

(async () => {
  // 等老 server pid 死，最多 5s
  const t0 = Date.now();
  while (isAlive(oldPid) && Date.now() - t0 < 5000) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (isAlive(oldPid)) {
    try { process.kill(oldPid, 'SIGKILL'); } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  // 启动新 atlas
  let out = 1;
  try { out = fs.openSync(logFile, 'a'); } catch {}
  const child = spawn(process.execPath, [atlasBin, 'start'], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();

  // 自我清理：让自己被 detach 后留 1.5s 再 exit
  setTimeout(() => process.exit(0), 1500);
})().catch(() => process.exit(1));
