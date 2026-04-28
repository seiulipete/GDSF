// ── GDSF CHECK-IN: APP LOGIC v3.7 ────────────────────────────────────────────
// Wird von gdsf-checkin.html eingebunden. Benötigt: gdsf-config.js + XLSX.js

// ── STATE ────────────────────────────────────
let currentUser = null;
let currentEventId = null;
let allGuests = [];
let filteredGuests = [];
let events = [];
let pendingCheckin = null;
let importData = null;
let importSheetIndex = 0;
let importEventId = null;
let addGuestEventId = null;
let realtimeChannel = null;

// ── API HELPERS ──────────────────────────────
async function api(method, path, body) {
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };
  if (method === 'POST' || method === 'PATCH') {
    headers['Prefer'] = 'return=representation';
  }
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  if (!r.ok) {
    const txt = await r.text();
    let msg = txt;
    try { msg = JSON.parse(txt).message || JSON.parse(txt).hint || txt; } catch(e) {}
    console.error('[API Error]', method, path, r.status, msg);
    throw new Error(msg);
  }
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

async function testConnection() {
  const ind = document.getElementById('conn-indicator');
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/events?select=id&limit=1', {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
    });
    if (r.ok) {
      ind && ind.classList.add('connected');
    } else {
      const t = await r.text();
      console.error('[DB] Connection failed:', r.status, t);
      ind && ind.classList.add('error');
    }
  } catch(e) {
    console.error('[DB] Network error:', e.message);
    ind && ind.classList.add('error');
  }
}

async function get(path) { return api('GET', path); }
async function post(path, body) { return api('POST', path, body); }
async function patch(path, body) { return api('PATCH', path, body); }
async function del(path) { return api('DELETE', path); }

// ── LOGIN ────────────────────────────────────
async function doLogin() {
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  try {
    const rows = await get(`entrances?username=eq.${encodeURIComponent(user)}&is_active=eq.true&select=*`);
    if (!rows || rows.length === 0 || rows[0].password_hash !== pass) {
      errEl.style.display = 'block';
      return;
    }
    currentUser = rows[0];
    sessionStorage.setItem('gdsf_user', JSON.stringify(currentUser));
    showApp();
  } catch(e) {
    errEl.textContent = 'Verbindungsfehler: ' + e.message;
    errEl.style.display = 'block';
  }
}

document.getElementById('login-pass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});
document.getElementById('login-user').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('login-pass').focus();
});

function genMagicCode(inputId) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  document.getElementById(inputId).value = code;
  document.getElementById(inputId).select();
  try { document.execCommand('copy'); toast('Code kopiert: ' + code, 'success'); } catch(e) {}
}

function doLogout() {
  if (!confirm('Wirklich abmelden?')) return;
  if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
  sessionStorage.removeItem('gdsf_user');
  localStorage.removeItem('gdsf_offline_queue');
  currentUser = null;
  currentEventId = null;
  allGuests = [];
  events = [];
  document.getElementById('app').classList.remove('visible');
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('tab-admin-btn').style.display = 'none';
  document.querySelectorAll('.tab-btn').forEach((b,i) => b.classList.toggle('active', i===0));
  document.getElementById('view-checkin').style.display = 'flex';
  document.getElementById('view-dashboard').style.display = 'none';
  document.getElementById('view-admin').style.display = 'none';
  document.getElementById('view-admin').classList.remove('active');
  const logoutFooter = document.getElementById('app-footer');
  if (logoutFooter) logoutFooter.style.display = 'none';
}

// ── SHOW APP ─────────────────────────────────
async function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  document.getElementById('header-entrance').textContent = currentUser.name;
  document.getElementById('view-admin').style.display = 'none';
  document.getElementById('view-admin').classList.remove('active');
  document.getElementById('view-dashboard').style.display = 'none';
  document.getElementById('view-checkin').style.display = 'flex';
  // Show footer
  const footer = document.getElementById('app-footer');
  if (footer) footer.style.display = 'block';
  if (currentUser.is_admin) {
    document.getElementById('tab-admin-btn').style.display = '';
  } else {
    document.getElementById('tab-admin-btn').style.display = 'none';
  }
  await loadEvents();
  setupRealtime();
}

// ── EVENTS ───────────────────────────────────
// BUG FIX: sort_order Spalte könnte fehlen → query ohne sort_order,
// Sortierung passiert nur im JS (mit null-check)
async function loadEvents() {
  let rawEvents = [];
  try {
    rawEvents = await get('events?select=*') || [];
  } catch(e) {
    console.error('loadEvents error:', e);
    toast('Fehler beim Laden der Events: ' + e.message, 'error');
    return;
  }
  events = rawEvents.sort(function(a, b) {
    // sort_order wenn vorhanden, sonst nach Datum
    if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
    if (a.sort_order != null) return -1;
    if (b.sort_order != null) return 1;
    return (a.event_date || '').localeCompare(b.event_date || '');
  });
  renderEventPills();
  if (events.length > 0) {
    selectEvent(events[0].id);
  }
  if (currentUser.is_admin) {
    renderAdminEventPills();
    renderEventsList();
    loadAdminStats();
    loadAccounts();
  }
}

function renderEventPills() {
  const c = document.getElementById('event-pills-checkin');
  c.innerHTML = events.map(e =>
    `<div class="event-pill ${e.id===currentEventId?'active':''}" onclick="selectEvent('${e.id}')">${e.name}</div>`
  ).join('');
}

function renderAdminEventPills() {
  const containers = ['event-pills-admin','event-pills-import','event-pills-addguest'];
  containers.forEach(id => {
    const c = document.getElementById(id);
    if (!c) return;
    c.innerHTML = events.map(e =>
      `<div class="event-pill ${e.id===currentEventId?'active':''}" onclick="selectAdminEvent('${e.id}','${id}')">${e.name}</div>`
    ).join('');
  });
  if (events.length > 0 && !importEventId) importEventId = events[0].id;
  if (events.length > 0 && !addGuestEventId) addGuestEventId = events[0].id;
}

function selectAdminEvent(id, fromPillsId) {
  const pills = document.querySelectorAll('#' + fromPillsId + ' .event-pill');
  pills.forEach(p => p.classList.remove('active'));
  pills.forEach(p => {
    if (p.getAttribute('onclick') && p.getAttribute('onclick').includes("'" + id + "'")) p.classList.add('active');
  });
  if (fromPillsId === 'event-pills-import') {
    importEventId = id;
  } else if (fromPillsId === 'event-pills-addguest') {
    addGuestEventId = id;
  } else {
    currentEventId = id;
    loadAdminStats();
  }
}

async function selectEvent(id) {
  currentEventId = id;
  renderEventPills();
  const ev = events.find(e => e.id === id);
  document.getElementById('header-event-name').textContent = ev ? ev.name : '–';
  await loadGuests();
}

// ── GUESTS ───────────────────────────────────
async function loadGuests() {
  if (!currentEventId) return;
  try {
    allGuests = await get(`guests?event_id=eq.${currentEventId}&order=nachname.asc&select=*`) || [];
    updateStats();
    applySearch();
  } catch(e) {
    toast('Fehler beim Laden: ' + e.message, 'error');
  }
}

function updateStats() {
  const checked = allGuests.filter(g => g.checked_in).length;
  const vip = allGuests.filter(g => g.vip).length;
  document.getElementById('stat-checked').textContent = checked;
  document.getElementById('stat-total').textContent = allGuests.length;
  document.getElementById('stat-vip').textContent = vip;
  document.getElementById('stat-remaining').textContent = allGuests.length - checked;
  document.getElementById('header-stat').textContent = `${checked}/${allGuests.length}`;
}

// ── SEARCH ───────────────────────────────────
function onSearch() {
  const q = document.getElementById('search-input').value;
  document.getElementById('search-clear').style.display = q ? 'block' : 'none';
  applySearch();
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').style.display = 'none';
  applySearch();
}

function applySearch() {
  const q = document.getElementById('search-input').value.toLowerCase().trim();
  if (!q) {
    filteredGuests = [...allGuests];
  } else {
    filteredGuests = allGuests.filter(g => {
      const haystack = [g.vorname, g.nachname, g.firma, g.kategorie].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }
  filteredGuests.sort((a, b) => {
    if (a.checked_in !== b.checked_in) return a.checked_in ? 1 : -1;
    if (a.vip !== b.vip) return a.vip ? -1 : 1;
    return (a.nachname || '').localeCompare(b.nachname || '');
  });
  renderGuestList();
}

// ── RENDER GUESTS ────────────────────────────
function renderGuestList() {
  const el = document.getElementById('guest-list');
  if (filteredGuests.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="icon">🔍</div><p>Keine Gäste gefunden.</p></div>`;
    return;
  }
  el.innerHTML = filteredGuests.map(g => {
    const initials = [(g.vorname||'').charAt(0), (g.nachname||'').charAt(0)].join('').toUpperCase();
    const fullName = [g.vorname, g.nachname].filter(Boolean).join(' ');
    const meta = [g.firma, g.kategorie].filter(Boolean).join(' · ');
    const checkedTime = g.checked_in_at ? new Date(g.checked_in_at).toLocaleTimeString('de-AT', {hour:'2-digit',minute:'2-digit'}) : '';
    return `<div class="guest-card ${g.checked_in?'checked':''} ${g.vip?'vip':''}">
      <div class="guest-avatar">
        ${initials}
        ${g.vip ? '<div class="vip-star">★</div>' : ''}
      </div>
      <div class="guest-info">
        <div class="guest-name">
          ${g.vip ? '<span class="guest-badge">VIP</span>' : ''}
          ${escHtml(fullName)}
        </div>
        <div class="guest-meta">${escHtml(meta)}</div>
        ${g.notiz ? `<div class="guest-meta" style="color:var(--accent);margin-top:0.1rem">📝 ${escHtml(g.notiz)}</div>` : ''}
      </div>
      <div class="guest-right">
        ${g.checked_in
          ? `<div class="checked-badge">✓ OK<div class="checked-time">${checkedTime}</div></div>`
          : `<button class="checkin-btn" onclick="openConfirm('${g.id}')">Check-In</button>`
        }
      </div>
    </div>`;
  }).join('');
}

function escHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── CHECKIN FLOW ─────────────────────────────
function openConfirm(guestId) {
  const g = allGuests.find(x => x.id === guestId);
  if (!g || g.checked_in) return;
  pendingCheckin = g;
  const fullName = [g.vorname, g.nachname].filter(Boolean).join(' ');
  document.getElementById('overlay-name').textContent = fullName;
  document.getElementById('overlay-meta').textContent = [g.firma, g.kategorie, g.notiz].filter(Boolean).join(' · ');
  document.getElementById('overlay-vip-badge').style.display = g.vip ? 'inline-flex' : 'none';
  document.getElementById('confirm-overlay').classList.add('show');
}

function closeConfirm() {
  document.getElementById('confirm-overlay').classList.remove('show');
  pendingCheckin = null;
}

async function confirmCheckin() {
  if (!pendingCheckin) return;
  const g = pendingCheckin;
  closeConfirm();
  const now = new Date().toISOString();
  const fullName = [g.vorname, g.nachname].filter(Boolean).join(' ');
  const idx = allGuests.findIndex(x => x.id === g.id);
  if (idx !== -1) {
    allGuests[idx].checked_in = true;
    allGuests[idx].checked_in_at = now;
    allGuests[idx].checked_in_by = currentUser.name;
  }
  updateStats();
  applySearch();
  showSuccessFlash(fullName);
  addLiveFeedItem(g, currentUser.name);
  if (!isOnline) {
    offlineQueue.push({ guest_id: g.id, event_id: currentEventId, checked_in_at: now, entrance: currentUser.name });
    saveOfflineQueue();
    updateOfflineBadge();
    toast('📵 Offline gespeichert – wird synchronisiert sobald Verbindung besteht');
    return;
  }
  try {
    await patch(`guests?id=eq.${g.id}`, {
      checked_in: true, checked_in_at: now, checked_in_by: currentUser.name
    });
    await post('checkin_log', {
      guest_id: g.id, event_id: currentEventId, entrance_name: currentUser.name, action: 'checkin'
    });
  } catch(e) {
    offlineQueue.push({ guest_id: g.id, event_id: currentEventId, checked_in_at: now, entrance: currentUser.name });
    saveOfflineQueue();
    setOnlineState(false);
    updateOfflineBadge();
    toast('📵 Verbindung unterbrochen – lokal gespeichert');
  }
}

function showSuccessFlash(name) {
  const el = document.getElementById('success-flash');
  document.getElementById('success-name').textContent = name;
  el.classList.add('show');
  if (navigator.vibrate) navigator.vibrate([50, 30, 50]);
  setTimeout(() => el.classList.remove('show'), 1200);
}

// ── LIVE FEED ────────────────────────────────
function addLiveFeedItem(guest, entrance) {
  const feed = document.getElementById('live-feed');
  const items = document.getElementById('live-feed-items');
  feed.style.display = 'block';
  const name = [guest.vorname, guest.nachname].filter(Boolean).join(' ');
  const time = new Date().toLocaleTimeString('de-AT', {hour:'2-digit',minute:'2-digit'});
  const div = document.createElement('div');
  div.className = 'live-item';
  div.innerHTML = `<span style="color:var(--green)">✓</span><span class="name">${escHtml(name)}</span><span class="entrance">${escHtml(entrance)} · ${time}</span>`;
  items.insertBefore(div, items.firstChild);
  while (items.children.length > 5) items.removeChild(items.lastChild);
}

// ── OFFLINE QUEUE ────────────────────────────
let offlineQueue = [];
try { offlineQueue = JSON.parse(localStorage.getItem('gdsf_offline_queue') || '[]'); } catch(e) {}
let isOnline = true;

function setOnlineState(online) {
  if (isOnline === online) return;
  isOnline = online;
  const banner = document.getElementById('offline-banner');
  const ind = document.getElementById('conn-indicator');
  if (online) {
    banner.classList.remove('show');
    ind.classList.remove('error');
    ind.classList.add('connected');
    flushOfflineQueue();
  } else {
    banner.classList.add('show');
    ind.classList.remove('connected');
    ind.classList.add('error');
  }
  updateOfflineBadge();
}

function updateOfflineBadge() {
  const badge = document.getElementById('offline-count');
  if (offlineQueue.length > 0) {
    badge.textContent = offlineQueue.length;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function saveOfflineQueue() {
  try { localStorage.setItem('gdsf_offline_queue', JSON.stringify(offlineQueue)); } catch(e) {}
}

async function flushOfflineQueue() {
  if (offlineQueue.length === 0) return;
  const toSync = [...offlineQueue];
  for (const item of toSync) {
    try {
      await patch(`guests?id=eq.${item.guest_id}`, {
        checked_in: true, checked_in_at: item.checked_in_at, checked_in_by: item.entrance
      });
      await post('checkin_log', {
        guest_id: item.guest_id, event_id: item.event_id,
        entrance_name: item.entrance, action: 'checkin'
      });
      offlineQueue = offlineQueue.filter(x => x.guest_id !== item.guest_id);
      saveOfflineQueue();
    } catch(e) { break; }
  }
  updateOfflineBadge();
  if (offlineQueue.length === 0) toast('✓ Offline Check-ins synchronisiert!', 'success');
}

// ── REALTIME (Polling) ───────────────────────
function setupRealtime() {
  const indicator = document.getElementById('conn-indicator');
  let lastPoll = Date.now();
  indicator.classList.add('connected');
  let pollInterval = 6000;
  let failCount = 0;
  flushOfflineQueue();

  async function doPoll() {
    if (!currentEventId) { setTimeout(doPoll, pollInterval); return; }
    try {
      const since = new Date(lastPoll - 8000).toISOString();
      const updated = await get(`guests?event_id=eq.${currentEventId}&checked_in=eq.true&checked_in_at=gt.${since}&select=*`);
      lastPoll = Date.now();
      failCount = 0;
      pollInterval = 6000;
      if (updated && updated.length > 0) {
        let changed = false;
        updated.forEach(g => {
          const idx = allGuests.findIndex(x => x.id === g.id);
          if (idx !== -1 && !allGuests[idx].checked_in) {
            allGuests[idx] = g;
            changed = true;
            addLiveFeedItem(g, g.checked_in_by || '–');
          } else if (idx !== -1) {
            allGuests[idx] = g;
          }
        });
        if (changed) { updateStats(); applySearch(); }
      }
      setOnlineState(true);
    } catch(e) {
      failCount++;
      setOnlineState(false);
      pollInterval = Math.min(30000, 6000 * Math.pow(1.5, failCount));
    }
    setTimeout(doPoll, pollInterval);
  }

  setTimeout(doPoll, pollInterval);
  window.addEventListener('online',  () => { pollInterval = 6000; doPoll(); });
  window.addEventListener('offline', () => setOnlineState(false));
}

// ── ADMIN: STATS + CHARTS ────────────────────
async function loadAdminStats() {
  if (!currentEventId) return;
  const ev = events.find(e => e.id === currentEventId);
  document.getElementById('admin-event-label').textContent = ev ? ev.name : '–';
  try {
    const guests = await get(`guests?event_id=eq.${currentEventId}&select=id,checked_in,vip,kategorie,checked_in_by,checked_in_at`) || [];
    const total = guests.length;
    const checked = guests.filter(g => g.checked_in).length;
    const vip = guests.filter(g => g.vip).length;
    const pct = total > 0 ? Math.round(checked/total*100) : 0;
    document.getElementById('a-total').textContent = total;
    document.getElementById('a-checked').textContent = checked;
    document.getElementById('a-vip').textContent = vip;
    document.getElementById('a-pending').textContent = total - checked;
    document.getElementById('a-pct').textContent = pct + '%';
    document.getElementById('a-progress').style.width = pct + '%';
    const circ = 2 * Math.PI * 35;
    const arc = (checked / (total || 1)) * circ;
    document.getElementById('donut-arc').setAttribute('stroke-dasharray', `${arc.toFixed(1)} ${circ.toFixed(1)}`);
    document.getElementById('donut-pct').textContent = pct + '%';
    const byEntrance = {};
    guests.filter(g => g.checked_in && g.checked_in_by).forEach(g => {
      byEntrance[g.checked_in_by] = (byEntrance[g.checked_in_by] || 0) + 1;
    });
    const entranceEl = document.getElementById('entrance-chart');
    const maxE = Math.max(...Object.values(byEntrance), 1);
    if (Object.keys(byEntrance).length === 0) {
      entranceEl.innerHTML = '<div style="color:var(--muted);font-size:0.75rem;text-align:center;padding:0.5rem">Noch keine Check-ins</div>';
    } else {
      entranceEl.innerHTML = Object.entries(byEntrance).sort((a,b) => b[1]-a[1]).map(([name, count]) => {
        const pctBar = Math.round(count/maxE*100);
        return `<div>
          <div style="display:flex;justify-content:space-between;font-size:0.7rem;margin-bottom:0.2rem">
            <span style="color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%">${escHtml(name)}</span>
            <span style="color:var(--accent);font-weight:600">${count}</span>
          </div>
          <div style="background:var(--border);border-radius:4px;height:5px">
            <div style="background:var(--accent);height:5px;border-radius:4px;width:${pctBar}%;transition:width 0.4s ease"></div>
          </div>
        </div>`;
      }).join('');
    }
    const byCat = {};
    guests.forEach(g => {
      const cat = g.kategorie || 'Sonstige';
      if (!byCat[cat]) byCat[cat] = { total: 0, checked: 0 };
      byCat[cat].total++;
      if (g.checked_in) byCat[cat].checked++;
    });
    const catEl = document.getElementById('category-chart');
    catEl.innerHTML = Object.entries(byCat).sort((a,b) => b[1].total - a[1].total).map(([cat, d]) => {
      const p = Math.round(d.checked/d.total*100);
      return `<div>
        <div style="display:flex;justify-content:space-between;font-size:0.7rem;margin-bottom:0.2rem">
          <span style="color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%">${escHtml(cat)}</span>
          <span style="color:var(--muted)">${d.checked}/${d.total} <span style="color:var(--green)">${p}%</span></span>
        </div>
        <div style="background:var(--border);border-radius:4px;height:5px">
          <div style="background:var(--green);height:5px;border-radius:4px;width:${p}%;transition:width 0.4s ease"></div>
        </div>
      </div>`;
    }).join('');
    renderTimelineChart(guests.filter(g => g.checked_in && g.checked_in_at));
  } catch(e) { console.error('loadAdminStats:', e); }
}

function renderTimelineChart(checkedGuests) {
  const svg = document.getElementById('timeline-chart');
  if (!svg) return;
  if (checkedGuests.length === 0) {
    svg.innerHTML = '<text x="50%" y="35" text-anchor="middle" font-family="DM Sans,sans-serif" font-size="11" fill="#6b6b80">Noch keine Check-ins</text>';
    return;
  }
  const buckets = {};
  checkedGuests.forEach(g => {
    const d = new Date(g.checked_in_at);
    const key = `${d.getHours()}:${d.getMinutes() < 30 ? '00' : '30'}`;
    buckets[key] = (buckets[key] || 0) + 1;
  });
  const keys = Object.keys(buckets).sort();
  const vals = keys.map(k => buckets[k]);
  const maxV = Math.max(...vals, 1);
  const W = 260, H = 50, pad = 4;
  const bw = Math.max(8, Math.floor((W - pad*(keys.length+1)) / keys.length));
  let bars = '';
  keys.forEach((k, i) => {
    const bh = Math.round((vals[i]/maxV) * (H-14));
    const x = pad + i*(bw+pad);
    const y = H - bh - 12;
    bars += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="2" fill="url(#barGrad)" opacity="0.9"/>`;
    if (i % 2 === 0 || keys.length <= 6) {
      bars += `<text x="${x+bw/2}" y="${H}" text-anchor="middle" font-family="DM Sans,sans-serif" font-size="8" fill="#6b6b80">${k}</text>`;
    }
    bars += `<text x="${x+bw/2}" y="${y-2}" text-anchor="middle" font-family="DM Sans,sans-serif" font-size="8" fill="var(--accent)" font-weight="bold">${vals[i]}</text>`;
  });
  svg.innerHTML = `<defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#f0c040"/><stop offset="100%" stop-color="#e05a00"/>
  </linearGradient></defs>${bars}`;
}

// ── ADMIN: EVENTS LIST ───────────────────────
function renderEventsList() {
  const el = document.getElementById('events-list');
  if (!events.length) { el.innerHTML = '<div style="color:var(--muted);font-size:0.85rem">Noch keine Events.</div>'; return; }
  const sorted = [...events].sort((a,b) => {
    if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
    if (a.sort_order != null) return -1;
    if (b.sort_order != null) return 1;
    return (a.event_date||'').localeCompare(b.event_date||'');
  });
  el.innerHTML = '';
  sorted.forEach(function(e, idx) {
    const row = document.createElement('div');
    row.className = 'account-row';
    const sortDiv = document.createElement('div');
    sortDiv.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin-right:0.4rem';
    const btnUp = document.createElement('button');
    btnUp.className = 'icon-btn';
    btnUp.textContent = '▲';
    btnUp.style.cssText = 'padding:0.15rem 0.4rem;font-size:0.7rem';
    if (idx === 0) btnUp.disabled = true;
    btnUp.onclick = function() { moveEvent(e.id, -1); };
    const btnDown = document.createElement('button');
    btnDown.className = 'icon-btn';
    btnDown.textContent = '▼';
    btnDown.style.cssText = 'padding:0.15rem 0.4rem;font-size:0.7rem';
    if (idx === sorted.length - 1) btnDown.disabled = true;
    btnDown.onclick = function() { moveEvent(e.id, 1); };
    sortDiv.appendChild(btnUp);
    sortDiv.appendChild(btnDown);
    row.appendChild(sortDiv);
    const info = document.createElement('div');
    info.className = 'account-info';
    const nameDiv = document.createElement('div');
    nameDiv.className = 'account-name';
    nameDiv.textContent = e.name;
    const dateDiv = document.createElement('div');
    dateDiv.className = 'account-user';
    dateDiv.textContent = e.event_date ? new Date(e.event_date).toLocaleDateString('de-AT') : '–';
    info.appendChild(nameDiv);
    info.appendChild(dateDiv);
    row.appendChild(info);
    const badge = document.createElement('span');
    badge.className = 'account-badge ' + (e.is_active ? 'badge-door' : 'badge-admin');
    badge.textContent = e.is_active ? 'Aktiv' : 'Inaktiv';
    row.appendChild(badge);
    const actions = document.createElement('div');
    actions.className = 'account-actions';
    const btnDel = document.createElement('button');
    btnDel.className = 'icon-btn del';
    btnDel.textContent = '🗑';
    btnDel.onclick = function() { deleteEvent(e.id); };
    actions.appendChild(btnDel);
    row.appendChild(actions);
    el.appendChild(row);
  });
}

async function moveEvent(id, direction) {
  const sorted = [...events].sort((a,b) => {
    if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
    if (a.sort_order != null) return -1;
    if (b.sort_order != null) return 1;
    return (a.event_date||'').localeCompare(b.event_date||'');
  });
  const idx = sorted.findIndex(e => e.id === id);
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= sorted.length) return;
  sorted.forEach((e, i) => e.sort_order = i * 10);
  const tmp = sorted[idx].sort_order;
  sorted[idx].sort_order = sorted[swapIdx].sort_order;
  sorted[swapIdx].sort_order = tmp;
  try {
    await Promise.all([
      patch(`events?id=eq.${sorted[idx].id}`, { sort_order: sorted[idx].sort_order }),
      patch(`events?id=eq.${sorted[swapIdx].id}`, { sort_order: sorted[swapIdx].sort_order })
    ]);
    await loadEvents();
  } catch(e) { toast('Fehler beim Speichern: ' + e.message, 'error'); }
}

async function deleteEvent(id) {
  if (!confirm('Event und alle Gäste löschen?')) return;
  await del(`events?id=eq.${id}`);
  toast('Event gelöscht');
  await loadEvents();
}

function showNewEventModal() {
  const modal = document.getElementById('event-modal');
  modal.classList.add('show');
  document.getElementById('new-evt-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('event-modal-error').style.display = 'none';
}
function closeEventModal() { document.getElementById('event-modal').classList.remove('show'); }

async function saveNewEvent() {
  const name = document.getElementById('new-evt-name').value.trim();
  const date = document.getElementById('new-evt-date').value;
  const errEl = document.getElementById('event-modal-error');
  errEl.style.display = 'none';
  if (!name || !date) { errEl.textContent = 'Name und Datum sind Pflichtfelder.'; errEl.style.display = 'block'; return; }
  const createBtn = document.getElementById('create-event-btn');
  if (createBtn) { createBtn.textContent = '…'; createBtn.disabled = true; }
  try {
    const response = await fetch(SUPABASE_URL + '/rest/v1/events', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=representation'
      },
      body: JSON.stringify({ name, event_date: date, is_active: true })
    });
    const responseText = await response.text();
    if (!response.ok) { throw new Error('HTTP ' + response.status + ': ' + responseText); }
    closeEventModal();
    document.getElementById('new-evt-name').value = '';
    toast('Event erstellt ✓', 'success');
    await loadEvents();
  } catch(e) {
    errEl.textContent = 'Fehler: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    if (createBtn) { createBtn.textContent = 'Erstellen'; createBtn.disabled = false; }
  }
}

// ── ADMIN: ACCOUNTS ──────────────────────────
let editingAccountId = null;

function makeInput(idStr, valStr, phStr, accent) {
  var inp = document.createElement('input');
  inp.id = idStr;
  if (valStr !== null) inp.value = valStr;
  inp.placeholder = phStr;
  var border = accent ? 'var(--accent)' : 'var(--border)';
  inp.style.cssText = 'flex:1;background:var(--card);border:1px solid ' + border + ';border-radius:6px;color:var(--text);padding:0.45rem 0.6rem;font-family:inherit;font-size:0.85rem';
  return inp;
}

async function loadAccounts() {
  const rows = await get('entrances?order=is_admin.desc,name.asc&select=*') || [];
  const el = document.getElementById('accounts-list');
  el.innerHTML = '';
  rows.forEach(function(r) {
    if (editingAccountId === r.id) {
      const row = document.createElement('div');
      row.className = 'account-row';
      row.id = 'acc-edit-' + r.id;
      row.style.cssText = 'flex-direction:column;align-items:stretch;gap:0.5rem';
      const row1 = document.createElement('div');
      row1.style.cssText = 'display:flex;gap:0.5rem';
      row1.appendChild(makeInput('en-' + r.id, r.name, 'Name', true));
      row1.appendChild(makeInput('eu-' + r.id, r.username, 'Username', false));
      const row2 = document.createElement('div');
      row2.style.cssText = 'display:flex;gap:0.5rem;align-items:center';
      const inPass = makeInput('ep-' + r.id, null, 'Neues Passwort (leer = unverändert)', false);
      const btnM = document.createElement('button');
      btnM.className = 'icon-btn';
      btnM.title = 'Magic Code';
      btnM.textContent = '🎲';
      btnM.style.cssText = 'padding:0.4rem 0.6rem;font-size:1rem';
      btnM.setAttribute('data-pid', r.id);
      btnM.addEventListener('click', function() { genMagicCode('ep-' + this.getAttribute('data-pid')); });
      row2.appendChild(inPass);
      row2.appendChild(btnM);
      const row3 = document.createElement('div');
      row3.style.cssText = 'display:flex;gap:0.5rem;align-items:center';
      const sel = document.createElement('select');
      sel.id = 'er-' + r.id;
      sel.style.cssText = 'background:var(--card);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:0.4rem 0.5rem;font-family:inherit;font-size:0.82rem';
      const optTuer = document.createElement('option');
      optTuer.value = 'false'; optTuer.textContent = 'Türpersonal';
      if (!r.is_admin) optTuer.selected = true;
      const optAdmin = document.createElement('option');
      optAdmin.value = 'true'; optAdmin.textContent = 'Admin';
      if (r.is_admin) optAdmin.selected = true;
      sel.appendChild(optTuer);
      sel.appendChild(optAdmin);
      const btnSave = document.createElement('button');
      btnSave.className = 'btn green';
      btnSave.textContent = '✓ Speichern';
      btnSave.style.cssText = 'flex:1;font-size:0.8rem;padding:0.4rem 0.75rem';
      btnSave.setAttribute('data-rid', r.id);
      btnSave.addEventListener('click', function() { saveAccountEdit(this.getAttribute('data-rid')); });
      const btnCan = document.createElement('button');
      btnCan.className = 'btn secondary';
      btnCan.textContent = '✕';
      btnCan.style.cssText = 'width:auto;font-size:0.8rem;padding:0.4rem 0.75rem';
      btnCan.addEventListener('click', cancelAccountEdit);
      row3.appendChild(sel);
      row3.appendChild(btnSave);
      row3.appendChild(btnCan);
      row.appendChild(row1);
      row.appendChild(row2);
      row.appendChild(row3);
      el.appendChild(row);
    } else {
      const row = document.createElement('div');
      row.className = 'account-row';
      const info = document.createElement('div');
      info.className = 'account-info';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'account-name';
      nameDiv.textContent = r.name;
      const userDiv = document.createElement('div');
      userDiv.className = 'account-user';
      userDiv.textContent = '@' + r.username + ' · ' + '•'.repeat(Math.min((r.password_hash || '').length, 8));
      info.appendChild(nameDiv);
      info.appendChild(userDiv);
      row.appendChild(info);
      const badge = document.createElement('span');
      badge.className = 'account-badge ' + (r.is_admin ? 'badge-admin' : 'badge-door');
      badge.textContent = r.is_admin ? 'Admin' : 'Tür';
      row.appendChild(badge);
      const actions = document.createElement('div');
      actions.className = 'account-actions';
      const btnEdit = document.createElement('button');
      btnEdit.className = 'icon-btn';
      btnEdit.title = 'Bearbeiten';
      btnEdit.textContent = '✏️';
      btnEdit.setAttribute('data-rid', r.id);
      btnEdit.addEventListener('click', function() { startAccountEdit(this.getAttribute('data-rid')); });
      const btnDel = document.createElement('button');
      btnDel.className = 'icon-btn del';
      btnDel.textContent = '🗑';
      btnDel.disabled = (r.username === 'admin');
      btnDel.setAttribute('data-rid', r.id);
      btnDel.setAttribute('data-user', r.username);
      btnDel.addEventListener('click', function() { deleteAccount(this.getAttribute('data-rid'), this.getAttribute('data-user')); });
      actions.appendChild(btnEdit);
      actions.appendChild(btnDel);
      row.appendChild(actions);
      el.appendChild(row);
    }
  });
}

function startAccountEdit(id) { editingAccountId = id; loadAccounts(); }
function cancelAccountEdit() { editingAccountId = null; loadAccounts(); }

async function saveAccountEdit(id) {
  const name = document.getElementById(`en-${id}`).value.trim();
  const username = document.getElementById(`eu-${id}`).value.trim().toLowerCase();
  const pass = document.getElementById(`ep-${id}`).value.trim();
  const is_admin = document.getElementById(`er-${id}`).value === 'true';
  if (!name || !username) { toast('Name und Benutzername erforderlich', 'error'); return; }
  const update = { name, username, is_admin };
  if (pass) update.password_hash = pass;
  try {
    await patch(`entrances?id=eq.${id}`, update);
    editingAccountId = null;
    toast('Account gespeichert ✓', 'success');
    loadAccounts();
  } catch(e) { toast('Fehler: ' + e.message, 'error'); }
}

function showNewAccountModal() { document.getElementById('account-modal').classList.add('show'); }
function closeAccountModal() { document.getElementById('account-modal').classList.remove('show'); }

async function saveNewAccount() {
  const name = document.getElementById('new-acc-name').value.trim();
  const username = document.getElementById('new-acc-user').value.trim().toLowerCase();
  const pass = document.getElementById('new-acc-pass').value.trim();
  const is_admin = document.getElementById('new-acc-role').value === 'true';
  if (!name || !username || !pass) { toast('Alle Felder erforderlich', 'error'); return; }
  try {
    await post('entrances', { name, username, password_hash: pass, is_admin, is_active: true });
    closeAccountModal();
    document.getElementById('new-acc-name').value = '';
    document.getElementById('new-acc-user').value = '';
    document.getElementById('new-acc-pass').value = '';
    toast('Account erstellt ✓', 'success');
    loadAccounts();
  } catch(e) { toast('Fehler: ' + e.message, 'error'); }
}

async function deleteAccount(id, username) {
  if (!confirm(`Account "@${username}" löschen?`)) return;
  await del(`entrances?id=eq.${id}`);
  toast('Account gelöscht');
  loadAccounts();
}

// ── IMPORT ───────────────────────────────────
let importParsed = {};
let importSheets = [];

function handleFileImport(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
    importParsed = {};
    importSheets = wb.SheetNames;
    wb.SheetNames.forEach(name => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null });
      importParsed[name] = rows;
    });
    importSheetIndex = 0;
    renderImportPreview();
  };
  reader.readAsArrayBuffer(file);
}

function renderImportPreview() {
  const preview = document.getElementById('import-preview');
  const tabs = document.getElementById('import-sheet-tabs');
  const info = document.getElementById('import-info');
  preview.classList.add('show');
  tabs.innerHTML = importSheets.map((name, i) =>
    `<span class="import-sheet-tab ${i===importSheetIndex?'active':''}" onclick="selectImportSheet(${i})">${name}</span>`
  ).join('');
  const sheet = importSheets[importSheetIndex];
  const rows = importParsed[sheet] || [];
  info.textContent = `${rows.length} Gäste in Sheet "${sheet}"`;
}

function selectImportSheet(i) { importSheetIndex = i; renderImportPreview(); }

async function confirmImport() {
  if (!importEventId) { toast('Bitte zuerst ein Ziel-Event auswählen', 'error'); return; }
  const sheet = importSheets[importSheetIndex];
  const rows = importParsed[sheet] || [];
  if (rows.length === 0) { toast('Keine Daten', 'error'); return; }
  toast(`Importiere ${rows.length} Gäste…`);
  const guests = rows.map(r => ({
    event_id: importEventId,
    gl: r['GL'] ? true : false,
    vip: r['VIP'] ? true : false,
    vorname: r['Vorname'] || null,
    nachname: r['Nachname'] || '',
    firma: r['Firma / Organisation / Beschreibung'] || null,
    kategorie: r['Kategorie'] || null,
    notiz: r['Notiz'] || null,
    checked_in: false
  }));
  try {
    for (let i = 0; i < guests.length; i += 100) {
      await post('guests', guests.slice(i, i+100));
    }
    toast(`✓ ${guests.length} Gäste importiert!`, 'success');
    document.getElementById('import-preview').classList.remove('show');
    if (currentEventId === importEventId) await loadGuests();
    loadAdminStats();
  } catch(e) { toast('Import-Fehler: ' + e.message, 'error'); }
}

// ── ADD GUEST ────────────────────────────────
async function saveNewGuest() {
  const errEl = document.getElementById('ag-error');
  errEl.style.display = 'none';
  const targetEventId = addGuestEventId || currentEventId;
  if (!targetEventId) { errEl.textContent = 'Bitte zuerst ein Event auswählen.'; errEl.style.display = 'block'; return; }
  const nachname = document.getElementById('ag-nachname').value.trim();
  if (!nachname) { errEl.textContent = 'Nachname ist ein Pflichtfeld.'; errEl.style.display = 'block'; return; }
  const guest = {
    event_id: targetEventId,
    vorname: document.getElementById('ag-vorname').value.trim() || null,
    nachname,
    firma: document.getElementById('ag-firma').value.trim() || null,
    kategorie: document.getElementById('ag-kategorie').value.trim() || null,
    notiz: document.getElementById('ag-notiz').value.trim() || null,
    vip: document.getElementById('ag-vip').checked,
    gl: document.getElementById('ag-gl').checked,
    checked_in: false
  };
  const btn = document.querySelector('[onclick="saveNewGuest()"]');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    await post('guests', guest);
    ['ag-vorname','ag-nachname','ag-firma','ag-kategorie','ag-notiz'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('ag-vip').checked = false;
    document.getElementById('ag-gl').checked = true;
    const ev = events.find(e => e.id === targetEventId);
    toast(`✓ ${guest.vorname ? guest.vorname + ' ' : ''}${guest.nachname} hinzugefügt${ev ? ' (' + ev.name + ')' : ''}`, 'success');
    loadAdminStats();
    if (currentEventId === targetEventId) await loadGuests();
  } catch(e) {
    errEl.textContent = 'Fehler: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    if (btn) { btn.textContent = '👤 Gast speichern'; btn.disabled = false; }
  }
}

// ── EXPORT ───────────────────────────────────
async function exportCSV() {
  if (!currentEventId) return;
  const guests = await get(`guests?event_id=eq.${currentEventId}&order=nachname.asc&select=*`) || [];
  const ev = events.find(e => e.id === currentEventId);
  const headers = ['Vorname','Nachname','Firma','Kategorie','VIP','GL','Eingecheckt','Uhrzeit','Eingang','Notiz'];
  const rows = guests.map(g => [
    g.vorname||'', g.nachname||'', g.firma||'', g.kategorie||'',
    g.vip?'Ja':'Nein', g.gl?'Ja':'Nein',
    g.checked_in?'Ja':'Nein',
    g.checked_in_at ? new Date(g.checked_in_at).toLocaleTimeString('de-AT') : '',
    g.checked_in_by||'', g.notiz||''
  ]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `GDSF_${(ev?.name||'Export').replace(/\s/g,'_')}.csv`;
  a.click();
}

async function resetCheckins() {
  if (!currentEventId) return;
  if (!confirm('Wirklich ALLE Check-ins für dieses Event zurücksetzen?')) return;
  await patch(`guests?event_id=eq.${currentEventId}`, { checked_in: false, checked_in_at: null, checked_in_by: null });
  toast('Check-ins zurückgesetzt');
  await loadGuests();
  loadAdminStats();
}

// ── TAB SWITCHING ────────────────────────────
let dashboardTimer = null;
let dashboardEventId = null;

function switchTab(tab) {
  if (tab === 'admin' && (!currentUser || !currentUser.is_admin)) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const tabMap = { checkin: 0, dashboard: 1, admin: 2 };
  const allBtns = document.querySelectorAll('.tab-btn');
  if (allBtns[tabMap[tab]]) allBtns[tabMap[tab]].classList.add('active');
  document.getElementById('view-checkin').style.display = tab === 'checkin' ? 'flex' : 'none';
  document.getElementById('view-dashboard').style.display = tab === 'dashboard' ? 'flex' : 'none';
  const adminView = document.getElementById('view-admin');
  adminView.style.display = tab === 'admin' ? 'flex' : 'none';
  adminView.classList.toggle('active', tab === 'admin');
  if (tab === 'admin') {
    renderAdminEventPills();
    loadAdminStats();
    loadAccounts();
    renderEventsList();
    if (events.length > 0 && !addGuestEventId) addGuestEventId = events[0].id;
    if (dashboardTimer) clearInterval(dashboardTimer);
    dashboardTimer = setInterval(() => {
      if (document.getElementById('view-admin').classList.contains('active')) loadAdminStats();
    }, 15000);
  } else if (tab === 'dashboard') {
    renderDashboardEventPills();
    loadDashboardStats();
    if (dashboardTimer) clearInterval(dashboardTimer);
    dashboardTimer = setInterval(() => {
      if (document.getElementById('view-dashboard').style.display !== 'none') loadDashboardStats();
    }, 15000);
  } else {
    if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
  }
}

function renderDashboardEventPills() {
  const c = document.getElementById('event-pills-dashboard');
  if (!c) return;
  if (events.length > 0 && !dashboardEventId) dashboardEventId = events[0].id;
  c.innerHTML = events.map(e =>
    `<div class="event-pill ${e.id===dashboardEventId?'active':''}" onclick="selectDashboardEvent('${e.id}')">${e.name}</div>`
  ).join('');
  const ev = events.find(e => e.id === dashboardEventId);
  document.getElementById('dash-event-label').textContent = ev ? ev.name : '–';
}

function selectDashboardEvent(id) {
  dashboardEventId = id;
  document.querySelectorAll('#event-pills-dashboard .event-pill').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('#event-pills-dashboard .event-pill').forEach(p => {
    if (p.getAttribute('onclick') && p.getAttribute('onclick').includes("'" + id + "'")) p.classList.add('active');
  });
  const ev = events.find(e => e.id === id);
  document.getElementById('dash-event-label').textContent = ev ? ev.name : '–';
  loadDashboardStats();
}

async function loadDashboardStats() {
  const eid = dashboardEventId || currentEventId;
  if (!eid) return;
  try {
    const guests = await get(`guests?event_id=eq.${eid}&select=id,checked_in,vip,kategorie,checked_in_by,checked_in_at`) || [];
    const total = guests.length;
    const checked = guests.filter(g => g.checked_in).length;
    const vip = guests.filter(g => g.vip).length;
    const pct = total > 0 ? Math.round(checked/total*100) : 0;
    document.getElementById('d-total').textContent = total;
    document.getElementById('d-checked').textContent = checked;
    document.getElementById('d-vip').textContent = vip;
    document.getElementById('d-pending').textContent = total - checked;
    document.getElementById('d-pct').textContent = pct + '%';
    document.getElementById('d-progress').style.width = pct + '%';
    const circ = 2 * Math.PI * 35;
    const arc = (checked / (total || 1)) * circ;
    document.getElementById('d-donut-arc').setAttribute('stroke-dasharray', `${arc.toFixed(1)} ${circ.toFixed(1)}`);
    document.getElementById('d-donut-pct').textContent = pct + '%';
    const byEntrance = {};
    guests.filter(g => g.checked_in && g.checked_in_by).forEach(g => {
      byEntrance[g.checked_in_by] = (byEntrance[g.checked_in_by] || 0) + 1;
    });
    const entranceEl = document.getElementById('d-entrance-chart');
    const maxE = Math.max(...Object.values(byEntrance), 1);
    if (Object.keys(byEntrance).length === 0) {
      entranceEl.innerHTML = '<div style="color:var(--muted);font-size:0.75rem;text-align:center;padding:0.5rem">Noch keine Check-ins</div>';
    } else {
      entranceEl.innerHTML = Object.entries(byEntrance).sort((a,b) => b[1]-a[1]).map(([name, count]) => {
        const pctBar = Math.round(count/maxE*100);
        return `<div><div style="display:flex;justify-content:space-between;font-size:0.7rem;margin-bottom:0.2rem">
          <span style="color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%">${escHtml(name)}</span>
          <span style="color:var(--accent);font-weight:600">${count}</span></div>
          <div style="background:var(--border);border-radius:4px;height:5px">
            <div style="background:var(--accent);height:5px;border-radius:4px;width:${pctBar}%;transition:width 0.4s ease"></div>
          </div></div>`;
      }).join('');
    }
    const byCat = {};
    guests.forEach(g => {
      const cat = g.kategorie || 'Sonstige';
      if (!byCat[cat]) byCat[cat] = { total: 0, checked: 0 };
      byCat[cat].total++;
      if (g.checked_in) byCat[cat].checked++;
    });
    document.getElementById('d-category-chart').innerHTML = Object.entries(byCat)
      .sort((a,b) => b[1].total - a[1].total).map(([cat, d]) => {
        const p = Math.round(d.checked/d.total*100);
        return `<div><div style="display:flex;justify-content:space-between;font-size:0.7rem;margin-bottom:0.2rem">
          <span style="color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%">${escHtml(cat)}</span>
          <span style="color:var(--muted)">${d.checked}/${d.total} <span style="color:var(--green)">${p}%</span></span></div>
          <div style="background:var(--border);border-radius:4px;height:5px">
            <div style="background:var(--green);height:5px;border-radius:4px;width:${p}%;transition:width 0.4s ease"></div>
          </div></div>`;
      }).join('');
    renderDashboardTimeline(guests.filter(g => g.checked_in && g.checked_in_at));
  } catch(e) { console.error('loadDashboardStats:', e); }
}

function renderDashboardTimeline(checkedGuests) {
  const svg = document.getElementById('d-timeline-chart');
  if (!svg) return;
  if (checkedGuests.length === 0) {
    svg.innerHTML = '<text x="50%" y="35" text-anchor="middle" font-family="DM Sans,sans-serif" font-size="11" fill="#6b6b80">Noch keine Check-ins</text>';
    return;
  }
  const buckets = {};
  checkedGuests.forEach(g => {
    const d = new Date(g.checked_in_at);
    const key = `${d.getHours()}:${d.getMinutes() < 30 ? '00' : '30'}`;
    buckets[key] = (buckets[key] || 0) + 1;
  });
  const keys = Object.keys(buckets).sort();
  const vals = keys.map(k => buckets[k]);
  const maxV = Math.max(...vals, 1);
  const W = 260, H = 50, pad = 4;
  const bw = Math.max(8, Math.floor((W - pad*(keys.length+1)) / keys.length));
  let bars = '';
  keys.forEach((k, i) => {
    const bh = Math.round((vals[i]/maxV) * (H-14));
    const x = pad + i*(bw+pad);
    const y = H - bh - 12;
    bars += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="2" fill="url(#dBarGrad)" opacity="0.9"/>`;
    if (i % 2 === 0 || keys.length <= 6) {
      bars += `<text x="${x+bw/2}" y="${H}" text-anchor="middle" font-family="DM Sans,sans-serif" font-size="8" fill="#6b6b80">${k}</text>`;
    }
    bars += `<text x="${x+bw/2}" y="${y-2}" text-anchor="middle" font-family="DM Sans,sans-serif" font-size="8" fill="var(--accent)" font-weight="bold">${vals[i]}</text>`;
  });
  svg.innerHTML = `<defs><linearGradient id="dBarGrad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#f0c040"/><stop offset="100%" stop-color="#e05a00"/>
  </linearGradient></defs>${bars}`;
}

// ── TOASTS ───────────────────────────────────
function toast(msg, type='') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── DRAG & DROP ──────────────────────────────
const dz = document.getElementById('drop-zone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragging'); });
dz.addEventListener('dragleave', () => dz.classList.remove('dragging'));
dz.addEventListener('drop', e => {
  e.preventDefault();
  dz.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (file) handleFileImport({target:{files:[file]}});
});

// ── CLOSE OVERLAYS ON BACKDROP ───────────────
document.getElementById('confirm-overlay').addEventListener('click', function(e) { if (e.target === this) closeConfirm(); });
document.getElementById('account-modal').addEventListener('click', function(e) { if (e.target === this) closeAccountModal(); });
document.getElementById('event-modal').addEventListener('click', function(e) { if (e.target === this) closeEventModal(); });
document.getElementById('ios-install-modal').addEventListener('click', function(e) { if (e.target === this) this.classList.remove('show'); });

// ── AUTO-LOGIN ───────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Logo → Home: touch + click für Mobile
  const logo = document.getElementById('logo-home-btn');
  if (logo) {
    function goHome(e) {
      e.preventDefault();
      if (currentUser) switchTab('checkin');
    }
    logo.addEventListener('click', goHome);
    logo.addEventListener('touchend', goHome, { passive: false });
  }
  const saved = sessionStorage.getItem('gdsf_user');
  if (saved) { try { currentUser = JSON.parse(saved); showApp(); } catch(e) {} }
});

// ── PWA INSTALL (BUG FIX: kein ipwhois durch start_url) ─────────────────────
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isInStandaloneMode = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
let pwaInstallPrompt = null;

function showPWAButtons(visible) {
  // Header install button — toggle visible class
  const hdr = document.getElementById('pwa-install-btn');
  if (hdr) {
    if (visible) hdr.classList.add('visible');
    else hdr.classList.remove('visible');
  }
  // Login banner
  const ban = document.getElementById('login-pwa-banner');
  if (ban) ban.style.display = visible ? 'block' : 'none';
  // Footer install button
  const ftw = document.getElementById('footer-install-wrap');
  if (ftw) ftw.style.display = visible ? 'block' : 'none';
}

function toggleGuide() {
  const content = document.getElementById('guide-content');
  const arrow = document.getElementById('guide-arrow');
  if (!content) return;
  const open = content.style.display === 'flex';
  content.style.display = open ? 'none' : 'flex';
  content.style.flexDirection = 'column';
  if (arrow) arrow.style.transform = open ? '' : 'rotate(180deg)';
}

if (isIOS && !isInStandaloneMode) { showPWAButtons(true); }

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  pwaInstallPrompt = e;
  if (!isInStandaloneMode) { showPWAButtons(true); }
});
window.addEventListener('appinstalled', () => {
  showPWAButtons(false);
  pwaInstallPrompt = null;
});

function triggerPWAInstall() {
  if (isIOS) {
    document.getElementById('ios-install-modal').classList.add('show');
  } else if (pwaInstallPrompt) {
    pwaInstallPrompt.prompt();
    pwaInstallPrompt.userChoice.then(() => { pwaInstallPrompt = null; showPWAButtons(false); });
  }
}
