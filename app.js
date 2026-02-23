const $ = (sel) => document.querySelector(sel);

const store = {
  session: null,
  catalog: null,
  movements: [],
  drafts: { add: [], out: [] },
};

const LS_KEYS = {
  session: 'stock.session.v1',
  catalog: 'stock.catalog.v1',
  catalogTs: 'stock.catalog.ts.v1',
  draftAdd: 'stock.draft.add.v1',
  draftOut: 'stock.draft.out.v1',
  movements: 'stock.movements.v1',
  movementsTs: 'stock.movements.ts.v1',
};

init();

async function init() {
  loadSession();
  loadDrafts();
  wireTopbar();

  window.addEventListener('popstate', render);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });

  await ensureCatalogLoaded();
  render();
}

function wireTopbar() {
  $('#logoutBtn').addEventListener('click', () => {
    clearSession();
    clearDrafts();
    render();
  });
}

function navigate(path) {
  history.pushState({}, '', path);
  render();
}

function render() {
  const app = $('#app');
  const path = location.pathname;
  const params = new URLSearchParams(location.search);

  updateUserBadge();

  if (!store.session) {
    app.innerHTML = loginView();
    bindLogin();
    return;
  }

  if (path.endsWith('/add')) {
    app.innerHTML = addOutView({ mode: 'add' });
    bindAddOut({ mode: 'add' });
    return;
  }
  if (path.endsWith('/out')) {
    app.innerHTML = addOutView({ mode: 'out' });
    bindAddOut({ mode: 'out' });
    return;
  }
  if (path.endsWith('/status')) {
    app.innerHTML = statusView();
    bindStatus();
    return;
  }
  if (path.endsWith('/product/edit')) {
    const sku = params.get('sku') || '';
    app.innerHTML = productEditView(sku);
    bindProductEdit(sku);
    return;
  }

  app.innerHTML = dashboardView();
  bindDashboard();
}

function updateUserBadge() {
  const b = $('#userBadge');
  b.textContent = store.session ? `${store.session.userName} · ${store.session.role}` : '';
}

function loadSession() {
  try { store.session = JSON.parse(localStorage.getItem(LS_KEYS.session) || 'null'); } catch { store.session = null; }
}
function saveSession() { localStorage.setItem(LS_KEYS.session, JSON.stringify(store.session)); }
function clearSession() { store.session = null; localStorage.removeItem(LS_KEYS.session); }

function loadDrafts() {
  try { store.drafts.add = JSON.parse(localStorage.getItem(LS_KEYS.draftAdd) || '[]'); } catch { store.drafts.add = []; }
  try { store.drafts.out = JSON.parse(localStorage.getItem(LS_KEYS.draftOut) || '[]'); } catch { store.drafts.out = []; }
}
function saveDrafts() {
  localStorage.setItem(LS_KEYS.draftAdd, JSON.stringify(store.drafts.add));
  localStorage.setItem(LS_KEYS.draftOut, JSON.stringify(store.drafts.out));
}
function clearDrafts() {
  store.drafts = { add: [], out: [] };
  localStorage.removeItem(LS_KEYS.draftAdd);
  localStorage.removeItem(LS_KEYS.draftOut);
}

async function ensureCatalogLoaded() {
  const cached = localStorage.getItem(LS_KEYS.catalog);
  const ts = Number(localStorage.getItem(LS_KEYS.catalogTs) || '0');
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
  const [productsCsv, barcodesCsv] = await Promise.all([
    fetchText(window.CONFIG.PRODUCTS_CSV),
    fetchText(window.CONFIG.BARCODES_CSV),
  ]);

  const products = parseCsv(productsCsv);
  const barcodes = parseCsv(barcodesCsv);
  const productsBySku = new Map();
  const skuByBarcode = new Map();
  const barcodesBySku = new Map();

  for (const p of products) {
    const sku = String(p['מק"ט'] || '').trim();
    if (sku) productsBySku.set(sku, p);
  }
  for (const b of barcodes) {
    const sku = String(b['מק"ט מוצר'] || '').trim();
    const code = String(b['ברקוד'] || '').trim();
    if (!sku || !code) continue;
    skuByBarcode.set(code, sku);
    if (!barcodesBySku.has(sku)) barcodesBySku.set(sku, []);
    barcodesBySku.get(sku).push(code);
  }

  store.catalog = { products, barcodes, productsBySku, skuByBarcode, barcodesBySku };
  persistCatalog();
}

async function ensureMovementsLoaded() {
  const cached = localStorage.getItem(LS_KEYS.movements);
  const ts = Number(localStorage.getItem(LS_KEYS.movementsTs) || '0');
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
  localStorage.setItem(LS_KEYS.movements, JSON.stringify(store.movements));
  localStorage.setItem(LS_KEYS.movementsTs, String(Date.now()));
}

function persistCatalog() {
  localStorage.setItem(LS_KEYS.catalog, JSON.stringify({
    products: store.catalog.products,
    barcodes: store.catalog.barcodes,
    productsBySku: [...store.catalog.productsBySku.entries()],
    skuByBarcode: [...store.catalog.skuByBarcode.entries()],
    barcodesBySku: [...store.catalog.barcodesBySku.entries()],
  }));
  localStorage.setItem(LS_KEYS.catalogTs, String(Date.now()));
}

function reviveCatalog(obj) {
  return {
    products: obj.products || [],
    barcodes: obj.barcodes || [],
    productsBySku: new Map(obj.productsBySku || []),
    skuByBarcode: new Map(obj.skuByBarcode || []),
    barcodesBySku: new Map(obj.barcodesBySku || []),
  };
}

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Fetch failed: ' + url);
  return res.text();
}

function parseCsv(text) {
  const rows = [];
  let i = 0, f = '', row = [], q = false;
  const pushField = () => { row.push(f); f = ''; };
  const pushRow = () => { rows.push(row); row = []; };

  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i += 2; continue; }
      if (c === '"') { q = false; i++; continue; }
      f += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\n') { pushField(); pushRow(); i++; continue; }
    if (c === '\r') { i++; continue; }
    f += c; i++;
  }
  pushField();
  if (row.length > 1 || row[0] !== '') pushRow();

  const headers = (rows.shift() || []).map((h) => String(h).trim());
  return rows.filter(r => r.some(x => String(x).trim())).map((r) => {
    const o = {};
    headers.forEach((h, idx) => o[h] = r[idx] ?? '');
    return o;
  });
}

async function apiPost(payload) {
  const form = new URLSearchParams();
  Object.entries(payload).forEach(([k, v]) => form.set(k, v == null ? '' : String(v)));
  const res = await fetch(window.CONFIG.API_URL, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'API error');
  return data;
}

async function apiGet(params) {
  const url = new URL(window.CONFIG.API_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v == null ? '' : String(v)));
  const res = await fetch(url.toString(), { cache: 'no-store' });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'API error');
  return data;
}

function loginView() { return `<section class="card"><div class="h1">כניסה</div><div class="row"><div class="col"><label>ID משתמש</label><input id="loginUserId" class="input"/></div><div class="col"><label>קוד</label><input id="loginCode" class="input" type="password"/></div></div><div class="row" style="margin-top:10px"><button id="loginBtn" class="btn btn-primary">התחבר</button><span id="loginErr" class="small"></span></div></section>`; }

function dashboardView() {
  const ts = Number(localStorage.getItem(LS_KEYS.catalogTs) || '0');
  const ageMin = ts ? Math.max(0, Math.floor((Date.now() - ts) / 60000)) : null;
  return `
  <section class="card">
    <div class="h1">תפריט</div>
    <div class="row">
      <a class="btn btn-primary" data-link href="/stock/add">הוספה למלאי</a>
      <a class="btn btn-primary" data-link href="/stock/out">הוצאה מהמלאי</a>
      <a class="btn btn-primary" data-link href="/stock/status">מצב מוצר</a>
    </div>
    <div class="row" style="margin-top:10px">
      <span class="pill">קטלוג עודכן לפני: ${ageMin == null ? 'לא ידוע' : `${ageMin} דק׳`}</span>
      <button id="refreshCatalogBtn" class="btn">רענון קטלוג</button>
      <span id="refreshMsg" class="small"></span>
    </div>
  </section>

  <section class="card">
    <div class="h1">מוצרים</div>
    <div class="row">
      <div class="col"><label>חיפוש (שם/מק"ט)</label><input id="q" class="input"/></div>
      <div class="col"><label>מותג</label><select id="brand" class="input"><option value="">הכול</option></select></div>
      <div class="col"><label>ספק</label><select id="vendor" class="input"><option value="">הכול</option></select></div>
      <div class="col"><label>פסח</label><select id="pesach" class="input"><option value="">הכול</option><option value="קטניות">קטניות</option><option value="ללא קטניות">ללא קטניות</option><option value="חמץ">חמץ</option></select></div>
      <div class="col"><label>תאריך יציאות מ-</label><input id="dateFrom" type="date" class="input"/></div>
      <div class="col"><label>עד</label><input id="dateTo" type="date" class="input"/></div>
      <div style="display:flex;align-items:flex-end"><button id="dateRangeSearchBtn" class="btn">חפש בטווח</button></div>
      <div class="col"><label>מיון</label><select id="sort" class="input"><option value="name_asc">שם (א-ת)</option><option value="name_desc">שם (ת-א)</option><option value="stock_desc">מלאי ↓</option><option value="stock_asc">מלאי ↑</option><option value="vendor_asc">ספק</option><option value="brand_asc">מותג</option><option value="out_desc">יצא בטווח ↓</option></select></div>
    </div>
    <div style="overflow:auto;margin-top:10px"><table class="table" id="productsTable"><thead><tr><th>תמונה</th><th>מק"ט</th><th>שם</th><th>סה"כ</th><th>יצא בטווח</th><th>מותג</th><th>ספק</th><th>פסח</th><th>פעולות</th></tr></thead><tbody></tbody></table></div>
  </section>`;
}

function addOutView({ mode }) {
  const draftCount = mode === 'add' ? store.drafts.add.length : store.drafts.out.length;
  return `<section class="card"><div class="h1">${mode === 'add' ? 'הוספה למלאי' : 'הוצאה מהמלאי'}</div><div class="row"><div class="col"><label>ברקוד</label><input id="barcodeInput" class="input" autocomplete="off"/></div><div style="display:flex;gap:10px;align-items:flex-end"><button id="findBtn" class="btn">חיפוש</button><button id="summaryBtn" class="btn btn-ghost">סיכום (${draftCount})</button><a class="btn btn-ghost" data-link href="/stock">לתפריט</a></div></div><div id="productPane" class="card" style="display:none"></div></section><section id="summaryPane" class="card" style="display:none"></section>`;
}

function statusView() { return `<section class="card"><div class="h1">מצב מוצר</div><div class="row"><div class="col"><label>ברקוד</label><input id="statusBarcode" class="input"/></div><div style="display:flex;gap:10px;align-items:flex-end"><button id="statusFind" class="btn">חיפוש</button><a class="btn btn-ghost" data-link href="/stock">לתפריט</a></div></div><div id="statusOut" class="card" style="display:none"></div></section>`; }

function productEditView(sku) {
  return `<section class="card"><div class="h1">עריכת מוצר</div><div class="small">מק"ט: <span class="kbd">${escapeHtml(sku || '-')}</span></div><div id="productEditPane" style="margin-top:10px"></div><div class="row" style="margin-top:12px"><a class="btn btn-ghost" data-link href="/stock">חזרה</a></div></section>`;
}

function bindLogin() {
  $('#logoutBtn').style.display = 'none';
  $('#loginBtn').onclick = async () => {
    const userId = $('#loginUserId').value.trim();
    const code = $('#loginCode').value.trim();
    $('#loginErr').textContent = '...';
    try {
      const data = await apiPost({ action: 'auth_login', userId, code });
      store.session = { userId: data.userId, userName: data.userName, role: data.role, token: data.token };
      saveSession();
      await ensureMovementsLoaded();
      navigate('/stock');
    } catch (err) { $('#loginErr').textContent = 'שגיאה: ' + err.message; }
  };
  $('#loginCode').addEventListener('keydown', (e) => e.key === 'Enter' && $('#loginBtn').click());
  $('#loginUserId').focus();
}

function bindDashboard() {
  $('#logoutBtn').style.display = '';
  let dateRangeActive = false;

  $('#refreshCatalogBtn').onclick = async () => {
    $('#refreshCatalogBtn').textContent = 'מרענן...';
    try {
      await refreshCatalog();
      await refreshMovements().catch(() => {});
      $('#refreshMsg').textContent = 'עודכן ✓';
      render();
    } catch (err) {
      $('#refreshMsg').textContent = 'שגיאה: ' + err.message;
    } finally {
      $('#refreshCatalogBtn').textContent = 'רענון קטלוג';
    }
  };

  fillSelect($('#brand'), uniq(store.catalog.products.map(p => String(p['מותג'] || '').trim()).filter(Boolean)));
  fillSelect($('#vendor'), uniq(store.catalog.products.map(p => String(p['ספק'] || '').trim()).filter(Boolean)));

  const apply = () => {
    const rows = filterAndSortProducts({
      q: $('#q').value.trim(), brand: $('#brand').value, vendor: $('#vendor').value,
      pesach: $('#pesach').value,
      sort: $('#sort').value,
      dateFrom: dateRangeActive ? $('#dateFrom').value : '',
      dateTo: dateRangeActive ? $('#dateTo').value : '',
    });
    renderProductsTable(rows);
  };

  $('#dateRangeSearchBtn').onclick = () => {
    dateRangeActive = true;
    apply();
  };

  ['q', 'brand', 'vendor', 'pesach', 'sort'].forEach((id) => {
    const el = $('#' + id);
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  });
  apply();
}

function filterAndSortProducts({ q, brand, vendor, pesach, sort, dateFrom, dateTo }) {
  let rows = store.catalog.products.filter((p) => {
    const sku = String(p['מק"ט'] || p['מק"ט מוצר'] || '').trim();
    return Boolean(sku);
  });
  if (q) {
    const t = q.toLowerCase();
    rows = rows.filter(p => String(p['שם מוצר'] || '').toLowerCase().includes(t) || String(p['מק"ט'] || '').toLowerCase().includes(t));
  }
  if (brand) rows = rows.filter(p => String(p['מותג'] || '').trim() === brand);
  if (vendor) rows = rows.filter(p => String(p['ספק'] || '').trim() === vendor);
  if (pesach) rows = rows.filter(p => String(p['פסח'] || '').trim() === pesach);

  const outBySku = computeOutBySku(dateFrom, dateTo);
  const stockNum = (p) => Number(String(p['סה"כ במלאי'] || '0').replace(',', '.')) || 0;

  rows.forEach(p => { p.__outQty = outBySku.get(String(p['מק"ט'] || '').trim()) || 0; });
  rows.sort((a, b) => {
    switch (sort) {
      case 'name_desc': return String(b['שם מוצר'] || '').localeCompare(String(a['שם מוצר'] || ''), 'he');
      case 'stock_desc': return stockNum(b) - stockNum(a);
      case 'stock_asc': return stockNum(a) - stockNum(b);
      case 'vendor_asc': return String(a['ספק'] || '').localeCompare(String(b['ספק'] || ''), 'he');
      case 'brand_asc': return String(a['מותג'] || '').localeCompare(String(b['מותג'] || ''), 'he');
      case 'out_desc': return (b.__outQty || 0) - (a.__outQty || 0);
      default: return String(a['שם מוצר'] || '').localeCompare(String(b['שם מוצר'] || ''), 'he');
    }
  });
  return rows;
}

function computeOutBySku(dateFrom, dateTo) {
  const map = new Map();
  if (!store.movements.length || !dateFrom || !dateTo) return map;
  const from = new Date(dateFrom + 'T00:00:00').getTime();
  const to = new Date(dateTo + 'T23:59:59').getTime();
  for (const m of store.movements) {
    if (String(m['מקור'] || '').trim() !== 'יציאה') continue;
    const ts = parseMovementTs(m);
    if (!ts || ts < from || ts > to) continue;
    const sku = String(m['מק"ט'] || '').trim();
    const qty = Number(m['כמות'] || 0) || 0;
    map.set(sku, (map.get(sku) || 0) + qty);
  }
  return map;
}

function renderProductsTable(rows) {
  const tbody = $('#productsTable tbody');
  const role = store.session?.role;
  tbody.innerHTML = rows.slice(0, 2000).map((p) => {
    const sku = String(p['מק"ט'] || '').trim();
    const img = String(p['תמונה'] || '').trim();
    return `<tr data-sku="${escapeHtml(sku)}" class="product-row"><td>${img ? `<img class="thumb" src="${escapeHtml(img)}"/>` : ''}</td><td><span class="kbd">${escapeHtml(sku)}</span></td><td>${escapeHtml(String(p['שם מוצר'] || ''))}</td><td>${escapeHtml(String(p['סה"כ במלאי'] || ''))}</td><td>${Number(p.__outQty || 0)}</td><td>${escapeHtml(String(p['מותג'] || ''))}</td><td>${escapeHtml(String(p['ספק'] || ''))}</td><td>${escapeHtml(String(p['פסח'] || ''))}</td><td>${role === 'Admin' || role === 'Editor' ? `<a data-link href="/stock/product/edit?sku=${encodeURIComponent(sku)}" class="btn btn-ghost">עריכה</a>` : ''}</td></tr>`;
  }).join('');

  tbody.querySelectorAll('tr.product-row').forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest('a,button')) return;
      const sku = tr.getAttribute('data-sku');
      navigate(`/stock/status?sku=${encodeURIComponent(sku)}`);
    };
  });
}

function bindAddOut({ mode }) {
  $('#logoutBtn').style.display = '';
  const input = $('#barcodeInput');
  const productPane = $('#productPane');
  $('#findBtn').onclick = doFind;
  $('#summaryBtn').onclick = toggleSummary;
  input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), doFind()));

  function doFind() {
    const code = input.value.trim();
    if (!code) return;
    const sku = store.catalog.skuByBarcode.get(code);
    if (!sku) {
      renderUnknownBarcodePane(productPane, code, async (pickedSku) => {
        await apiPost({ action: 'barcode_add', token: store.session.token, sku: pickedSku, barcode: code });
        await refreshCatalog();
        const p = store.catalog.productsBySku.get(pickedSku);
        renderProductAction(p, code);
      });
      return;
    }
    renderProductAction(store.catalog.productsBySku.get(sku), code);
  }

  function renderProductAction(p, barcode) {
    if (!p) return;
    const sku = String(p['מק"ט'] || '').trim();
    const name = String(p['שם מוצר'] || '').trim();
    const stock = Number(String(p['סה"כ במלאי'] || '0').replace(',', '.')) || 0;
    productPane.style.display = '';
    productPane.innerHTML = `<div class="h1">${escapeHtml(name)}</div><div class="small">מק"ט: <span class="kbd">${escapeHtml(sku)}</span> · מלאי: ${stock}</div><div class="row" style="margin-top:10px"><div class="col"><label>כמות</label><input id="qty" class="input" type="number" value="1" min="1"/></div><div class="col"><label>הערות</label><input id="notes" class="input"/></div></div><div class="row" style="margin-top:10px"><button id="m10" class="btn">-10</button><button id="m5" class="btn">-5</button><button id="m1" class="btn">-1</button><button id="p1" class="btn">+1</button><button id="p5" class="btn">+5</button><button id="p10" class="btn">+10</button><div class="spacer"></div><a data-link class="btn btn-ghost" href="/stock/product/edit?sku=${encodeURIComponent(sku)}">עריכת מוצר</a><button id="submitMove" class="btn btn-primary">${mode === 'add' ? 'הוסף למלאי' : 'הוצא מהמלאי'}</button></div><div id="msg" class="small" style="margin-top:8px"></div>`;

    const qtyEl = $('#qty');
    const bump = (d) => qtyEl.value = String(Math.max(1, (Number(qtyEl.value) || 1) + d));
    ['m10', 'm5', 'm1', 'p1', 'p5', 'p10'].forEach((id) => {
      const deltas = { m10: -10, m5: -5, m1: -1, p1: 1, p5: 5, p10: 10 };
      $('#' + id).onclick = () => bump(deltas[id]);
    });
    $('#submitMove').onclick = async () => {
      const qty = Number(qtyEl.value || 0);
      const source = mode === 'add' ? 'כניסה' : 'יציאה';
      if (!qty) return;
      if (source === 'יציאה' && stock - qty < 0 && !confirm(`זה יכניס למינוס (${stock - qty}). להמשיך?`)) return;
      $('#msg').textContent = 'שולח...';
      try {
        await apiPost({
          action: 'movement_add',
          token: store.session.token,
          sku,
          barcode,
          qty,
          notes: $('#notes').value.trim(),
          source,
          reporterId: store.session.userId,
          reporterName: store.session.userName,
        });
        const entry = { ts: Date.now(), sku, name, barcode, qty, source, notes: $('#notes').value.trim() };
        (mode === 'add' ? store.drafts.add : store.drafts.out).unshift(entry);
        saveDrafts();
        input.value = '';
        input.focus();
        productPane.style.display = 'none';
        productPane.innerHTML = '';
        $('#msg').textContent = 'בוצע ✓';
      } catch (err) { $('#msg').textContent = 'שגיאה: ' + err.message; }
    };
  }

  function toggleSummary() {
    const pane = $('#summaryPane');
    const list = mode === 'add' ? store.drafts.add : store.drafts.out;
    pane.style.display = pane.style.display === 'none' ? '' : 'none';
    if (pane.style.display !== 'none') {
      productPane.style.display = 'none';
      productPane.innerHTML = '';
    }
    if (pane.style.display === 'none') return;
    pane.innerHTML = `<div class="h1">סיכום (${list.length})</div><div style="overflow:auto"><table class="table"><thead><tr><th>זמן</th><th>מק"ט</th><th>שם</th><th>ברקוד</th><th>כמות</th><th>מקור</th></tr></thead><tbody>${list.map(x => `<tr><td>${new Date(x.ts).toLocaleString('he-IL')}</td><td>${escapeHtml(x.sku)}</td><td>${escapeHtml(x.name)}</td><td>${escapeHtml(x.barcode)}</td><td>${x.qty}</td><td>${escapeHtml(x.source)}</td></tr>`).join('')}</tbody></table></div><button id="finishBtn" class="btn btn-primary" style="margin-top:10px">סיימתי</button>`;
    $('#finishBtn').onclick = () => {
      if (!confirm('לנקות מהטיוטה?')) return;
      if (mode === 'add') store.drafts.add = []; else store.drafts.out = [];
      saveDrafts();
      render();
    };
  }

  input.focus();
}

function bindStatus() {
  $('#logoutBtn').style.display = '';
  const input = $('#statusBarcode');
  const out = $('#statusOut');
  const params = new URLSearchParams(location.search);
  const initialSku = params.get('sku');
  if (initialSku) runBySku(initialSku);
  $('#statusFind').onclick = run;
  input.addEventListener('keydown', (e) => e.key === 'Enter' && run());
  input.focus();

  async function run() {
    const code = input.value.trim();
    if (!code) return;
    const sku = store.catalog.skuByBarcode.get(code);
    if (!sku) {
      renderUnknownBarcodePane(out, code, async (pickedSku) => {
        await apiPost({ action: 'barcode_add', token: store.session.token, sku: pickedSku, barcode: code });
        await refreshCatalog();
        runBySku(pickedSku);
      });
      return;
    }
    runBySku(sku, code);
  }

  async function runBySku(sku, barcode = '') {
    try {
      const data = await apiGet({ action: 'product_status', token: store.session.token, sku, barcode });
      const p = data.product;
      out.style.display = '';
      out.innerHTML = `<div class="h1">${escapeHtml(String(p['שם מוצר'] || ''))}</div><div class="small">מק"ט: <span class="kbd">${escapeHtml(String(p['מק"ט'] || sku))}</span></div><div class="row" style="margin-top:10px"><span class="pill">מחסן: ${escapeHtml(String(p['מצב מלאי מחסן'] || ''))}</span><span class="pill">ליקוט: ${escapeHtml(String(p['מצב מלאי ליקוט'] || ''))}</span><span class="pill">סה"כ: ${escapeHtml(String(p['סה"כ במלאי'] || ''))}</span><a data-link class="btn btn-ghost" href="/stock/product/edit?sku=${encodeURIComponent(sku)}">עריכת מוצר</a></div><div class="h1" style="margin-top:12px">תנועות אחרונות</div><div style="overflow:auto"><table class="table"><thead><tr><th>תאריך</th><th>שעה</th><th>מקור</th><th>כמות</th><th>הערות</th><th>מדווח</th></tr></thead><tbody>${(data.lastMovements || []).map(m => `<tr><td>${fmtDate(m['תאריך דיווח'])}</td><td>${fmtTime(m['שעת דיווח'])}</td><td>${escapeHtml(String(m['מקור'] || ''))}</td><td>${escapeHtml(String(m['כמות'] || ''))}</td><td>${escapeHtml(String(m['הערות'] || ''))}</td><td>${escapeHtml(String(m['שם מדווח'] || m['ID מדווח'] || ''))}</td></tr>`).join('')}</tbody></table></div>`;
    } catch (err) {
      out.style.display = '';
      out.innerHTML = `<div class="h1">שגיאה</div><div class="small">${escapeHtml(err.message)}</div>`;
    }
  }
}

function bindProductEdit(sku) {
  $('#logoutBtn').style.display = '';
  const pane = $('#productEditPane');
  if (!sku) {
    pane.innerHTML = '<div class="small">חסר מק"ט.</div>';
    return;
  }
  run();

  async function run() {
    pane.innerHTML = '<div class="small">טוען...</div>';
    try {
      const [statusData, barcodeData] = await Promise.all([
        apiGet({ action: 'product_status', token: store.session.token, sku }),
        apiGet({ action: 'barcodes_for_sku', token: store.session.token, sku }).catch(() => ({ barcodes: store.catalog.barcodesBySku.get(sku) || [] })),
      ]);
      const p = statusData.product || store.catalog.productsBySku.get(sku) || {};
      const isAdmin = store.session.role === 'Admin';
      const editable = isAdmin ? ['מק"ט', 'שם מוצר', 'ספק', 'מותג', 'פסח', 'קוד מזהה', 'מעמ', 'תמונה'] : ['שם מוצר', 'ספק', 'מותג', 'פסח'];
      pane.innerHTML = `<div class="row">${editable.map((k) => {
        if (k === 'פסח') {
          const current = String(p[k] || '').trim();
          const options = ['', 'קטניות', 'ללא קטניות', 'חמץ'];
          return `<div class="col"><label>${escapeHtml(k)}</label><select data-field="${escapeHtml(k)}" class="input">${options.map((opt) => `<option value="${escapeHtml(opt)}" ${opt === current ? 'selected' : ''}>${escapeHtml(opt || 'בחר...')}</option>`).join('')}</select></div>`;
        }
        return `<div class="col"><label>${escapeHtml(k)}</label><input data-field="${escapeHtml(k)}" class="input" value="${escapeHtml(String(p[k] || ''))}"/></div>`;
      }).join('')}</div><div class="row" style="margin-top:10px"><button id="saveProductBtn" class="btn btn-primary">שמור שינויים</button><span id="saveProductMsg" class="small"></span></div><hr/><div class="h1">ברקודים</div><div id="barcodeList">${(barcodeData.barcodes || []).map((b) => `<div class="row"><span class="kbd">${escapeHtml(typeof b === 'string' ? b : b.barcode || b['ברקוד'] || '')}</span>${isAdmin ? `<button class="btn btn-danger" data-del-barcode="${escapeHtml(typeof b === 'string' ? b : b.barcode || b['ברקוד'] || '')}">מחק</button>` : ''}</div>`).join('')}</div><div class="row" style="margin-top:10px"><div class="col"><input id="newBarcode" class="input" placeholder="ברקוד חדש"/></div><button id="addBarcodeBtn" class="btn">הוסף ברקוד</button></div><div id="barcodeMsg" class="small"></div>`;

      $('#saveProductBtn').onclick = async () => {
        const fields = {};
        pane.querySelectorAll('[data-field]').forEach((el) => { fields[el.getAttribute('data-field')] = el.value.trim(); });
        $('#saveProductMsg').textContent = 'שומר...';
        try {
          await apiPost({ action: 'product_update', token: store.session.token, sku, fields: JSON.stringify(fields) });
          $('#saveProductMsg').textContent = 'נשמר ✓';
          await refreshCatalog();
        } catch (err) { $('#saveProductMsg').textContent = 'שגיאה: ' + err.message; }
      };

      $('#addBarcodeBtn').onclick = async () => {
        const code = $('#newBarcode').value.trim();
        if (!code) return;
        $('#barcodeMsg').textContent = 'מוסיף...';
        try {
          await apiPost({ action: 'barcode_add', token: store.session.token, sku, barcode: code });
          $('#barcodeMsg').textContent = 'נוסף ✓';
          await refreshCatalog();
          run();
        } catch (err) { $('#barcodeMsg').textContent = 'שגיאה: ' + err.message; }
      };

      pane.querySelectorAll('[data-del-barcode]').forEach((btn) => {
        btn.onclick = async () => {
          const code = btn.getAttribute('data-del-barcode');
          if (!confirm('למחוק ברקוד?')) return;
          $('#barcodeMsg').textContent = 'מוחק...';
          try {
            await apiPost({ action: 'barcode_delete', token: store.session.token, sku, barcode: code });
            $('#barcodeMsg').textContent = 'נמחק ✓';
            await refreshCatalog();
            run();
          } catch (err) { $('#barcodeMsg').textContent = 'שגיאה: ' + err.message; }
        };
      });
    } catch (err) {
      pane.innerHTML = `<div class="small">שגיאה: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderUnknownBarcodePane(container, code, onAttach) {
  const products = store.catalog.products.slice(0, 1000);
  container.style.display = '';
  container.innerHTML = `<div class="h1">ברקוד לא מוכר</div><div class="small">${escapeHtml(code)}</div><div class="row" style="margin-top:10px"><div class="col"><label>חפש מוצר לפי שם/מק"ט</label><input id="unknownSearch" class="input"/></div><div class="col"><label>בחר מוצר</label><select id="unknownSku" class="input"><option value="">בחר...</option></select></div><button id="attachBarcodeBtn" class="btn btn-primary">שייך ברקוד למוצר</button></div><div id="unknownMsg" class="small"></div>`;
  const search = $('#unknownSearch');
  const select = $('#unknownSku');
  const fill = (q = '') => {
    select.innerHTML = '<option value="">בחר...</option>';
    const t = q.toLowerCase();
    products.filter((p) => {
      if (!t) return true;
      return String(p['שם מוצר'] || '').toLowerCase().includes(t) || String(p['מק"ט'] || '').toLowerCase().includes(t);
    }).slice(0, 80).forEach((p) => {
      const sku = String(p['מק"ט'] || '').trim();
      const opt = document.createElement('option');
      opt.value = sku;
      opt.textContent = `${sku} - ${String(p['שם מוצר'] || '').trim()}`;
      select.appendChild(opt);
    });
  };
  fill();
  search.addEventListener('input', () => fill(search.value.trim()));
  $('#attachBarcodeBtn').onclick = async () => {
    const sku = select.value;
    if (!sku) return;
    $('#unknownMsg').textContent = 'שומר...';
    try {
      await onAttach(sku);
      $('#unknownMsg').textContent = 'הברקוד שויך ✓';
    } catch (err) { $('#unknownMsg').textContent = 'שגיאה: ' + err.message; }
  };
}

function uniq(arr) { return [...new Set(arr)]; }
function fillSelect(sel, values) { values.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); }); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDate(v) { const d = new Date(v); return isNaN(d.getTime()) ? String(v || '') : d.toLocaleDateString('he-IL'); }
function fmtTime(v) { const d = new Date(v); return isNaN(d.getTime()) ? String(v || '') : d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }); }
function parseMovementTs(m) {
  const d = m['תאריך דיווח'];
  const t = m['שעת דיווח'];
  const combinedRaw = `${d || ''} ${t || ''}`.trim();
  const direct = new Date(combinedRaw).getTime();
  if (!isNaN(direct)) return direct;

  const dateRaw = String(d || '').trim();
  const timeRaw = String(t || '').trim() || '00:00:00';

  const isoMatch = dateRaw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const [, y, mo, da] = isoMatch;
    const ts = new Date(`${y}-${pad2(mo)}-${pad2(da)}T${normalizeTime(timeRaw)}`).getTime();
    if (!isNaN(ts)) return ts;
  }

  const localMatch = dateRaw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (localMatch) {
    let [, da, mo, y] = localMatch;
    if (y.length === 2) y = `20${y}`;
    const ts = new Date(`${y}-${pad2(mo)}-${pad2(da)}T${normalizeTime(timeRaw)}`).getTime();
    if (!isNaN(ts)) return ts;
  }

  return 0;
}

function normalizeTime(v) {
  const parts = String(v || '').trim().split(':').filter(Boolean);
  if (!parts.length) return '00:00:00';
  const h = pad2(parts[0]);
  const m = pad2(parts[1] || '00');
  const s = pad2(parts[2] || '00');
  return `${h}:${m}:${s}`;
}

function pad2(v) {
  return String(v || '0').padStart(2, '0');
}
