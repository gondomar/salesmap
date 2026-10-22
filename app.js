import { GOOGLE_MAPS_API_KEY, FIREBASE_CONFIG, START_LOCATION } from './config.js';

const STATUSES = [
  { id: 'client', label: 'Client', color: '#16a34a' },
  { id: 'interested', label: 'Callback', color: '#2563eb' },
  { id: 'not_home', label: 'Not home', color: '#f59e0b' },
  { id: 'refused', label: 'Refused', color: '#dc2626' },
  { id: 'no_soliciting', label: 'No soliciting', color: '#6b7280' },
];
const statusById = Object.fromEntries(STATUSES.map(s => [s.id, s]));
const LOOKING_UP = 'Looking up address…';

const $ = id => document.getElementById(id);
const houses = new Map();
const markers = new Map();
const APP_URL = 'https://gondomar.github.io/salesmap/';
let map, geocoder, store, selected = null, tempMarker = null, meMarker = null, searchMarker = null, lastPos = null;

// ---------- UI helpers ----------
let toastTimer;
function toast(msg, ms = 2000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function fatal(msg) {
  $('fatalMsg').textContent = msg;
  $('fatal').classList.remove('hidden');
}

const fmtDate = ms => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// ---------- Data stores ----------
function localStore() {
  const KEY = 'salesmap.houses';
  const read = () => JSON.parse(localStorage.getItem(KEY) || '{}');
  const write = all => { localStorage.setItem(KEY, JSON.stringify(all)); listener?.(all); };
  let listener;
  return {
    mode: 'local',
    user: '',
    subscribe(cb) { listener = cb; cb(read()); },
    save(id, data) {
      const all = read();
      id ||= crypto.randomUUID();
      all[id] = { ...all[id], ...data };
      write(all);
      return id;
    },
    remove(id) { const all = read(); delete all[id]; write(all); },
    signOut() {},
  };
}

async function firebaseStore() {
  const V = '10.12.2';
  const [{ initializeApp }, fa, fs] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  const app = initializeApp(FIREBASE_CONFIG);
  const auth = fa.getAuth(app);
  // Offline cache: marks made with no signal are saved and synced once you're back online.
  const db = fs.initializeFirestore(app, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
  });
  const col = fs.collection(db, 'houses');

  const user = await new Promise(resolve => {
    fa.onAuthStateChanged(auth, u => {
      $('login').classList.toggle('hidden', !!u);
      if (u) resolve(u);
    });
    $('loginForm').onsubmit = async e => {
      e.preventDefault();
      $('loginError').textContent = '';
      try {
        await fa.signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value);
      } catch (err) {
        $('loginError').textContent = err.code === 'auth/invalid-credential' ? 'Wrong email or password.' : err.message;
      }
    };
  });

  // Writes are not awaited: with the offline cache they resolve only after reaching the server.
  const onErr = err => toast(`Sync error: ${err.code || err.message}`, 4000);
  return {
    mode: 'cloud',
    user: user.email,
    subscribe(cb) {
      fs.onSnapshot(col, snap => {
        const all = {};
        snap.forEach(d => { all[d.id] = d.data(); });
        cb(all);
      }, onErr);
    },
    save(id, data) {
      const ref = id ? fs.doc(col, id) : fs.doc(col);
      fs.setDoc(ref, data, { merge: true }).catch(onErr);
      return ref.id;
    },
    remove(id) { fs.deleteDoc(fs.doc(col, id)).catch(onErr); },
    async signOut() { await fa.signOut(auth); location.reload(); },
  };
}

// ---------- Map ----------
function loadGoogleMaps(key) {
  return new Promise((resolve, reject) => {
    window.__gmReady = resolve;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__gmReady`;
    s.async = true;
    s.onerror = () => reject(new Error('Could not load Google Maps. Check your internet connection.'));
    document.head.append(s);
  });
}

const pinIcon = status => ({
  path: google.maps.SymbolPath.CIRCLE,
  scale: 11,
  fillColor: statusById[status]?.color || '#ffffff',
  fillOpacity: 1,
  strokeColor: status ? '#ffffff' : '#111827',
  strokeWeight: 2.5,
});

function render(all) {
  for (const [id, m] of markers) {
    if (!all[id]) { m.setMap(null); markers.delete(id); }
  }
  houses.clear();
  for (const [id, h] of Object.entries(all)) {
    houses.set(id, h);
    let m = markers.get(id);
    if (!m) {
      m = new google.maps.Marker({ map, position: { lat: h.lat, lng: h.lng } });
      m.addListener('click', () => openExisting(id));
      markers.set(id, m);
    }
    m.setIcon(pinIcon(h.status));
  }
  if (selected?.id) houses.has(selected.id) ? refreshSheetStatus() : closeSheet();
}

function startLocation() {
  if (!navigator.geolocation) return;
  let centered = false;
  navigator.geolocation.watchPosition(p => {
    lastPos = { lat: p.coords.latitude, lng: p.coords.longitude };
    if (!meMarker) {
      meMarker = new google.maps.Marker({
        map, position: lastPos, clickable: false, zIndex: 9999,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#1a73e8', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 },
      });
    } else meMarker.setPosition(lastPos);
    if (!centered) { centered = true; map.setCenter(lastPos); map.setZoom(19); }
  }, err => {
    if (err.code === err.PERMISSION_DENIED) toast('Location is off. Enable it to see where you are.', 4000);
  }, { enableHighAccuracy: true, maximumAge: 5000 });
}

// ---------- Sheet ----------
function pickAddress(results) {
  const best = results.find(r => r.types.includes('street_address') || r.types.includes('premise'))
    || results.find(r => !r.types.includes('plus_code')) || results[0];
  return best ? best.formatted_address.replace(/, USA$/, '') : 'Unknown address';
}

function openNew(latLng) {
  const pos = latLng.toJSON();
  tempMarker ||= new google.maps.Marker({ clickable: false, icon: pinIcon(null), zIndex: 9000 });
  tempMarker.setPosition(pos);
  tempMarker.setMap(map);
  selected = { id: null, ...pos, address: LOOKING_UP };
  const sel = selected;
  openSheet();
  geocoder.geocode({ location: pos })
    .then(({ results }) => pickAddress(results))
    .catch(() => 'Unknown address')
    .then(address => {
      sel.address = address;
      if (sel.id) store.save(sel.id, { address });
      if (selected === sel) $('sheetAddress').textContent = address;
    });
}

function openExisting(id) {
  tempMarker?.setMap(null);
  selected = { id, ...houses.get(id) };
  openSheet();
}

function openSheet() {
  const h = selected.id ? houses.get(selected.id) : {};
  $('sheetAddress').textContent = selected.address;
  $('fName').value = h.name || '';
  $('fPhone').value = h.phone || '';
  $('fNotes').value = h.notes || '';
  $('details').open = !!(h.name || h.phone || h.notes);
  $('deleteBtn').classList.toggle('hidden', !selected.id);
  refreshSheetStatus();
  $('sheet').classList.remove('hidden');
  $('hint').classList.add('hidden');
  $('menu').classList.add('hidden');
}

function refreshSheetStatus() {
  const h = selected.id ? houses.get(selected.id) : null;
  if (h?.address && selected.address === LOOKING_UP) $('sheetAddress').textContent = selected.address = h.address;
  const knocks = h?.history?.length || 0;
  $('sheetMeta').textContent = h
    ? `${knocks} knock${knocks === 1 ? '' : 's'} · last ${fmtDate(h.updatedAt)}`
    : 'New house: tap a status to save';
  $('statusButtons').replaceChildren(...STATUSES.map(s => {
    const b = document.createElement('button');
    b.className = 'status-btn' + (h?.status === s.id ? ' active' : '');
    b.style.background = s.color;
    b.textContent = s.label;
    b.onclick = () => setStatus(s.id);
    return b;
  }));
  $('deleteBtn').classList.toggle('hidden', !h);
  updateSaveBtn();
}

function updateSaveBtn() {
  const h = (selected?.id && houses.get(selected.id)) || {};
  const f = detailFields();
  const dirty = ['name', 'phone', 'notes'].some(k => f[k] !== (h[k] || ''));
  $('saveBtn').disabled = !dirty;
  $('saveBtn').textContent = dirty || !selected?.id ? 'Save details' : 'Saved';
}

function closeSheet() {
  selected = null;
  tempMarker?.setMap(null);
  $('sheet').classList.add('hidden');
  $('hint').classList.remove('hidden');
}

const detailFields = () => ({
  name: $('fName').value.trim(),
  phone: $('fPhone').value.trim(),
  notes: $('fNotes').value.trim(),
});

function setStatus(status) {
  const now = Date.now();
  const prev = selected.id ? houses.get(selected.id) : null;
  const data = {
    ...detailFields(),
    status,
    updatedAt: now,
    updatedBy: store.user,
    history: [...(prev?.history || []), { status, at: now }],
  };
  if (!prev) {
    Object.assign(data, {
      lat: selected.lat,
      lng: selected.lng,
      address: selected.address === LOOKING_UP ? '' : selected.address,
      createdAt: now,
    });
  }
  selected.id = store.save(selected.id, data);
  tempMarker?.setMap(null);
  if (houses.has(selected.id)) refreshSheetStatus();
  toast(`Marked: ${statusById[status].label}`);
}

function saveDetails() {
  if (!selected.id) return toast('Pick a status first');
  store.save(selected.id, { ...detailFields(), updatedAt: Date.now() });
  toast('Saved');
  updateSaveBtn();
}

function deleteHouse() {
  if (!selected.id || !confirm('Delete this pin?')) return;
  store.remove(selected.id);
  closeSheet();
}

function exportCsv() {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const order = id => STATUSES.findIndex(s => s.id === id);
  const sorted = [...houses.values()].sort((a, b) => order(a.status) - order(b.status));
  const rows = [['Status', 'Address', 'Name', 'Phone', 'Notes', 'Knocks', 'Last updated', 'Updated by', 'Lat', 'Lng']];
  for (const h of sorted) {
    rows.push([statusById[h.status]?.label, h.address, h.name, h.phone, h.notes, h.history?.length || 0,
      h.updatedAt ? new Date(h.updatedAt).toLocaleString() : '', h.updatedBy, h.lat, h.lng]);
  }
  const blob = new Blob([rows.map(r => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `salesmap-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Address search ----------
function openSearch() {
  closeSheet();
  $('searchBar').classList.remove('hidden');
  $('searchInput').focus();
}

function closeSearch() {
  $('searchBar').classList.add('hidden');
  $('searchInput').blur();
}

async function searchAddress(query) {
  if (!query.trim()) return;
  try {
    const { results } = await geocoder.geocode({ address: query, bounds: map.getBounds(), region: 'us' });
    const r = results[0];
    const loc = r.geometry.location;
    searchMarker ||= new google.maps.Marker({
      clickable: false, zIndex: 8000,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 22, fillOpacity: 0, strokeColor: '#facc15', strokeWeight: 4 },
    });
    searchMarker.setPosition(loc);
    searchMarker.setMap(map);
    map.panTo(loc);
    map.setZoom(20);
    closeSearch();
    toast(r.geometry.location_type === 'APPROXIMATE'
      ? `Closest match: ${r.formatted_address.replace(/, USA$/, '')}`
      : 'Tap the house inside the yellow circle to mark it', 4000);
  } catch {
    toast('Address not found. Try adding the city.', 3000);
  }
}

// ---------- Share instructions ----------
function openShare() {
  $('shareUrl').textContent = APP_URL;
  $('share').classList.remove('hidden');
}

// ---------- Startup ----------
async function main() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!GOOGLE_MAPS_API_KEY) return fatal('Setup needed: add your Google Maps API key to config.js (see README.md).');

  const storePromise = FIREBASE_CONFIG ? firebaseStore() : Promise.resolve(localStore());
  await loadGoogleMaps(GOOGLE_MAPS_API_KEY);
  const [{ Map }, , { Geocoder }] = await Promise.all(['maps', 'marker', 'geocoding'].map(l => google.maps.importLibrary(l)));

  map = new Map($('map'), {
    center: START_LOCATION,
    zoom: 5,
    mapTypeId: localStorage.getItem('mapType') || 'hybrid',
    gestureHandling: 'greedy',
    clickableIcons: false,
    disableDefaultUI: true,
    tilt: 0,
  });
  geocoder = new Geocoder();
  map.addListener('click', e => { searchMarker?.setMap(null); closeSearch(); openNew(e.latLng); });
  startLocation();

  for (const id of ['fName', 'fPhone', 'fNotes']) $(id).addEventListener('input', updateSaveBtn);
  $('searchForm').onsubmit = e => { e.preventDefault(); searchAddress($('searchInput').value); };
  $('searchClose').onclick = closeSearch;
  $('shareClose').onclick = () => $('share').classList.add('hidden');
  $('shareCopy').onclick = async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'SalesMap', url: APP_URL });
      else { await navigator.clipboard.writeText(APP_URL); toast('Link copied'); }
    } catch {}
  };

  $('locateBtn').onclick = () => {
    if (!lastPos) return toast('Waiting for your location…');
    map.panTo(lastPos);
    map.setZoom(19);
  };
  $('sheetClose').onclick = closeSheet;
  $('saveBtn').onclick = saveDetails;
  $('deleteBtn').onclick = deleteHouse;
  $('menuBtn').onclick = () => $('menu').classList.toggle('hidden');
  $('menu').onclick = e => {
    const action = e.target.dataset.action;
    $('menu').classList.add('hidden');
    if (action === 'maptype') {
      const t = map.getMapTypeId() === 'roadmap' ? 'hybrid' : 'roadmap';
      map.setMapTypeId(t);
      localStorage.setItem('mapType', t);
    } else if (action === 'search') openSearch();
    else if (action === 'share') openShare();
    else if (action === 'export') exportCsv();
    else if (action === 'signout') store.signOut();
  };

  store = await storePromise;
  if (store.mode === 'local') {
    $('signoutBtn').classList.add('hidden');
    toast('Local mode: pins are saved on this device only', 4000);
  }
  store.subscribe(render);
}

main().catch(err => fatal(err.message));
