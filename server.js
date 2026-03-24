// ===================================================
// 玄机 · 后端服务 (部署到 Render)
// 作用：接收面板请求 → SSH到目标VPS执行命令 → 返回结果
// ===================================================

const express = require('express');
const cors = require('cors');
const { Client } = require('ssh2');

const app = express();
const PORT = process.env.PORT || 3377;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'change-me-to-a-strong-token';

// ===== Middleware =====
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Auth middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ ok: false, error: '认证失败' });
  }
  next();
}

// ===== SSH Connection Pool =====
// Simple connection cache (per host)
const connections = new Map();

function getConnKey(config) {
  return `${config.user}@${config.host}:${config.port}`;
}

async function getSSH(config) {
  const key = getConnKey(config);
  const existing = connections.get(key);
  
  // Reuse if still connected
  if (existing && existing.conn && existing.connected) {
    return existing.conn;
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error('SSH连接超时'));
    }, 15000);

    conn.on('ready', () => {
      clearTimeout(timeout);
      connections.set(key, { conn, connected: true, config });
      resolve(conn);
    });

    conn.on('error', (err) => {
      clearTimeout(timeout);
      connections.delete(key);
      reject(new Error('SSH连接失败: ' + err.message));
    });

    conn.on('close', () => {
      connections.delete(key);
    });

    const sshConfig = {
      host: config.host,
      port: config.port || 22,
      username: config.user || 'root',
      readyTimeout: 15000,
      keepaliveInterval: 30000,
    };

    if (config.auth === 'key' && config.privateKey) {
      sshConfig.privateKey = config.privateKey;
    } else if (config.password) {
      sshConfig.password = config.password;
    }

    conn.connect(sshConfig);
  });
}

// Execute command via SSH
function sshExec(conn, cmd, cwd) {
  return new Promise((resolve, reject) => {
    const fullCmd = cwd ? `cd ${cwd} && ${cmd}` : cmd;
    
    conn.exec(fullCmd, { pty: false }, (err, stream) => {
      if (err) return reject(err);

      let stdout = '';
      let stderr = '';

      stream.on('data', (data) => { stdout += data.toString(); });
      stream.stderr.on('data', (data) => { stderr += data.toString(); });

      stream.on('close', (code) => {
        resolve({
          output: stdout.trim(),
          error: stderr.trim(),
          code: code || 0,
        });
      });

      // Timeout for long commands
      setTimeout(() => {
        stream.close();
        resolve({ output: stdout.trim(), error: stderr.trim() + '\n[命令超时]', code: -1 });
      }, 60000);
    });
  });
}

// ===== Routes =====

// Health check
app.get('/', (req, res) => {
  res.json({ service: '玄机后端', status: 'running', version: '1.0.0' });
});

// Connect to server (test connection)
app.post('/api/connect', auth, async (req, res) => {
  try {
    const { host, port, user, auth: authType, password, privateKey } = req.body;
    
    if (!host) return res.json({ ok: false, error: '缺少主机地址' });

    const conn = await getSSH({
      host, port: port || 22, user: user || 'root',
      auth: authType || 'password', password, privateKey
    });

    // Test with a simple command
    const result = await sshExec(conn, 'echo ok');
    
    res.json({ ok: true, message: '连接成功' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Execute command
app.post('/api/exec', auth, async (req, res) => {
  try {
    const { cmd, cwd } = req.body;
    const conn = getActiveConn();
    if (!conn) return res.json({ ok: false, error: '无活动连接' });

    const result = await sshExec(conn, cmd, cwd);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// System status
app.post('/api/status', auth, async (req, res) => {
  try {
    const conn = getActiveConn();
    if (!conn) return res.json({ ok: false, error: '无活动连接' });

    // Gather system info in one SSH call
    const script = `
echo "===CPU==="
top -bn1 | grep "Cpu(s)" | awk '{print 100 - $8}'
echo "===MEM==="
free | awk '/Mem:/{printf "%.0f\\n%.0f\\n%.0f", $3/$2*100, $3/1024, $2/1024}'
echo "===DISK==="
df / | awk 'NR==2{print $5}' | tr -d '%'
echo "===DISK_DETAIL==="
df -h / | awk 'NR==2{print $2, $3}'
echo "===NET==="
cat /proc/net/dev | awk '/eth0|ens|enp/{print $2, $10}' | head -1
echo "===OS==="
cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'"' -f2
echo "===KERNEL==="
uname -r
echo "===UPTIME==="
uptime -p 2>/dev/null || uptime
echo "===LOAD==="
cat /proc/loadavg | awk '{print $1, $2, $3}'
echo "===IP==="
hostname -I 2>/dev/null | awk '{print $1}'
`;
    
    const result = await sshExec(conn, script);
    const output = result.output;
    
    const get = (key) => {
      const regex = new RegExp(`===${key}===\\n([\\s\\S]*?)(?:===|$)`);
      const m = output.match(regex);
      return m ? m[1].trim() : '';
    };

    const memLines = get('MEM').split('\n');
    const diskDetail = get('DISK_DETAIL').split(' ');
    
    res.json({
      ok: true,
      cpu: Math.round(parseFloat(get('CPU')) || 0),
      mem: Math.round(parseFloat(memLines[0]) || 0),
      memUsed: Math.round(parseFloat(memLines[1]) || 0) + ' MB',
      memTotal: Math.round(parseFloat(memLines[2]) || 0) + ' MB',
      disk: parseInt(get('DISK')) || 0,
      diskUsed: diskDetail[1] || '--',
      diskTotal: diskDetail[0] || '--',
      netUp: '-- KB/s',
      netDown: '-- KB/s',
      os: get('OS') || 'Linux',
      kernel: get('KERNEL'),
      uptime: get('UPTIME'),
      load: get('LOAD'),
      ip: get('IP'),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// File listing
app.post('/api/files', auth, async (req, res) => {
  try {
    const { path: dirPath } = req.body;
    const conn = getActiveConn();
    if (!conn) return res.json({ ok: false, error: '无活动连接' });

    const safePath = (dirPath || '/').replace(/'/g, "\\'");
    const cmd = `ls -la --time-style='+%Y-%m-%d %H:%M' '${safePath}' 2>/dev/null | tail -n +2`;
    const result = await sshExec(conn, cmd);

    const files = result.output.split('\n').filter(Boolean).map(line => {
      const parts = line.split(/\s+/);
      if (parts.length < 7) return null;
      const type = line.startsWith('d') ? 'dir' : (line.startsWith('l') ? 'link' : 'file');
      const size = type === 'dir' ? '-' : formatSize(parseInt(parts[4]) || 0);
      const modified = parts[5] + ' ' + parts[6];
      const name = parts.slice(7).join(' ');
      if (name === '.') return null;
      return { name, type, size, modified };
    }).filter(Boolean);

    res.json({ ok: true, files });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Process list
app.post('/api/processes', auth, async (req, res) => {
  try {
    const conn = getActiveConn();
    if (!conn) return res.json({ ok: false, error: '无活动连接' });

    const cmd = `ps aux --sort=-%cpu | head -20 | awk 'NR>1{print $2"|"$3"|"$4"|"$11}'`;
    const result = await sshExec(conn, cmd);

    const processes = result.output.split('\n').filter(Boolean).map(line => {
      const [pid, cpu, mem, ...nameParts] = line.split('|');
      return {
        pid: parseInt(pid),
        cpu: cpu + '%',
        mem: mem + '%',
        name: nameParts.join('|') || 'unknown',
      };
    });

    res.json({ ok: true, processes });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Docker containers
app.post('/api/docker', auth, async (req, res) => {
  try {
    const conn = getActiveConn();
    if (!conn) return res.json({ ok: false, error: '无活动连接' });

    const cmd = `docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>/dev/null`;
    const result = await sshExec(conn, cmd);

    if (!result.output) {
      return res.json({ ok: true, containers: [] });
    }

    const containers = result.output.split('\n').filter(Boolean).map(line => {
      const [id, name, image, ...rest] = line.split('|');
      const statusAndPorts = rest.join('|');
      const isRunning = statusAndPorts.toLowerCase().includes('up');
      return {
        id: id?.slice(0, 12),
        name,
        image,
        status: isRunning ? 'running' : 'stopped',
        ports: rest[rest.length - 1] || '-',
        uptime: rest[0] || '',
      };
    });

    res.json({ ok: true, containers });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== Helpers =====
function getActiveConn() {
  // Return the most recently connected SSH session
  const entries = [...connections.values()];
  const active = entries.find(e => e.connected);
  return active?.conn || null;
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

// ===== Start =====
app.listen(PORT, () => {
  console.log(`玄机后端运行中 → 端口 ${PORT}`);
  console.log(`TOKEN: ${AUTH_TOKEN.slice(0, 4)}****`);
});
