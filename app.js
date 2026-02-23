/* ─── tiny router helpers ─────────────────────────────────────────────────── */
const $ = (sel) => document.querySelector(sel);

// Hash-based routing: #add, #out, #status, #edit?sku=XXX, '' = dashboard
function getRoute() {
  const hash = location.hash.replace(/^#/, '');
  const [page, qs] = hash.split('?');
  const params = new URLSearchParams(qs || '');
  return { page: page || '', params };
}

function navigate(page, params = {}) {
  const qs      = new URLSearchParams(params).toString();
  const newHash = qs ? `${page}?${qs}` : page;
  // אם ה-hash לא משתנה, hashchange לא ייורה — קוראים ל-render ישירות
  if (location.hash.replace(/^#/, '') === newHash) {
    render();
  } else {
    location.hash = newHash;
    // hashchange יפעיל את render אוטומטית
  }
}

/* ─── app state ───────────────────────────────────────────────────────────── */
const store = {
  session:   null,
  catalog:   null,
  movements: [],
  drafts:    { add: [], out: [] },
};

const LS = {
  session:     'stock.session.v1',
  catalog:     'stock.catalog.v1',
  catalogTs:   'stock.catalog.ts.v1',
  draftAdd:    'stock.draft.add.v1',
  draftOut:    'stock.draft.out.v1',
  movements:   'stock.movements.v1',
  movementsTs: 'stock.movements.ts.v1',
};

/* ─── boot ────────────────────────────────────────────────────────────────── */
init();

async function init() {
  loadSession();
  loadDrafts();
  wireTopbar();
  window.addEventListener('hashchange', render);
  await ensureCatalogLoaded();
  render();
}

function wireTopbar() {
  $('#logoutBtn').addEventListener('click', () => {
    clearSession();
    clearDrafts();
    navigate('');
  });
}

/* ─── render dispatcher ───────────────────────────────────────────────────── */
function render() {
  const app = $('#app');
  updateUserBadge();

  if (!store.session) {
    app.innerHTML = loginView();
    bindLogin();
    return;
  }

  const { page, params } = getRoute();

  if (page === 'add') {
    app.innerHTML = addOutView('add');
    bindAddOut('add');
    return;
  }
  if (page === 'out') {
    app.innerHTML = addOutView('out');
    bindAddOut('out');
    return;
  }
  if (page === 'status') {
    app.innerHTML = statusView();
    bindStatus(params.get('sku') || '');
    return;
  }
  if (page === 'edit') {
    app.innerHTML = productEditView(params.get('sku') || '');
    bindProductEdit(params.get('sku') || '');
    return;
  }

  app.innerHTML = dashboardView();
  bindDashboard();
}

function updateUserBadge() {
  $('#userBadge').textContent = store.session
    ? `${store.session.userName} · ${store.session.role}` : '';
}

/* ─── session ─────────────────────────────────────────────────────────────── */
function loadSession()  { try { store.session = JSON.parse(localStorage.getItem(LS.session) || 'null'); } catch { store.session = null; } }
function saveSession()  { localStorage.setItem(LS.session, JSON.stringify(store.session)); }
function clearSession() { store.session = null; localStorage.removeItem(LS.session); }

/* ─── drafts ──────────────────────────────────────────────────────────────── */
function loadDrafts() {
  try { store.drafts.add = JSON.parse(localStorage.getItem(LS.draftAdd) || '[]'); } catch { store.drafts.add = []; }
  try { store.drafts.out = JSON.parse(localStorage.getItem(LS.draftOut) || '[]'); } catch { store.drafts.out = []; }
}
function saveDrafts() {
  localStorage.setItem(LS.draftAdd, JSON.stringify(store.drafts.add));
  localStorage.setItem(LS.draftOut, JSON.stringify(store.drafts.out));
}
function clearDrafts() {
  store.drafts = { add: [], out: [] };
  localStorage.removeItem(LS.draftAdd);
  localStorage.removeItem(LS.draftOut);
}

/* ─── catalog ─────────────────────────────────────────────────────────────── */
async function ensureCatalogLoaded() {
  const cached = localStorage.getItem(LS.catalog);
  const ts     = Number(localStorage.getItem(LS.catalogTs) || '0');
  if (cached) {
    try {
      store.catalog = reviveCatalog(JSON.parse(cached));
      if (Date.now() - ts > 30 * 60 * 1000) refreshCatalog().catch(() => {});
      await ensureMovementsLoaded();
      return;
    } catch {}
  }
  await refreshCatalog();
  await ensureMovementsLoaded();
}

async function refreshCatalog() {
  const stripBom = (s) => s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
  const [productsCsv, barcodesCsv] = await Promise.all([
    fetchText(window.CONFIG.PRODUCTS_CSV),
    fetchText(window.CONFIG.BARCODES_CSV),
  ]);
  const products      = parseCsv(stripBom(productsCsv));
  const barcodes      = parseCsv(stripBom(barcodesCsv));
  const productsBySku = new Map();
  const skuByBarcode  = new Map();
  const barcodesBySku = new Map();

  for (const p of products) {
    const sku = String(p['מק"ט'] || '').trim();
    if (sku) productsBySku.set(sku, p);
  }
  for (const b of barcodes) {
    const sku  = String(b['מק"ט מוצר'] || '').trim();
    const code = String(b['ברקוד']      || '').trim();
    if (!sku || !code) continue;
    skuByBarcode.set(code, sku);
    if (!barcodesBySku.has(sku)) barcodesBySku.set(sku, []);
    barcodesBySku.get(sku).push(code);
  }
  store.catalog = { products, barcodes, productsBySku, skuByBarcode, barcodesBySku };
  persistCatalog();
}

function persistCatalog() {
  localStorage.setItem(LS.catalog, JSON.stringify({
    products:     store.catalog.products,
    barcodes:     store.catalog.barcodes,
    productsBySku: [...store.catalog.productsBySku.entries()],
    skuByBarcode:  [...store.catalog.skuByBarcode.entries()],
    barcodesBySku: [...store.catalog.barcodesBySku.entries()],
  }));
  localStorage.setItem(LS.catalogTs, String(Date.now()));
}

function reviveCatalog(obj) {
  return {
    products:     obj.products  || [],
    barcodes:     obj.barcodes  || [],
    productsBySku: new Map(obj.productsBySku || []),
    skuByBarcode:  new Map(obj.skuByBarcode  || []),
    barcodesBySku: new Map(obj.barcodesBySku || []),
  };
}

/* ─── movements ───────────────────────────────────────────────────────────── */
async function ensureMovementsLoaded() {
  const cached = localStorage.getItem(LS.movements);
  const ts     = Number(localStorage.getItem(LS.movementsTs) || '0');
  if (cached) {
    try {
      store.movements = JSON.parse(cached);
      if (Date.now() - ts > 15 * 60 * 1000) refreshMovements().catch(() => {});
      return;
    } catch {}
  }
  await refreshMovements().catch(() => { store.movements = []; });
}

async function refreshMovements() {
  if (!store.session?.token) return;
  const data = await apiGet({ action: 'movements_list', token: store.session.token });
  store.movements = Array.isArray(data.movements) ? data.movements : [];
  localStorage.setItem(LS.movements,   JSON.stringify(store.movements));
  localStorage.setItem(LS.movementsTs, String(Date.now()));
}

/* ─── API ─────────────────────────────────────────────────────────────────── */
async function apiPost(payload) {
  const form = new URLSearchParams();
  Object.entries(payload).forEach(([k, v]) => form.set(k, v == null ? '' : String(v)));
  const res  = await fetch(window.CONFIG.API_URL, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'API error');
  return data;
}

async function apiGet(params) {
  const url = new URL(window.CONFIG.API_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v == null ? '' : String(v)));
  const res  = await fetch(url.toString(), { cache: 'no-store' });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'API error');
  return data;
}

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Fetch failed: ' + url);
  return res.text();
}

/* ─── CSV parser ──────────────────────────────────────────────────────────── */
function parseCsv(text) {
  const rows = [];
  let i = 0, f = '', row = [], q = false;
  const pushField = () => { row.push(f); f = ''; };
  const pushRow   = () => { rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i+1] === '"') { f += '"'; i += 2; continue; }
      if (c === '"') { q = false; i++; continue; }
      f += c; i++; continue;
    }
    if (c === '"') { q = true;  i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\n') { pushField(); pushRow(); i++; continue; }
    if (c === '\r') { i++; continue; }
    f += c; i++;
  }
  pushField();
  if (row.length > 1 || row[0] !== '') pushRow();
  const headers = (rows.shift() || []).map(h => String(h).trim());
  return rows
    .filter(r => r.some(x => String(x).trim()))
    .map(r => { const o = {}; headers.forEach((h, i) => o[h] = r[i] ?? ''); return o; });
}

/* ═══════════════════════════════════════════════════════════════════════════
   VIEWS
   ═══════════════════════════════════════════════════════════════════════════ */

function loginView() {
  return `
  <section class="card">
    <div class="h1">כניסה למערכת</div>
    <div class="row">
      <div class="col"><label>ID משתמש</label><input id="loginUserId" class="input"/></div>
      <div class="col"><label>קוד</label><input id="loginCode" class="input" type="password"/></div>
    </div>
    <div class="row" style="margin-top:12px">
      <button id="loginBtn" class="btn btn-primary">התחבר</button>
      <span id="loginErr" class="small feedback-err"></span>
    </div>
  </section>`;
}

function dashboardView() {
  const ts     = Number(localStorage.getItem(LS.catalogTs) || '0');
  const ageMin = ts ? Math.max(0, Math.floor((Date.now() - ts) / 60000)) : null;
  return `
  <section class="card">
    <div class="h1">תפריט ראשי</div>
    <div class="row">
      <button class="btn btn-primary" onclick="navigate('add')">➕ הוספה למלאי</button>
      <button class="btn btn-primary" onclick="navigate('out')">➖ הוצאה מהמלאי</button>
      <button class="btn btn-primary" onclick="navigate('status')">🔍 מצב מוצר</button>
    </div>
    <div class="row" style="margin-top:12px">
      <span class="pill">קטלוג עודכן לפני: ${ageMin == null ? 'לא ידוע' : `${ageMin} דק׳`}</span>
      <button id="refreshCatalogBtn" class="btn">🔄 רענון קטלוג</button>
      <span id="refreshMsg" class="small"></span>
    </div>
  </section>

  <section class="card">
    <div class="h1">מוצרים</div>
    <div class="row">
      <div class="col"><label>חיפוש (שם / מק"ט)</label><input id="q" class="input" placeholder="הקלד לחיפוש..."/></div>
      <div class="col"><label>מותג</label><select id="brand" class="input"><option value="">הכול</option></select></div>
      <div class="col"><label>ספק</label><select id="vendor" class="input"><option value="">הכול</option></select></div>
      <div class="col"><label>פסח</label>
        <select id="pesach" class="input">
          <option value="">הכול</option>
          <option value="קטניות">קטניות</option>
          <option value="ללא קטניות">ללא קטניות</option>
          <option value="חמץ">חמץ</option>
        </select>
      </div>
    </div>
    <div class="row" style="margin-top:8px">
      <div class="col"><label>יציאות מ-</label><input id="dateFrom" type="date" class="input"/></div>
      <div class="col"><label>עד</label><input id="dateTo" type="date" class="input"/></div>
      <button id="dateRangeSearchBtn" class="btn">חפש בטווח</button>
      <div class="col"><label>מיון</label>
        <select id="sort" class="input">
          <option value="name_asc">שם (א-ת)</option>
          <option value="name_desc">שם (ת-א)</option>
          <option value="stock_desc">מלאי ↓</option>
          <option value="stock_asc">מלאי ↑</option>
          <option value="vendor_asc">ספק</option>
          <option value="brand_asc">מותג</option>
          <option value="out_desc">יצא בטווח ↓</option>
        </select>
      </div>
    </div>
    <div style="overflow:auto;margin-top:10px">
      <table class="table" id="productsTable">
        <thead><tr>
          <th>תמונה</th><th>מק"ט</th><th>שם</th><th>סה"כ</th>
          <th>יצא בטווח</th><th>מותג</th><th>ספק</th><th>פסח</th><th></th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </section>`;
}

function addOutView(mode) {
  const label      = mode === 'add' ? 'הוספה למלאי' : 'הוצאה מהמלאי';
  const draftCount = mode === 'add' ? store.drafts.add.length : store.drafts.out.length;
  return `
  <section class="card">
    <div class="h1">${label}</div>
    <div class="row">
      <div class="col"><label>סרוק / הכנס ברקוד</label><input id="barcodeInput" class="input" autocomplete="off" inputmode="numeric"/></div>
      <div style="display:flex;gap:8px;align-items:flex-end">
        <button id="findBtn" class="btn btn-primary">חיפוש</button>
        <button id="summaryBtn" class="btn">סיכום (${draftCount})</button>
        <button class="btn btn-ghost" onclick="navigate('')">← חזרה</button>
      </div>
    </div>
    <div id="feedbackMsg" style="min-height:22px;margin-top:6px;font-size:13px;font-weight:600"></div>
    <div id="productPane" style="display:none;margin-top:10px"></div>
  </section>
  <section id="summaryPane" class="card" style="display:none"></section>`;
}

function statusView() {
  return `
  <section class="card">
    <div class="h1">מצב מוצר</div>
    <div class="row">
      <div class="col"><label>סרוק / הכנס ברקוד</label><input id="statusBarcode" class="input" inputmode="numeric"/></div>
      <div style="display:flex;gap:8px;align-items:flex-end">
        <button id="statusFind" class="btn btn-primary">חיפוש</button>
        <button class="btn btn-ghost" onclick="navigate('')">← חזרה</button>
      </div>
    </div>
    <div id="statusOut" style="margin-top:10px"></div>
  </section>`;
}

function productEditView(sku) {
  return `
  <section class="card">
    <div class="h1">עריכת מוצר</div>
    <div class="small" style="margin-bottom:10px">מק"ט: <span class="kbd">${escHtml(sku || '-')}</span></div>
    <div id="productEditPane"></div>
    <div class="row" style="margin-top:14px">
      <button class="btn btn-ghost" onclick="navigate('')">← חזרה לרשימה</button>
    </div>
  </section>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   BIND — login
   ═══════════════════════════════════════════════════════════════════════════ */
function bindLogin() {
  $('#logoutBtn').style.display = 'none';
  const doLogin = async () => {
    const userId = $('#loginUserId').value.trim();
    const code   = $('#loginCode').value.trim();
    $('#loginErr').textContent = 'מתחבר...';
    try {
      const data = await apiPost({ action: 'auth_login', userId, code });
      store.session = { userId: data.userId, userName: data.userName, role: data.role, token: data.token };
      saveSession();
      await ensureMovementsLoaded();
      navigate('');
    } catch (err) {
      $('#loginErr').textContent = 'שגיאה: ' + err.message;
    }
  };
  $('#loginBtn').onclick = doLogin;
  $('#loginCode').addEventListener('keydown', e => e.key === 'Enter' && doLogin());
  $('#loginUserId').addEventListener('keydown', e => e.key === 'Enter' && $('#loginCode').focus());
  $('#loginUserId').focus();
}

/* ═══════════════════════════════════════════════════════════════════════════
   BIND — dashboard
   ═══════════════════════════════════════════════════════════════════════════ */
function bindDashboard() {
  $('#logoutBtn').style.display = '';
  let dateRangeActive = false;

  $('#refreshCatalogBtn').onclick = async () => {
    const btn = $('#refreshCatalogBtn');
    btn.textContent = 'מרענן...';
    btn.disabled = true;
    try {
      await refreshCatalog();
      await refreshMovements().catch(() => {});
      $('#refreshMsg').textContent = 'עודכן ✓';
      setTimeout(() => { if ($('#refreshMsg')) $('#refreshMsg').textContent = ''; }, 3000);
      render();
    } catch (err) {
      $('#refreshMsg').textContent = 'שגיאה: ' + err.message;
    } finally {
      btn.textContent = '🔄 רענון קטלוג';
      btn.disabled = false;
    }
  };

  fillSelect($('#brand'),  uniq(store.catalog.products.map(p => String(p['מותג'] || '').trim()).filter(Boolean)).sort((a,b) => a.localeCompare(b,'he')));
  fillSelect($('#vendor'), uniq(store.catalog.products.map(p => String(p['ספק']  || '').trim()).filter(Boolean)).sort((a,b) => a.localeCompare(b,'he')));

  const apply = () => renderProductsTable(filterAndSortProducts({
    q:        $('#q').value.trim(),
    brand:    $('#brand').value,
    vendor:   $('#vendor').value,
    pesach:   $('#pesach').value,
    sort:     $('#sort').value,
    dateFrom: dateRangeActive ? $('#dateFrom').value : '',
    dateTo:   dateRangeActive ? $('#dateTo').value   : '',
  }));

  $('#dateRangeSearchBtn').onclick = () => { dateRangeActive = true; apply(); };

  ['dateFrom','dateTo'].forEach(id => {
    $('#'+id).addEventListener('change', () => {
      if (!$('#dateFrom').value && !$('#dateTo').value) { dateRangeActive = false; apply(); }
    });
  });

  ['q','brand','vendor','pesach','sort'].forEach(id => {
    const el = $('#'+id);
    el.addEventListener('input',  apply);
    el.addEventListener('change', apply);
  });

  apply();
}

function filterAndSortProducts({ q, brand, vendor, pesach, sort, dateFrom, dateTo }) {
  if (!store.catalog?.products) return [];
  let rows = store.catalog.products.filter(p => String(p['מק"ט'] || '').trim());

  if (q) {
    const t = q.toLowerCase();
    rows = rows.filter(p =>
      String(p['שם מוצר'] || '').toLowerCase().includes(t) ||
      String(p['מק"ט']    || '').toLowerCase().includes(t));
  }
  if (brand)  rows = rows.filter(p => String(p['מותג'] || '').trim() === brand);
  if (vendor) rows = rows.filter(p => String(p['ספק']  || '').trim() === vendor);
  if (pesach) rows = rows.filter(p => String(p['פסח']  || '').trim() === pesach);

  const outBySku = computeOutBySku(dateFrom, dateTo);
  const stockNum = p => Number(String(p['סה"כ במלאי'] || '0').replace(',','.')) || 0;
  rows.forEach(p => { p.__outQty = outBySku.get(String(p['מק"ט']||'').trim()) || 0; });

  rows.sort((a, b) => {
    switch (sort) {
      case 'name_desc':  return String(b['שם מוצר']||'').localeCompare(String(a['שם מוצר']||''),'he');
      case 'stock_desc': return stockNum(b) - stockNum(a);
      case 'stock_asc':  return stockNum(a) - stockNum(b);
      case 'vendor_asc': return String(a['ספק']||'').localeCompare(String(b['ספק']||''),'he');
      case 'brand_asc':  return String(a['מותג']||'').localeCompare(String(b['מותג']||''),'he');
      case 'out_desc':   return (b.__outQty||0) - (a.__outQty||0);
      default:           return String(a['שם מוצר']||'').localeCompare(String(b['שם מוצר']||''),'he');
    }
  });
  return rows;
}

function computeOutBySku(dateFrom, dateTo) {
  const map = new Map();
  if (!store.movements.length || !dateFrom || !dateTo) return map;
  const from = new Date(dateFrom + 'T00:00:00').getTime();
  const to   = new Date(dateTo   + 'T23:59:59').getTime();
  for (const m of store.movements) {
    if (String(m['מקור']||'').trim() !== 'יציאה') continue;
    const ts  = parseMovementTs(m);
    if (!ts || ts < from || ts > to) continue;
    const sku = String(m['מק"ט']||'').trim();
    if (!sku) continue;
    map.set(sku, (map.get(sku)||0) + (Number(m['כמות']||0)||0));
  }
  return map;
}

function renderProductsTable(rows) {
  const tbody = $('#productsTable tbody');
  const role  = store.session?.role;
  tbody.innerHTML = rows.slice(0, 2000).map(p => {
    const sku = String(p['מק"ט']||'').trim();
    const img = String(p['תמונה']||'').trim();
    return `<tr class="product-row" data-sku="${escHtml(sku)}">
      <td>${img ? `<img class="thumb" src="${escHtml(img)}"/>` : ''}</td>
      <td><span class="kbd">${escHtml(sku)}</span></td>
      <td>${escHtml(String(p['שם מוצר']||''))}</td>
      <td>${escHtml(String(p['סה"כ במלאי']||''))}</td>
      <td>${p.__outQty || 0}</td>
      <td>${escHtml(String(p['מותג']||''))}</td>
      <td>${escHtml(String(p['ספק'] ||''))}</td>
      <td>${escHtml(String(p['פסח'] ||''))}</td>
      <td>${(role==='Admin'||role==='Editor')
        ? `<button class="btn btn-ghost" onclick="event.stopPropagation();navigate('edit',{sku:'${escHtml(sku)}'})">עריכה</button>`
        : ''}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr.product-row').forEach(tr => {
    tr.onclick = e => {
      if (e.target.closest('button')) return;
      navigate('status', { sku: tr.dataset.sku });
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   BIND — add / out
   ═══════════════════════════════════════════════════════════════════════════ */
function bindAddOut(mode) {
  $('#logoutBtn').style.display = '';
  const input       = $('#barcodeInput');
  const productPane = $('#productPane');
  const feedbackMsg = $('#feedbackMsg');

  $('#findBtn').onclick = doFind;
  $('#summaryBtn').onclick = toggleSummary;
  input.addEventListener('keydown', e => e.key === 'Enter' && (e.preventDefault(), doFind()));

  function doFind() {
    const code = input.value.trim();
    if (!code) return;
    const sku = store.catalog.skuByBarcode.get(code);
    if (!sku) {
      renderUnknownPane(productPane, code, async pickedSku => {
        await apiPost({ action: 'barcode_add', token: store.session.token, sku: pickedSku, barcode: code });
        await refreshCatalog();
        renderProductAction(store.catalog.productsBySku.get(pickedSku), code);
      });
      return;
    }
    renderProductAction(store.catalog.productsBySku.get(sku), code);
  }

  function renderProductAction(p, barcode) {
    if (!p) { feedbackMsg.textContent = 'מוצר לא נמצא'; return; }
    const sku   = String(p['מק"ט']       || '').trim();
    const name  = String(p['שם מוצר']    || '').trim();
    const stock = Number(String(p['סה"כ במלאי']||'0').replace(',','.')) || 0;

    productPane.style.display = '';
    productPane.innerHTML = `
      <div class="h1">${escHtml(name)}</div>
      <div class="small">מק"ט: <span class="kbd">${escHtml(sku)}</span> &nbsp;·&nbsp; מלאי נוכחי: <strong>${stock}</strong></div>
      <div class="row" style="margin-top:12px">
        <div class="col"><label>כמות</label><input id="qty" class="input" type="number" value="1" min="1"/></div>
        <div class="col"><label>הערות</label><input id="notes" class="input" placeholder="אופציונלי"/></div>
      </div>
      <div class="row" style="margin-top:10px">
        <button id="m10" class="btn">-10</button>
        <button id="m5"  class="btn">-5</button>
        <button id="m1"  class="btn">-1</button>
        <button id="p1"  class="btn">+1</button>
        <button id="p5"  class="btn">+5</button>
        <button id="p10" class="btn">+10</button>
        <div class="spacer"></div>
        <button class="btn btn-ghost" onclick="navigate('edit',{sku:'${escHtml(sku)}'})">עריכת מוצר</button>
        <button id="submitMove" class="btn btn-primary">${mode==='add' ? '✅ הוסף למלאי' : '📤 הוצא מהמלאי'}</button>
      </div>`;

    const qtyEl = $('#qty');
    const bump  = d => qtyEl.value = String(Math.max(1, (Number(qtyEl.value)||1) + d));
    ({ m10:-10, m5:-5, m1:-1, p1:1, p5:5, p10:10 });
    [['m10',-10],['m5',-5],['m1',-1],['p1',1],['p5',5],['p10',10]].forEach(([id,d]) => {
      $('#'+id).onclick = () => bump(d);
    });

    $('#submitMove').onclick = async () => {
      const qty    = Number(qtyEl.value || 0);
      const source = mode === 'add' ? 'כניסה' : 'יציאה';
      if (!qty) return;
      if (source === 'יציאה' && stock - qty < 0 && !confirm(`יכניס למינוס (${stock-qty}). להמשיך?`)) return;

      feedbackMsg.textContent = 'שולח...';
      feedbackMsg.className   = 'small';
      const btn = $('#submitMove');
      btn.disabled = true;

      try {
        const notesVal = $('#notes').value.trim();
        await apiPost({
          action: 'movement_add',
          token:  store.session.token,
          sku, barcode, qty, source,
          notes:       notesVal,
          reporterId:   store.session.userId,
          reporterName: store.session.userName,
        });

        // עדכן cache מקומי מיד
        const now = new Date();
        store.movements.push({
          'מק"ט': sku, 'שם מוצר': name, 'ברקוד': barcode,
          'כמות': qty, 'מקור': source, 'הערות': notesVal,
          'תאריך דיווח': now.toISOString().slice(0,10),
          'שעת דיווח':   now.toTimeString().slice(0,8),
        });
        localStorage.setItem(LS.movements, JSON.stringify(store.movements));

        const entry = { ts: Date.now(), sku, name, barcode, qty, source, notes: notesVal };
        (mode === 'add' ? store.drafts.add : store.drafts.out).unshift(entry);
        saveDrafts();

        input.value = '';
        productPane.style.display = 'none';
        productPane.innerHTML     = '';
        feedbackMsg.textContent   = `✓ בוצע — ${name} (${qty} יח׳)`;
        feedbackMsg.className     = 'feedback-ok';
        setTimeout(() => { if (feedbackMsg) { feedbackMsg.textContent = ''; feedbackMsg.className = ''; } }, 4000);

        // עדכן מונה סיכום
        const cnt = mode==='add' ? store.drafts.add.length : store.drafts.out.length;
        $('#summaryBtn').textContent = `סיכום (${cnt})`;
        input.focus();
      } catch (err) {
        feedbackMsg.textContent = 'שגיאה: ' + err.message;
        feedbackMsg.className   = 'feedback-err';
        btn.disabled = false;
      }
    };
  }

  function toggleSummary() {
    const pane = $('#summaryPane');
    const list = mode === 'add' ? store.drafts.add : store.drafts.out;
    const show = pane.style.display === 'none';
    pane.style.display = show ? '' : 'none';
    if (!show) return;
    productPane.style.display = 'none';
    productPane.innerHTML     = '';
    pane.innerHTML = `
      <div class="h1">סיכום (${list.length})</div>
      <div style="overflow:auto">
        <table class="table">
          <thead><tr><th>זמן</th><th>מק"ט</th><th>שם</th><th>ברקוד</th><th>כמות</th><th>מקור</th></tr></thead>
          <tbody>${list.map(x => `<tr>
            <td>${new Date(x.ts).toLocaleString('he-IL')}</td>
            <td>${escHtml(x.sku)}</td><td>${escHtml(x.name)}</td>
            <td>${escHtml(x.barcode)}</td><td>${x.qty}</td><td>${escHtml(x.source)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
      <button id="finishBtn" class="btn btn-primary" style="margin-top:10px">סיימתי — נקה טיוטה</button>`;
    $('#finishBtn').onclick = () => {
      if (!confirm('לנקות את הסיכום?')) return;
      if (mode === 'add') store.drafts.add = []; else store.drafts.out = [];
      saveDrafts();
      navigate('');
    };
  }

  input.focus();
}

/* ═══════════════════════════════════════════════════════════════════════════
   BIND — status
   ═══════════════════════════════════════════════════════════════════════════ */
function bindStatus(initialSku) {
  $('#logoutBtn').style.display = '';
  const input = $('#statusBarcode');
  const out   = $('#statusOut');

  if (initialSku) runBySku(initialSku);

  $('#statusFind').onclick = run;
  input.addEventListener('keydown', e => e.key === 'Enter' && run());
  if (!initialSku) input.focus();

  function run() {
    const code = input.value.trim();
    if (!code) return;
    const sku = store.catalog.skuByBarcode.get(code);
    if (!sku) {
      renderUnknownPane(out, code, async pickedSku => {
        await apiPost({ action: 'barcode_add', token: store.session.token, sku: pickedSku, barcode: code });
        await refreshCatalog();
        runBySku(pickedSku);
      });
      return;
    }
    runBySku(sku, code);
  }

  async function runBySku(sku, barcode = '') {
    out.innerHTML = '<div class="small">טוען...</div>';
    try {
      const data = await apiGet({ action: 'product_status', token: store.session.token, sku, barcode });
      const p    = data.product;
      out.innerHTML = `
        <div class="card">
          <div class="h1">${escHtml(String(p['שם מוצר']||''))}</div>
          <div class="small">מק"ט: <span class="kbd">${escHtml(String(p['מק"ט']||sku))}</span></div>
          <div class="row" style="margin-top:10px">
            <span class="pill">מחסן: ${escHtml(String(p['מצב מלאי מחסן']||'—'))}</span>
            <span class="pill">ליקוט: ${escHtml(String(p['מצב מלאי ליקוט']||'—'))}</span>
            <span class="pill">סה"כ: <strong>${escHtml(String(p['סה"כ במלאי']||'0'))}</strong></span>
            <button class="btn btn-ghost" onclick="navigate('edit',{sku:'${escHtml(sku)}'})">עריכת מוצר</button>
          </div>
          <div class="h1" style="margin-top:14px">תנועות אחרונות</div>
          <div style="overflow:auto">
            <table class="table">
              <thead><tr><th>תאריך</th><th>שעה</th><th>מקור</th><th>כמות</th><th>הערות</th><th>מדווח</th></tr></thead>
              <tbody>${(data.lastMovements||[]).map(m => `<tr>
                <td>${fmtDate(m['תאריך דיווח'])}</td>
                <td>${fmtTime(m['שעת דיווח'])}</td>
                <td>${escHtml(String(m['מקור']||''))}</td>
                <td>${escHtml(String(m['כמות']||''))}</td>
                <td>${escHtml(String(m['הערות']||''))}</td>
                <td>${escHtml(String(m['שם מדווח']||m['ID מדווח']||''))}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
        </div>`;
    } catch (err) {
      out.innerHTML = `<div class="small feedback-err">שגיאה: ${escHtml(err.message)}</div>`;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   BIND — product edit
   ═══════════════════════════════════════════════════════════════════════════ */
function bindProductEdit(sku) {
  $('#logoutBtn').style.display = '';
  const pane = $('#productEditPane');
  if (!sku) { pane.innerHTML = '<div class="small">חסר מק"ט.</div>'; return; }
  load();

  async function load() {
    pane.innerHTML = '<div class="small">טוען...</div>';
    try {
      const [statusData, barcodeData] = await Promise.all([
        apiGet({ action: 'product_status',  token: store.session.token, sku }),
        apiGet({ action: 'barcodes_for_sku', token: store.session.token, sku })
          .catch(() => ({ barcodes: (store.catalog.barcodesBySku.get(sku)||[]).map(b => ({ barcode: b })) })),
      ]);
      const p       = statusData.product || store.catalog.productsBySku.get(sku) || {};
      const isAdmin = store.session.role === 'Admin';
      const editable = isAdmin
        ? ['מק"ט','שם מוצר','ספק','מותג','פסח','קוד מזהה','מעמ','תמונה']
        : ['שם מוצר','ספק','מותג','פסח'];

      pane.innerHTML = `
        <div class="row">
          ${editable.map(k => {
            if (k === 'פסח') {
              const cur  = String(p[k]||'').trim();
              const opts = ['','קטניות','ללא קטניות','חמץ'];
              return `<div class="col"><label>${escHtml(k)}</label>
                <select data-field="${escHtml(k)}" class="input">
                  ${opts.map(o => `<option value="${escHtml(o)}" ${o===cur?'selected':''}>${escHtml(o||'בחר...')}</option>`).join('')}
                </select></div>`;
            }
            return `<div class="col"><label>${escHtml(k)}</label>
              <input data-field="${escHtml(k)}" class="input" value="${escHtml(String(p[k]||''))}"/></div>`;
          }).join('')}
        </div>
        <div class="row" style="margin-top:12px">
          <button id="saveProductBtn" class="btn btn-primary">💾 שמור שינויים</button>
          <span id="saveProductMsg" class="small"></span>
        </div>
        <hr style="margin:16px 0"/>
        <div class="h1">ברקודים</div>
        <div id="barcodeList">
          ${(barcodeData.barcodes||[]).map(b => {
            const code = typeof b === 'string' ? b : (b.barcode || b['ברקוד'] || '');
            return `<div class="row" style="margin-bottom:6px">
              <span class="kbd">${escHtml(code)}</span>
              ${isAdmin ? `<button class="btn btn-danger" data-del="${escHtml(code)}">מחק</button>` : ''}
            </div>`;
          }).join('')}
        </div>
        <div class="row" style="margin-top:10px">
          <div class="col"><input id="newBarcode" class="input" placeholder="ברקוד חדש"/></div>
          <button id="addBarcodeBtn" class="btn">הוסף ברקוד</button>
        </div>
        <div id="barcodeMsg" class="small" style="margin-top:6px"></div>`;

      $('#saveProductBtn').onclick = async () => {
        const fields = {};
        pane.querySelectorAll('[data-field]').forEach(el => { fields[el.dataset.field] = el.value.trim(); });
        const msg = $('#saveProductMsg');
        msg.textContent = 'שומר...'; msg.className = 'small';
        try {
          await apiPost({ action: 'product_update', token: store.session.token, sku, fields: JSON.stringify(fields) });
          msg.textContent = 'נשמר ✓'; msg.className = 'small feedback-ok';
          await refreshCatalog();
        } catch (err) { msg.textContent = 'שגיאה: ' + err.message; msg.className = 'small feedback-err'; }
      };

      $('#addBarcodeBtn').onclick = async () => {
        const code = $('#newBarcode').value.trim();
        if (!code) return;
        const msg = $('#barcodeMsg');
        msg.textContent = 'מוסיף...'; msg.className = 'small';
        try {
          await apiPost({ action: 'barcode_add', token: store.session.token, sku, barcode: code });
          msg.textContent = 'נוסף ✓'; msg.className = 'small feedback-ok';
          await refreshCatalog(); load();
        } catch (err) { msg.textContent = 'שגיאה: ' + err.message; msg.className = 'small feedback-err'; }
      };

      pane.querySelectorAll('[data-del]').forEach(btn => {
        btn.onclick = async () => {
          if (!confirm('למחוק ברקוד?')) return;
          const msg = $('#barcodeMsg');
          msg.textContent = 'מוחק...'; msg.className = 'small';
          try {
            await apiPost({ action: 'barcode_delete', token: store.session.token, sku, barcode: btn.dataset.del });
            msg.textContent = 'נמחק ✓'; msg.className = 'small feedback-ok';
            await refreshCatalog(); load();
          } catch (err) { msg.textContent = 'שגיאה: ' + err.message; msg.className = 'small feedback-err'; }
        };
      });

    } catch (err) {
      pane.innerHTML = `<div class="small feedback-err">שגיאה: ${escHtml(err.message)}</div>`;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   BIND — unknown barcode
   ═══════════════════════════════════════════════════════════════════════════ */
function renderUnknownPane(container, code, onAttach) {
  container.style.display = '';
  container.innerHTML = `
    <div class="card">
      <div class="h1">ברקוד לא מוכר</div>
      <div class="small" style="margin-bottom:10px">ברקוד: <span class="kbd">${escHtml(code)}</span></div>
      <div class="row">
        <div class="col"><label>חיפוש מוצר</label><input id="unknownSearch" class="input" placeholder="שם / מק"ט"/></div>
        <div class="col"><label>בחר מוצר</label>
          <select id="unknownSku" class="input"><option value="">בחר...</option></select>
        </div>
        <button id="attachBtn" class="btn btn-primary">שייך ברקוד</button>
      </div>
      <div id="unknownMsg" class="small" style="margin-top:6px"></div>
    </div>`;

  const search = $('#unknownSearch');
  const select = $('#unknownSku');
  const fill   = (q = '') => {
    select.innerHTML = '<option value="">בחר...</option>';
    const t = q.toLowerCase();
    store.catalog.products
      .filter(p => !t || String(p['שם מוצר']||'').toLowerCase().includes(t) || String(p['מק"ט']||'').toLowerCase().includes(t))
      .slice(0, 80)
      .forEach(p => {
        const sku = String(p['מק"ט']||'').trim();
        const o   = document.createElement('option');
        o.value = sku; o.textContent = `${sku} — ${String(p['שם מוצר']||'').trim()}`;
        select.appendChild(o);
      });
  };
  fill();
  search.addEventListener('input', () => fill(search.value.trim()));
  $('#attachBtn').onclick = async () => {
    const sku = select.value;
    if (!sku) return;
    const msg = $('#unknownMsg');
    msg.textContent = 'שומר...'; msg.className = 'small';
    try {
      await onAttach(sku);
      msg.textContent = 'שויך בהצלחה ✓'; msg.className = 'small feedback-ok';
    } catch (err) { msg.textContent = 'שגיאה: ' + err.message; msg.className = 'small feedback-err'; }
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   UTILS
   ═══════════════════════════════════════════════════════════════════════════ */
function uniq(arr) { return [...new Set(arr)]; }
function fillSelect(sel, values) {
  values.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); });
}
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtDate(v) { const d = new Date(v); return isNaN(d) ? String(v||'') : d.toLocaleDateString('he-IL'); }
function fmtTime(v) { const d = new Date(v); return isNaN(d) ? String(v||'') : d.toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'}); }

function parseMovementTs(m) {
  const d   = m['תאריך דיווח'];
  const t   = m['שעת דיווח'];
  const raw = `${d||''} ${t||''}`.trim();
  const direct = new Date(raw).getTime();
  if (!isNaN(direct) && direct > 0) return direct;

  const dateRaw = String(d||'').trim();
  const timeRaw = String(t||'').trim() || '00:00:00';

  const iso = dateRaw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) {
    const ts = new Date(`${iso[1]}-${pad2(iso[2])}-${pad2(iso[3])}T${normTime(timeRaw)}`).getTime();
    if (!isNaN(ts) && ts > 0) return ts;
  }
  const loc = dateRaw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (loc) {
    let y = loc[3]; if (y.length===2) y = '20'+y;
    const ts = new Date(`${y}-${pad2(loc[2])}-${pad2(loc[1])}T${normTime(timeRaw)}`).getTime();
    if (!isNaN(ts) && ts > 0) return ts;
  }
  const serial = Number(dateRaw);
  if (!isNaN(serial) && serial > 1000) {
    const ts = (serial - 25569) * 86400000;
    if (!isNaN(ts) && ts > 0) return ts;
  }
  return 0;
}

function normTime(v) {
  const p = String(v||'').trim().split(':').filter(Boolean);
  if (!p.length) return '00:00:00';
  return `${pad2(p[0])}:${pad2(p[1]||'00')}:${pad2(p[2]||'00')}`;
}
function pad2(v) { return String(v||'0').padStart(2,'0'); }
