'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'finalstage';
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

const devices = new Map();
const panels = new Set();
const pushes = new Map();

function panelOk(req) {
  const k = req.query.key || req.headers['x-key'];
  return typeof k === 'string' && k.length > 0 && k === ADMIN_KEY;
}

function deviceList() {
  const out = [];
  for (const d of devices.values()) {
    out.push({ id: d.id, name: d.name, online: d.ws.readyState === 1 });
  }
  return out;
}

function toPanels(msg) {
  const s = JSON.stringify(msg);
  for (const p of panels) {
    if (p.ws.readyState === 1) p.ws.send(s);
  }
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 300 * 1024 * 1024 }
});

app.post('/push', upload.single('file'), (req, res) => {
  if (!panelOk(req)) return res.status(401).json({ error: 'bad key' });
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const id = crypto.randomBytes(8).toString('hex');
  const type = req.body.type === 'video' ? 'video' : 'image';
  const duration = parseInt(req.body.duration, 10) || 0;
  pushes.set(id, { file: req.file.path, mime: req.file.mimetype });

  const url = '/media/' + id;
  const msg = { t: 'show', url: url, type: type, duration: duration };
  const target = req.body.deviceId;

  if (target && devices.has(target)) {
    const d = devices.get(target);
    if (d.ws.readyState === 1) d.ws.send(JSON.stringify(msg));
  } else {
    for (const d of devices.values()) {
      if (d.ws.readyState === 1) d.ws.send(JSON.stringify(msg));
    }
  }

  res.json({ ok: true, url: url });
});

app.get('/media/:id', (req, res) => {
  const p = pushes.get(req.params.id);
  if (!p) return res.status(404).send('not found');
  res.type(p.mime);
  fs.createReadStream(p.file).pipe(res);
});

app.get('/apk', (req, res) => {
  const f = path.join(PUBLIC_DIR, 'FinalStage.apk');
  if (!fs.existsSync(f)) {
    return res.status(404).send('Положите APK в server/public/FinalStage.apk');
  }
  res.download(f, 'FinalStage.apk');
});

app.get('/devices', (req, res) => {
  if (!panelOk(req)) return res.status(401).json({ error: 'bad key' });
  res.json(deviceList());
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch (e) {
    socket.destroy();
    return;
  }
  if (u.searchParams.get('key') !== ADMIN_KEY) {
    socket.destroy();
    return;
  }
  if (u.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => onDevice(ws, u));
  } else if (u.pathname === '/panel') {
    wss.handleUpgrade(req, socket, head, (ws) => onPanel(ws));
  } else {
    socket.destroy();
  }
});

function onDevice(ws, u) {
  const id = (u.searchParams.get('id') || crypto.randomBytes(4).toString('hex')).slice(0, 32);
  const name = (u.searchParams.get('name') || 'device').slice(0, 48);
  const rec = { id: id, name: name, ws: ws, frame: null };

  devices.set(id, rec);
  ws.send(JSON.stringify({ t: 'hello', id: id }));
  toPanels({ t: 'devices', list: deviceList() });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      rec.frame = data;
      for (const p of panels) {
        if (p.sel === id && p.ws.readyState === 1) p.ws.send(data, { binary: true });
      }
      return;
    }
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    if (m.t === 'info') {
      rec.name = (m.name || rec.name).slice(0, 48);
      toPanels({ t: 'devices', list: deviceList() });
    }
  });

  ws.on('close', () => {
    if (devices.get(id) === rec) devices.delete(id);
    toPanels({ t: 'devices', list: deviceList() });
  });

  ws.on('error', () => {});
}

function onPanel(ws) {
  const p = { ws: ws, sel: null };
  panels.add(ws);
  ws.send(JSON.stringify({ t: 'devices', list: deviceList() }));

  ws.on('message', (data) => {
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    if (m.t === 'select') {
      p.sel = m.id;
      const d = devices.get(m.id);
      if (d && d.frame && ws.readyState === 1) ws.send(d.frame, { binary: true });
    } else if (m.t === 'touch' || m.t === 'hide') {
      const d = p.sel ? devices.get(p.sel) : null;
      if (d && d.ws.readyState === 1) d.ws.send(JSON.stringify(m));
    }
  });

  ws.on('close', () => panels.delete(ws));
  ws.on('error', () => {});
}

server.listen(PORT, () => {
  console.log('FinalStage relay listening on port ' + PORT);
});
