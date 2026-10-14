(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('screen');
  var ctx = canvas.getContext('2d');

  var state = {
    key: localStorage.getItem('fs_key') || '',
    sel: null,
    ws: null,
    start: null,
    moved: false,
    t0: 0
  };

  $('key').value = state.key;

  $('saveKey').onclick = function () {
    state.key = $('key').value.trim();
    localStorage.setItem('fs_key', state.key);
    connect();
  };

  function connect() {
    if (state.ws) {
      try { state.ws.close(); } catch (e) {}
    }
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = new WebSocket(proto + location.host + '/panel?key=' + encodeURIComponent(state.key));
    ws.binaryType = 'blob';
    state.ws = ws;

    ws.onopen = function () {
      $('conn').textContent = 'online';
      $('conn').className = 'badge ok';
    };

    ws.onclose = function () {
      $('conn').textContent = 'offline';
      $('conn').className = 'badge';
      setTimeout(connect, 2500);
    };

    ws.onerror = function () {};

    ws.onmessage = function (e) {
      if (typeof e.data === 'string') {
        var m = JSON.parse(e.data);
        if (m.t === 'devices') renderDevices(m.list);
        return;
      }
      drawFrame(e.data);
    };
  }

  function renderDevices(list) {
    var ul = $('devices');
    ul.textContent = '';
    if (!list || !list.length) {
      var li = document.createElement('li');
      li.textContent = 'нет устройств';
      li.className = 'muted';
      ul.appendChild(li);
      return;
    }
    list.forEach(function (d) {
      var li = document.createElement('li');
      li.textContent = (d.name || 'device') + ' [' + d.id.slice(0, 6) + ']';
      if (state.sel === d.id) li.className = 'sel';
      li.onclick = function () {
        state.sel = d.id;
        $('devInfo').textContent = d.name || d.id;
        if (state.ws && state.ws.readyState === 1) {
          state.ws.send(JSON.stringify({ t: 'select', id: d.id }));
        }
        renderDevices(list);
      };
      ul.appendChild(li);
    });
  }

  var pending = false;

  function drawFrame(blob) {
    if (pending) return;
    pending = true;
    createImageBitmap(blob).then(function (bmp) {
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      pending = false;
    }).catch(function () { pending = false; });
  }

  function norm(e) {
    var r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height
    };
  }

  function send(m) {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(m));
  }

  canvas.onpointerdown = function (e) {
    if (!state.sel) return;
    canvas.setPointerCapture(e.pointerId);
    state.start = norm(e);
    state.moved = false;
    state.t0 = Date.now();
  };

  canvas.onpointermove = function (e) {
    if (!state.start) return;
    var p = norm(e);
    if (Math.abs(p.x - state.start.x) > 0.012 || Math.abs(p.y - state.start.y) > 0.012) {
      state.moved = true;
    }
  };

  canvas.onpointerup = function (e) {
    if (!state.start) return;
    var p = norm(e);
    var dt = Date.now() - state.t0;
    if (state.moved) {
      send({ t: 'touch', kind: 'swipe', x1: state.start.x, y1: state.start.y, x2: p.x, y2: p.y, ms: Math.max(120, Math.min(dt, 1200)) });
    } else if (dt > 600) {
      send({ t: 'touch', kind: 'long', x1: state.start.x, y1: state.start.y, ms: dt });
    } else {
      send({ t: 'touch', kind: 'tap', x1: state.start.x, y1: state.start.y });
    }
    state.start = null;
  };

  canvas.onpointercancel = function () { state.start = null; };

  async function push(file, type) {
    if (!file) return;
    var fd = new FormData();
    fd.append('file', file);
    fd.append('type', type);
    fd.append('duration', $('dur').value || '0');
    if (state.sel) fd.append('deviceId', state.sel);
    $('pushStatus').textContent = 'загрузка...';
    try {
      var r = await fetch('/push?key=' + encodeURIComponent(state.key), { method: 'POST', body: fd });
      var j = await r.json();
      $('pushStatus').textContent = j.ok ? 'показано' : 'ошибка';
    } catch (e) {
      $('pushStatus').textContent = 'ошибка: ' + e.message;
    }
  }

  $('photo').onchange = function () { push(this.files[0], 'image'); };
  $('video').onchange = function () { push(this.files[0], 'video'); };
  $('hide').onclick = function () { send({ t: 'hide' }); };

  connect();
})();
