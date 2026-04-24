/* public/js/app.js — SMCS shared logic */
'use strict';

// ─── THEME ───
function initTheme() {
  const saved = localStorage.getItem('smcs_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('smcs_theme', next);
  const btn = document.getElementById('theme-btn');
  if (btn) {
    btn.innerHTML = next === 'dark' ? '<i data-lucide="sun"></i>' : '<i data-lucide="moon"></i>';
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}
initTheme();

// ─── API ───
const BASE = window.API_BASE_URL || 'https://smcs-backend-2.onrender.com';
window.BASE = BASE;
let currentUser = null;
let socket = null;
let isOnline = navigator.onLine;
const QUEUE_KEY = 'smcs_offline_queue';

// ─── UTILS ───
(function() {
  const s = document.createElement('script');
  s.src = 'https://unpkg.com/lucide@latest';
  s.onload = () => { if (typeof lucide !== 'undefined') lucide.createIcons(); };
  document.head.appendChild(s);
})();

async function api(url, opts = {}) {
  const token = localStorage.getItem('smcs_token');
  const res = await fetch(BASE + url, {
    ...opts,
    credentials: 'include', // Important for sending/receiving cookies across domains
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// ─── AUTH ───
function getToken() { return localStorage.getItem('smcs_token'); }
function clearAuth() {
  localStorage.removeItem('smcs_token');
  localStorage.removeItem('smcs_user');
  localStorage.removeItem('smcs_offline_queue');
  sessionStorage.clear();
}

async function requireAuth(roles = []) {
  if (!getToken()) { window.location.href = '/login'; return null; }
  try {
    currentUser = await api('/api/auth/me');
    localStorage.setItem('smcs_user', JSON.stringify(currentUser));
    if (roles.length && !roles.includes(currentUser.role)) { window.location.href = '/dashboard'; return null; }
    applyUserTheme(currentUser);
    return currentUser;
  } catch { clearAuth(); window.location.href = '/login'; return null; }
}

function applyUserTheme(user) {
  if (user?.settings?.theme) {
    document.documentElement.setAttribute('data-theme', user.settings.theme);
    localStorage.setItem('smcs_theme', user.settings.theme);
  }
}

async function logout() {
  if (socket) socket.disconnect();
  try { await fetch(BASE + '/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch {}
  clearAuth();
  window.location.replace('/login');
}

// ─── OFFLINE QUEUE ───
function getQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } }
function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }

async function flushQueue() {
  const q = getQueue();
  if (!q.length) return;
  const remaining = [];
  for (const msg of q) {
    try { await api('/api/messages', { method:'POST', body:JSON.stringify(msg) }); }
    catch { remaining.push(msg); }
  }
  saveQueue(remaining);
  const sent = q.length - remaining.length;
  if (sent > 0) toast(`✅ ${sent} queued message${sent>1?'s':''} delivered`, '', 'success');
}

async function queueOrSend(to, text) {
  if (!isOnline) {
    const q = getQueue();
    q.push({ to, text });
    saveQueue(q);
    toast('📦 Offline', 'Message queued — will send when reconnected', 'warning');
    return { id: Date.now().toString(), from:currentUser?.id, to, text, timestamp:new Date().toISOString(), queued:true };
  }
  return api('/api/messages', { method:'POST', body:JSON.stringify({ to, text }) });
}

// ─── NETWORK ───
function setupNetwork() {
  const banner = document.querySelector('.net-banner');
  function update() {
    isOnline = navigator.onLine;
    if (!banner) return;
    if (!isOnline) {
      banner.innerHTML = '⚠️ You are offline — messages will be queued and sent automatically when reconnected';
      banner.className = 'net-banner show';
    } else {
      banner.innerHTML = '✅ Back online — sending queued messages...';
      banner.className = 'net-banner show back';
      flushQueue();
      setTimeout(() => banner.classList.remove('show'), 3500);
    }
    updateNetIndicator();
  }
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  if (!navigator.onLine) update();
}

function updateNetIndicator() {
  const el = document.getElementById('net-indicator');
  if (!el) return;
  el.innerHTML = isOnline ? '<i data-lucide="zap" style="color:#4ade80;width:16px;height:16px"></i>' : '<i data-lucide="zap-off" style="color:var(--muted);width:16px;height:16px"></i>';
  el.title = isOnline ? 'Online' : 'Offline';
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ─── SOCKET ───
function initSocket(userId) {
  if (typeof io === 'undefined') return;
  socket = io(window.SOCKET_URL || BASE);
  socket.emit('auth', userId);

  socket.on('new_message', msg => {
    document.dispatchEvent(new CustomEvent('smcs:message', { detail:msg }));
    updateMsgBadge(1);
  });
  socket.on('message_ack', msg => document.dispatchEvent(new CustomEvent('smcs:ack', { detail:msg })));
  socket.on('mission_update', m => document.dispatchEvent(new CustomEvent('smcs:mission', { detail:m })));
  socket.on('sos_alert', a => { showSOSPopup(a); document.dispatchEvent(new CustomEvent('smcs:sos', { detail:a })); });
  socket.on('user_status', d => {
    document.dispatchEvent(new CustomEvent('smcs:status', { detail:d }));
    document.querySelectorAll(`[data-uid="${d.userId}"]`).forEach(el => {
      el.className = d.status==='online' ? 'dot-online dot-pulse' : 'dot-offline';
    });
  });
  socket.on('typing', ({ fromName }) => document.dispatchEvent(new CustomEvent('smcs:typing', { detail:{ fromName } })));
  socket.on('stop_typing', () => document.dispatchEvent(new CustomEvent('smcs:stoptyping')));
  socket.on('notification', () => {
    loadNotifications();
  });
}

// ─── SIDEBAR ───
const ROLE_NAV = {
  soldier:   [{i:'home',l:'Dashboard',h:'/dashboard',k:'dashboard'},{i:'message-square',l:'Messages',h:'/chat',k:'chat',badge:true},{i:'target',l:'Missions',h:'/missions',k:'missions'},{i:'user',l:'Profile',h:'/profile',k:'profile'},{i:'settings',l:'Settings',h:'/settings',k:'settings'}],
  commander: [{i:'home',l:'Dashboard',h:'/dashboard',k:'dashboard'},{i:'message-square',l:'Messages',h:'/chat',k:'chat',badge:true},{i:'target',l:'Missions',h:'/missions',k:'missions'},{i:'alert-triangle',l:'SOS Alerts',h:'/dashboard#sos',k:'sos',badge2:true},{i:'user',l:'Profile',h:'/profile',k:'profile'},{i:'settings',l:'Settings',h:'/settings',k:'settings'}],
  family:    [{i:'home',l:'Dashboard',h:'/dashboard',k:'dashboard'},{i:'message-square',l:'Messages',h:'/chat',k:'chat',badge:true},{i:'users',l:'Contacts',h:'/users',k:'users'},{i:'user',l:'Profile',h:'/profile',k:'profile'},{i:'settings',l:'Settings',h:'/settings',k:'settings'}],
  admin:     [{i:'home',l:'Dashboard',h:'/dashboard',k:'dashboard'},{i:'message-square',l:'Messages',h:'/chat',k:'chat',badge:true},{i:'target',l:'Missions',h:'/missions',k:'missions'},{i:'users',l:'Users',h:'/users',k:'users'},{i:'shield',l:'Command Center',h:'/admin',k:'admin'},{i:'user',l:'Profile',h:'/profile',k:'profile'},{i:'settings',l:'Settings',h:'/settings',k:'settings'}],
};
const AV = { soldier:'av-green', commander:'av-gold', family:'av-blue', admin:'av-purple' };

function renderAvatarHTML(avatar, role, extraClass = '') {
  if (avatar && (avatar.startsWith('/') || avatar.startsWith('http'))) {
    return `<div class="avatar ${extraClass}"><img src="${avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="avatar"></div>`;
  }
  return `<div class="avatar ${extraClass} ${AV[role]||'av-green'}">${avatar || '?'}</div>`;
}

function renderSidebar(user, active) {
  const el = document.getElementById('sidebar'); if (!el) return;
  const items = ROLE_NAV[user.role] || ROLE_NAV.soldier;
  el.innerHTML = `
    <div class="sidebar-logo">
      <div class="logo-text">SM<span class="gold">CS</span></div>
      <div class="logo-sub">Secure Military Comms</div>
    </div>
    <a href="/profile" class="sidebar-profile">
      ${renderAvatarHTML(user.avatar, user.role, 'avatar-sm sp-avatar')}
      <div>
        <div class="sp-name">${user.name}</div>
        <div class="sp-role">${user.role}${user.unit?' · '+user.unit:''}</div>
      </div>
    </a>
    <nav class="sidebar-nav">
      <div class="nav-label">Navigation</div>
      ${items.map(item => `
        <a href="${item.h}" class="nav-link ${active===item.k?'active':''}">
          <span class="nav-icon"><i data-lucide="${item.i}"></i></span>
          <span>${item.l}</span>
          ${item.badge ? '<span class="nav-badge" id="msg-badge" style="display:none">0</span>' : ''}
          ${item.badge2 ? '<span class="nav-badge gold" id="sos-badge" style="display:none">!</span>' : ''}
        </a>`).join('')}
    </nav>
    <div class="sidebar-bottom">
      <button class="logout-link" onclick="logout()"><span class="nav-icon"><i data-lucide="log-out"></i></span> Logout</button>
      <div class="conn-row"><span class="conn-dot" id="conn-dot"></span><span id="conn-text">Connected</span></div>
    </div>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ─── TOPBAR ───
function renderTopbar(user, title, sub = '') {
  const el = document.getElementById('topbar'); if (!el) return;
  el.innerHTML = `
    <div>
      <div class="topbar-title">${title}</div>
      ${sub ? `<div class="topbar-sub">${sub}</div>` : ''}
    </div>
    <div class="topbar-right">
      <span id="net-indicator" title="Online" style="display:flex;align-items:center;cursor:default"></span>
      ${(user.role==='soldier'||user.role==='commander') ? `<button class="btn btn-sos btn-sm" onclick="sendSOSNow()"><i data-lucide="alert-triangle"></i> SOS</button>` : ''}
      <button class="theme-toggle" id="theme-btn" onclick="toggleTheme()" title="Toggle dark/light mode">
        ${document.documentElement.getAttribute('data-theme')==='dark'?'<i data-lucide="sun"></i>':'<i data-lucide="moon"></i>'}
      </button>
      <div style="position:relative">
        <button class="icon-btn" id="notif-btn" onclick="toggleNotifs()"><i data-lucide="bell"></i><span class="badge-dot" id="notif-badge"></span></button>
        <div class="drop-panel notif-panel" id="notif-panel">
          <div class="notif-head"><h4>Notifications</h4><div class="notif-actions"><button class="notif-action" onclick="markAllRead()">Mark read</button><button class="notif-action" onclick="clearNotifs()">Clear</button></div></div>
          <div class="notif-list" id="notif-list"><div class="empty-state" style="padding:28px"><div class="empty-text">No notifications</div></div></div>
        </div>
      </div>
      <div style="position:relative">
        <button class="icon-btn" style="width:auto;padding:0 12px 0 6px;gap:8px;border-radius:9px" onclick="toggleProfileDrop()">
          ${renderAvatarHTML(user.avatar, user.role, 'avatar-xs')}
          <div style="text-align:left"><div style="font-size:0.78rem;font-weight:600;color:var(--text);max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${user.name.split(' ')[0]}</div><div style="font-size:0.68rem;color:var(--muted);text-transform:capitalize">${user.role}</div></div>
          <span style="font-size:0.6rem;color:var(--muted)">▾</span>
        </button>
        <div class="drop-panel profile-drop" id="profile-drop">
          <div class="profile-drop-head">
            <div class="profile-drop-name">${user.name}</div>
            <div class="profile-drop-role">${user.role}${user.unit?' · '+user.unit:''}</div>
          </div>
          <a href="/profile" class="profile-drop-item"><i data-lucide="user"></i> My Profile</a>
          <a href="/settings" class="profile-drop-item"><i data-lucide="settings"></i> Settings</a>
          <a href="/settings?tab=password" class="profile-drop-item"><i data-lucide="lock"></i> Change Password</a>
          <div class="drop-divider"></div>
          <button class="profile-drop-item red" onclick="logout()"><i data-lucide="log-out"></i> Logout</button>
        </div>
      </div>
    </div>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
  updateNetIndicator();
  loadNotifications();
  document.addEventListener('click', e => {
    if (!e.target.closest('#notif-btn') && !e.target.closest('#notif-panel')) document.getElementById('notif-panel')?.classList.remove('open');
    if (!e.target.closest('[onclick="toggleProfileDrop()"]') && !e.target.closest('#profile-drop')) document.getElementById('profile-drop')?.classList.remove('open');
  });
}

function toggleNotifs() { document.getElementById('notif-panel')?.classList.toggle('open'); document.getElementById('profile-drop')?.classList.remove('open'); }
function toggleProfileDrop() { document.getElementById('profile-drop')?.classList.toggle('open'); document.getElementById('notif-panel')?.classList.remove('open'); }

// ─── NOTIFICATIONS ───
let notifList = [];
async function loadNotifications() {
  try { notifList = await api('/api/notifications'); renderNotifs(); } catch {}
}
function renderNotifs() {
  const el = document.getElementById('notif-list'); if (!el) return;
  const unread = notifList.filter(n => !n.is_read && !n.read).length;
  const badge = document.getElementById('notif-badge');
  if (badge) { badge.textContent = unread; badge.classList.toggle('show', unread>0); }
  if (!notifList.length) { el.innerHTML='<div class="empty-state" style="padding:28px"><div class="empty-text">No notifications</div></div>'; return; }
  const icons = { message:'message-square', mission:'target', danger:'alert-triangle', success:'check-circle', info:'info' };
  
  // Show only up to 4 newest notifications
  const displayList = notifList.slice(0, 4);
  
  el.innerHTML = displayList.map(n=>`
    <div class="notif-item${(n.read || n.is_read)?'':' unread'}" onclick="clickNotif('${n.id}','${n.href||''}')">
      <div class="notif-item-icon"><i data-lucide="${icons[n.type]||'info'}"></i></div>
      <div style="flex:1;min-width:0">
        <div class="notif-item-title">${n.title}</div>
        <div class="notif-item-body">${n.body}</div>
        <div class="notif-item-time">${timeAgo(n.created_at || n.createdAt)}</div>
      </div>
      ${!n.read && !n.is_read ? '<div class="notif-unread-dot"></div>':''}
    </div>`).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}
function addNotifToDOM(n) { notifList.unshift(n); renderNotifs(); }
function updateNotifBadge() { renderNotifs(); }
function clickNotif(id, href) { const n=notifList.find(x=>x.id===id); if(n) n.read=true; renderNotifs(); if(href) window.location.href=href; }
async function markAllRead() { try { await api('/api/notifications/read-all',{method:'POST'}); notifList.forEach(n=>n.read=true); renderNotifs(); } catch {} }
async function clearNotifs() { try { await api('/api/notifications/clear',{method:'DELETE'}); notifList=[]; renderNotifs(); } catch {} }

function updateMsgBadge(delta) {
  const el = document.getElementById('msg-badge'); if (!el) return;
  const cur = parseInt(el.textContent)||0;
  const next = cur + delta;
  el.textContent = next; el.style.display = next>0?'inline-flex':'none';
}

// ─── SOS ───
async function sendSOSNow() {
  if (!confirm('⚠️ Send SOS Emergency Alert to ALL commanders?\n\nOnly use in a genuine emergency.')) return;
  try {
    const a = await api('/api/sos',{method:'POST',body:JSON.stringify({location:currentUser?.unit||'Field',message:`EMERGENCY SOS from ${currentUser?.name}`})});
    if (socket) socket.emit('sos_broadcast', a);
    toast('🚨 SOS Alert Sent','All commanders notified','danger', 6000);
  } catch(e) { toast('Error', e.message,'danger'); }
}

function showSOSPopup(alert) {
  const d = document.createElement('div');
  d.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';
  d.innerHTML=`<div style="background:var(--surface);border-radius:16px;padding:36px;max-width:400px;width:90%;border-top:4px solid var(--danger);text-align:center;box-shadow:var(--shadow-lg)">
    <div style="margin-bottom:12px;color:var(--danger)"><i data-lucide="alert-triangle" style="width:44px;height:44px"></i></div>
    <h2 style="color:var(--danger);font-family:var(--font-display);margin-bottom:8px">SOS EMERGENCY</h2>
    <p style="font-weight:600;color:var(--text);margin-bottom:4px">${alert.senderName}</p>
    <p style="color:var(--muted);font-size:0.86rem;margin-bottom:4px">📍 ${alert.location} · ${alert.senderUnit}</p>
    <p style="color:var(--muted);font-size:0.86rem;margin-bottom:22px">${alert.message}</p>
    <button onclick="this.closest('[style]').remove()" style="background:var(--danger);color:#fff;border:none;padding:10px 28px;border-radius:8px;cursor:pointer;font-size:0.9rem;font-weight:600;font-family:inherit">Acknowledge</button>
  </div>`;
  document.body.appendChild(d);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ─── AUTH: handle ?expired=1 redirect from server ───
// If the server sent us here because our old token was invalid,
// clear the stale localStorage data so we don't get a redirect loop
(function () {
  if (window.location.search.includes('expired=1')) {
    localStorage.removeItem('smcs_token');
    localStorage.removeItem('smcs_user');
    // Clean the URL so it looks normal
    history.replaceState(null, '', '/login');
  }
})();

// ─── TOAST SYSTEM ───
// Icons for each toast type
const TOAST_ICONS = {
  success: 'check-circle',
  danger:  'x-circle',
  warning: 'alert-triangle',
  info:    'info',
};

// Get or create the toast stack container
function getToastStack() {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  return stack;
}

// Dismiss a toast with a slide-out animation
function dismissToast(el) {
  if (el.dataset.dismissed) return; // prevent double-dismiss
  el.dataset.dismissed = '1';
  el.classList.add('removing');
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

// Main toast() function — call this anywhere:
// toast('Title')
// toast('Title', 'Body message', 'success')
// toast('Title', 'Body message', 'danger', 6000)
function toast(title, body = '', type = 'info', ms = 4000) {
  const stack = getToastStack();

  // Build the toast element
  const el = document.createElement('div');
  el.className = `smcs-toast ${type}`;
  el.style.setProperty('--dur', ms + 'ms');

  el.innerHTML = `
    <div class="smcs-toast-inner">
      <div class="smcs-toast-icon"><i data-lucide="${TOAST_ICONS[type] || 'info'}" style="width:18px;height:18px"></i></div>
      <div class="smcs-toast-text">
        <div class="smcs-toast-title">${title}</div>
        ${body ? `<div class="smcs-toast-body">${body}</div>` : ''}
      </div>
      <button class="smcs-toast-close" title="Dismiss">✕</button>
    </div>
    <div class="smcs-toast-progress">
      <div class="smcs-toast-progress-bar"></div>
    </div>
  `;

  // Click anywhere on toast OR the × button to dismiss
  el.addEventListener('click', () => dismissToast(el));

  // Add to stack
  stack.appendChild(el);
  if (typeof lucide !== 'undefined') lucide.createIcons();

  // Auto-dismiss after ms
  const timer = setTimeout(() => dismissToast(el), ms);

  // If manually dismissed, cancel the timer
  el.querySelector('.smcs-toast-close').addEventListener('click', (e) => {
    e.stopPropagation();
    clearTimeout(timer);
    dismissToast(el);
  });
}

// ─── HELPBOT ───
const KB = [
  { keys:['send message','how to message','chat','messaging'], reply:'Go to 💬 Messages in the sidebar, select a contact, type your message and press Send. Offline messages are automatically queued and delivered when you reconnect.' },
  { keys:['offline','no internet','queue','queued'], reply:'SMCS has full offline support. When you lose connection, messages are saved locally and automatically delivered when internet returns. You\'ll see a red banner at the bottom.' },
  { keys:['sos','emergency','alert','help'], reply:'Press the 🚨 SOS button in the top bar to instantly alert all commanders with your name and location. Only use in genuine emergencies.' },
  { keys:['mission','missions','task','operation'], reply:'Missions are in 🎯 Missions. Commanders can create missions; soldiers and commanders can both post updates. Family members cannot access mission data.' },
  { keys:['family','family portal','relative'], reply:'Family members have a secure sandboxed portal. They can message soldiers, but cannot see missions, SOS alerts, or any operational data.' },
  { keys:['password','forgot password','reset','change password'], reply:'To reset your password: go to the Login page and click "Forgot password?" — a 6-digit code will be sent to your email. To change it: go to ⚙️ Settings → Security tab.' },
  { keys:['profile','edit profile','my info','update profile'], reply:'Go to 👤 Profile in the sidebar to view and edit your profile — name, email, bio, phone, and unit. Click "Edit Profile" to make changes.' },
  { keys:['dark mode','light mode','theme','appearance'], reply:'Click the 🌙 moon (or ☀️ sun) icon in the top bar to toggle between light and dark mode. Your preference is saved automatically.' },
  { keys:['notification','notifications'], reply:'Notifications appear in the 🔔 bell icon in the top bar. You\'ll get notified about new messages, mission updates, and SOS alerts.' },
  { keys:['role','roles','soldier','commander','admin'], reply:'SMCS has 4 roles: Soldier (chat + missions), Commander (+ create missions + SOS management), Family (secure chat only), Admin (full system access).' },
  { keys:['encryption','secure','security'], reply:'All messages use AES-256 / RSA-2048 end-to-end encryption. Even if intercepted, your messages cannot be read without the decryption key.' },
  { keys:['about','team','who made','developers'], reply:'SMCS was built by a team of 5 — Hundwa Maria (Project Lead), Zainab Elmukashfi (Systems Analyst), Rushago Ndayambaje Stacey (Backend), Rwigamba Ineza Wilson (Security), and Ineza Mbonigaba Christein (UI/UX). Visit the About page to learn more.' },
  { keys:['settings','preferences','language'], reply:'Go to ⚙️ Settings to manage your notification preferences, theme, language, and security (password change). Your settings are synced across sessions.' },
  { keys:['login','sign in','access'], reply:'Use your username and password to sign in. Demo accounts: soldier1, commander1, family1, admin — all use password123.' },
  { keys:['help','what can you do','commands'], reply:'I can help with: messaging, offline mode, SOS alerts, missions, family portal, passwords, profile, dark mode, notifications, roles, encryption, and more. What do you need?' },
];

function getBotReply(text) {
  const t = text.toLowerCase().trim();
  for (const entry of KB) {
    if (entry.keys.some(k => t.includes(k))) return entry.reply;
  }
  // Fallback with context-aware generic response
  if (t.length < 3) return 'Please ask a complete question — I\'m here to help with anything related to SMCS.';
  return `I'm not sure about "${text.length>40?text.slice(0,40)+'...':text}". I can help with: messaging, offline mode, SOS, missions, passwords, profile, dark mode, or notifications. What would you like to know?`;
}

function initHelpbot() {
  const fab = document.getElementById('hb-fab');
  const panel = document.getElementById('hb-panel');
  const msgs = document.getElementById('hb-msgs');
  const input = document.getElementById('hb-input');
  const send = document.getElementById('hb-send');
  if (!fab || !panel || !input || !send) return;

  fab.onclick = () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) setTimeout(() => input.focus(), 200);
  };

  function addMsg(text, who) {
    const d = document.createElement('div');
    d.className = who==='bot' ? 'bot-msg' : 'user-msg';
    d.textContent = text;
    msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight;
  }
  function showTyping() {
    const d = document.createElement('div');
    d.className='bot-msg'; d.id='hb-typing';
    d.innerHTML='<div class="typing-dots"><span></span><span></span><span></span></div>';
    msgs.appendChild(d); msgs.scrollTop=msgs.scrollHeight;
    return d;
  }
  function go() {
    const t = input.value.trim(); if (!t) return;
    addMsg(t,'user'); input.value='';
    const typing = showTyping();
    setTimeout(()=>{ typing.remove(); addMsg(getBotReply(t),'bot'); }, 600+Math.random()*500);
  }

  send.addEventListener('click', go);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  document.querySelectorAll('.hchip').forEach(c => {
    c.onclick = () => { input.value = c.textContent; go(); };
  });
}

// ─── UTILS ───
function timeAgo(dateVal) {
  if (!dateVal) return '';
  const parsed = new Date(dateVal).getTime();
  if (isNaN(parsed)) return '';
  const diff = Date.now() - parsed;
  const m = Math.floor(diff/60000);
  if (m<1) return 'Just now'; if (m<60) return `${m}m ago`;
  const h = Math.floor(m/60); if (h<24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}

function togPw(id) { const el=document.getElementById(id); if(el) el.type=el.type==='password'?'text':'password'; }

function pwStrength(pw, barId) {
  const bar = document.getElementById(barId); if (!bar) return;
  if (!pw) { bar.className='pw-strength'; return; }
  const strong = pw.length>=8 && /[A-Z]/.test(pw) && /[0-9]/.test(pw);
  bar.className = 'pw-strength ' + (strong?'strong':pw.length>=6?'ok':'weak');
}

document.addEventListener('DOMContentLoaded', () => {
  setupNetwork();
  initHelpbot();
});
