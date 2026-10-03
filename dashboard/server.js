// Speedrun dashboard.
//
// Listens on one port (25560) and looks at the first bytes of every
// connection: web browsers get the dashboard, Minecraft clients get passed
// straight through to the real server. Data comes from RCON plus the
// server's log and usercache files.

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 25560;
const WEB_PORT = 8080; // internal only
const MC_HOST = process.env.MC_HOST || 'minecraft';
const MC_PORT = 25565;
const MC_VERSION = process.env.MC_VERSION || '';
const DATA = '/data';
const STATE_FILE = '/state/runs.json';
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

// ---------- one port, two jobs ----------

const HTTP_METHODS = ['GET ', 'POST', 'HEAD', 'PUT ', 'DELE', 'OPTI', 'PATC'];

net.createServer(client => {
  client.on('error', () => {});
  client.once('data', first => {
    const isHttp = HTTP_METHODS.includes(first.subarray(0, 4).toString('latin1'));
    const up = isHttp ? net.connect(WEB_PORT, '127.0.0.1') : net.connect(MC_PORT, MC_HOST);
    const close = () => { client.destroy(); up.destroy(); };
    up.on('error', close);
    up.on('close', close);
    client.on('close', close);
    up.write(first);
    client.pipe(up).pipe(client);
  });
}).listen(PORT, () => console.log(`Listening on ${PORT} (Minecraft + dashboard)`));

// ---------- RCON ----------

function readProps() {
  try {
    const props = {};
    for (const line of fs.readFileSync(path.join(DATA, 'server.properties'), 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && !line.startsWith('#')) props[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return props;
  } catch {
    return {};
  }
}

class Rcon {
  constructor() {
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.nextId = 10;
    this.current = null;
    this.chain = Promise.resolve();
    this.onConnect = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const props = readProps();
      const password = props['rcon.password'];
      if (!password) return reject(new Error('no rcon password yet'));
      const sock = net.connect(Number(props['rcon.port'] || 25575), MC_HOST);
      let authed = false;
      this.buf = Buffer.alloc(0);
      this.onAuth = id => {
        if (id === -1) { sock.destroy(); reject(new Error('bad rcon password')); return; }
        authed = true;
        resolve();
      };
      sock.on('connect', () => { this.sock = sock; this.send(1, 3, password); });
      sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
      sock.on('error', () => {});
      sock.on('close', () => {
        if (this.sock === sock) this.sock = null;
        this.fail(new Error('rcon closed'));
        if (!authed) reject(new Error('rcon closed'));
      });
    });
  }

  send(id, type, body) {
    const b = Buffer.from(body, 'utf8');
    const p = Buffer.alloc(14 + b.length);
    p.writeInt32LE(10 + b.length, 0);
    p.writeInt32LE(id, 4);
    p.writeInt32LE(type, 8);
    b.copy(p, 12);
    this.sock.write(p);
  }

  parse() {
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32LE(0);
      if (this.buf.length < 4 + len) return;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      const body = this.buf.toString('utf8', 12, 4 + len - 2);
      this.buf = this.buf.subarray(4 + len);
      this.packet(id, type, body);
    }
  }

  packet(id, type, body) {
    if (this.onAuth && type === 2) {
      const f = this.onAuth;
      this.onAuth = null;
      f(id);
      return;
    }
    const cur = this.current;
    if (!cur) return;
    // Long replies come in several packets. A second, empty command is sent
    // right after each real one; its reply marks the end of the real one.
    if (id === cur.id) cur.parts.push(body);
    else if (id === cur.marker) { this.current = null; clearTimeout(cur.timer); cur.resolve(cur.parts.join('')); }
  }

  fail(err) {
    if (this.current) { clearTimeout(this.current.timer); this.current.reject(err); this.current = null; }
  }

  cmd(command) {
    const run = async () => {
      if (!this.sock) {
        await this.connect();
        if (this.onConnect) await this.onConnect(c => this.raw(c));
      }
      return this.raw(command);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  // Sends one command right now. Only call this from inside cmd()'s queue.
  raw(command) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const marker = this.nextId++;
      if (this.nextId > 2e9) this.nextId = 10;
      const timer = setTimeout(() => {
        if (this.current && this.current.id === id) { this.current = null; reject(new Error('rcon timeout')); this.sock?.destroy(); }
      }, 5000);
      this.current = { id, marker, parts: [], resolve, reject, timer };
      this.send(id, 2, command);
      this.send(marker, 2, '');
    });
  }
}

const rcon = new Rcon();
rcon.onConnect = async raw => {
  const add = (name, criteria) => raw(`scoreboard objectives add ${name} ${criteria}`);
  await add('sr_time', 'minecraft.custom:minecraft.play_time');
  await add('sr_dragon', 'minecraft.killed:minecraft.ender_dragon');
  await add('sr_blaze', 'minecraft.picked_up:minecraft.blaze_rod');
};

// ---------- reading what the server says ----------

async function entityData(name, field) {
  const r = await rcon.cmd(`data get entity ${name} ${field}`);
  const i = r.indexOf('entity data: ');
  return i < 0 ? null : r.slice(i + 13).trim();
}

async function score(name, objective) {
  const r = await rcon.cmd(`scoreboard players get ${name} ${objective}`);
  const m = r.match(/has (-?\d+) \[/);
  return m ? Number(m[1]) : 0;
}

// Text at the top level of a compound, with nested {...} and [...] and
// quoted strings removed, so an item's own id/count aren't confused with
// ids inside its components.
function topLevel(s) {
  let out = '', depth = 0, quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) { quote = null; if (depth === 0) out += c; } else if (depth === 0) out += c; continue; }
    if (c === '"' || c === "'") { quote = c; if (depth === 0) out += c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (depth === 0) out += c;
  }
  return out;
}

function parseItems(snbt) {
  const items = [];
  if (!snbt) return items;
  let depth = 0, start = -1, quote = null;
  for (let i = 0; i < snbt.length; i++) {
    const c = snbt[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{' || c === '[') { depth++; if (c === '{' && depth === 2) start = i; }
    else if (c === '}' || c === ']') {
      if (c === '}' && depth === 2 && start >= 0) {
        const flat = topLevel(snbt.slice(start + 1, i));
        const id = flat.match(/\bid:\s*"(?:minecraft:)?([^"]+)"/);
        const count = flat.match(/\b[Cc]ount:\s*(\d+)/);
        const slot = flat.match(/\bSlot:\s*(-?\d+)b/);
        if (id) items.push({ id: id[1], count: count ? Number(count[1]) : 1, slot: slot ? Number(slot[1]) : -1 });
        start = -1;
      }
      depth--;
    }
  }
  return items;
}

function has(p, id) { return p.items.some(i => i.id === id); }

const SPLITS = [
  { key: 'wood', label: 'Punched a tree', test: p => p.items.some(i => /_(log|stem)$/.test(i.id)) },
  { key: 'iron', label: 'Got iron', test: p => has(p, 'iron_ingot') },
  { key: 'nether', label: 'Went to the Nether', test: p => p.dim === 'the_nether' },
  { key: 'blaze', label: 'Got a blaze rod', test: p => p.blazePicked > 0 || has(p, 'blaze_rod') },
  { key: 'pearl', label: 'Got ender pearls', test: p => has(p, 'ender_pearl') },
  { key: 'eye', label: 'Made eyes of ender', test: p => has(p, 'ender_eye') },
  { key: 'end', label: 'Went to the End', test: p => p.dim === 'the_end' },
  { key: 'dragon', label: 'Killed the dragon!', test: p => p.dragonKills > 0 },
];

let runs = {};
try { runs = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
function saveRuns() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(runs, null, 2)); } catch (e) { console.error('save failed', e.message); }
}

function knownNames() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'usercache.json'), 'utf8')).map(u => u.name); } catch { return []; }
}

function readEvents() {
  let text;
  try {
    const file = path.join(DATA, 'logs', 'latest.log');
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 128 * 1024);
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, size - len);
    fs.closeSync(fd);
    text = b.toString('utf8');
  } catch {
    return [];
  }
  const names = knownNames();
  const events = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\[(\d\d:\d\d:\d\d)\] \[Server thread\/INFO\]: (.*)$/);
    if (!m) continue;
    const msg = m[2].replace(/^\[Not Secure\] /, '');
    let kind = null;
    if (/^<[A-Za-z0-9_]{1,16}> /.test(msg)) kind = 'chat';
    else if (/ joined the game$/.test(msg)) kind = 'join';
    else if (/ left the game$/.test(msg)) kind = 'leave';
    else if (/ has (made the advancement|reached the goal|completed the challenge) /.test(msg)) kind = 'adv';
    else if (/^Done \(/.test(msg)) kind = 'server';
    else if (names.some(n => msg.startsWith(n + ' ')) && !/ lost connection/.test(msg)) kind = 'death';
    if (kind) events.push({ time: m[1], kind, text: kind === 'server' ? 'Server started' : msg });
  }
  return events.slice(-30).reverse();
}

// ---------- the polling loop ----------

let state = { online: false, players: [], events: [] };
let seed = null;

async function poll() {
  const next = { online: false, version: MC_VERSION, splitDefs: SPLITS.map(({ key, label }) => ({ key, label })) };
  try {
    const list = await rcon.cmd('list');
    const lm = list.match(/There are (\d+) of a max of (\d+) players online:(.*)/s);
    next.online = true;
    next.max = lm ? Number(lm[2]) : null;
    const names = lm ? lm[3].split(',').map(s => s.trim()).filter(n => NAME_RE.test(n)) : [];

    if (seed === null) { const s = (await rcon.cmd('seed')).match(/\[(-?\d+)\]/); if (s) seed = s[1]; }
    next.seed = seed;
    // 1.21 says "The time is N" (a day count for `day`, ticks into the day
    // for `daytime`). 26.x has timelines instead: "Timeline minecraft:day is
    // at N tick(s)", where N counts ticks through all the days so far.
    const dayReply = await rcon.cmd('time query day');
    const timeline = dayReply.match(/is at (\d+) tick/);
    if (timeline) {
      const ticks = Number(timeline[1]);
      next.day = Math.floor(ticks / 24000) + 1;
      next.daytime = ticks % 24000;
    } else {
      next.day = Number((dayReply.match(/(\d+)/) || [])[1] ?? 0);
      next.daytime = Number(((await rcon.cmd('time query daytime')).match(/(\d+)/) || [])[1] ?? 0);
    }
    next.difficulty = ((await rcon.cmd('difficulty')).match(/difficulty is (\w+)/) || [])[1] || '';
    const mobs = (await rcon.cmd('execute if entity @e[type=!player]')).match(/count: (\d+)/);
    next.mobs = mobs ? Number(mobs[1]) : 0;

    let changed = false;
    next.players = [];
    for (const name of names) {
      const pos = (await entityData(name, 'Pos') || '').replace(/[\[\]d]/g, '').split(',').map(parseFloat);
      const p = {
        name,
        health: parseFloat(await entityData(name, 'Health')) || 0,
        food: parseInt(await entityData(name, 'foodLevel')) || 0,
        xp: parseInt(await entityData(name, 'XpLevel')) || 0,
        pos: pos.length === 3 ? pos.map(Math.floor) : [0, 0, 0],
        dim: (await entityData(name, 'Dimension') || '').replace(/"/g, '').replace(/^minecraft:/, ''),
        items: parseItems(await entityData(name, 'Inventory')),
        timerTicks: await score(name, 'sr_time'),
        dragonKills: await score(name, 'sr_dragon'),
        blazePicked: await score(name, 'sr_blaze'),
      };
      const run = runs[name] ||= { splits: {}, finalTicks: null };
      for (const s of SPLITS) {
        if (run.splits[s.key] == null && s.test(p)) { run.splits[s.key] = p.timerTicks; changed = true; }
      }
      if (run.splits.dragon != null && run.finalTicks == null) { run.finalTicks = run.splits.dragon; changed = true; }
      p.splits = run.splits;
      p.finished = run.finalTicks != null;
      if (p.finished) p.timerTicks = run.finalTicks;
      next.players.push(p);
    }
    if (changed) saveRuns();
  } catch (e) {
    next.online = false;
    next.error = e.message;
  }
  next.events = readEvents();
  next.serverTime = Date.now();
  state = next;
}

(async function loop() {
  const start = Date.now();
  await poll();
  setTimeout(loop, Math.max(200, 1000 - (Date.now() - start)));
})();

// ---------- the web page ----------

const page = path.join(__dirname, 'index.html');

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(state));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    const name = url.searchParams.get('player') || '';
    if (!NAME_RE.test(name)) { res.writeHead(400); res.end('bad name'); return; }
    try {
      for (const obj of ['sr_time', 'sr_dragon', 'sr_blaze']) await rcon.cmd(`scoreboard players set ${name} ${obj} 0`);
      runs[name] = { splits: {}, finalTicks: null };
      saveRuns();
      res.writeHead(200); res.end('ok');
    } catch (e) {
      res.writeHead(503); res.end(e.message);
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/icon.png') {
    const icon = path.join(DATA, 'server-icon.png');
    if (!fs.existsSync(icon)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'image/png' });
    fs.createReadStream(icon).pipe(res);
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(page).pipe(res);
    return;
  }
  res.writeHead(404); res.end('not found');
}).listen(WEB_PORT, '127.0.0.1');
