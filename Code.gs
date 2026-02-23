/***************************************
 * Stock API - Google Apps Script Web App
 * - Auth (users sheet)
 * - Movements add (first truly-empty row)
 * - Product status (product row + last movements)
 * - Product update (role-based)
 * - Barcode add/delete
 * - Extra GET APIs: movements_list, barcodes_for_sku
 ****************************************/

const SPREADSHEET_ID = '1pYxc9sxHTORxjbyJUOyxwcUktQEKYXJ33W8P28Op57I';
const SHEET_PRODUCTS = 'מוצרים';
const SHEET_BARCODES = 'ברקודים';
const SHEET_MOVEMENTS = 'תנועות';
const SHEET_USERS = 'משתמשים';
const TOKEN_TTL_HOURS = 12;

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || '').trim();
    if (!action) return json({ ok: false, error: 'Missing action' });

    switch (action) {
      case 'ping':
        return json({ ok: true, message: 'pong', now: new Date().toISOString() });
      case 'product_status':
        requireAuth_(e);
        return json(productStatus_(e));
      case 'barcodes_for_sku':
        requireAuth_(e);
        return json(barcodesForSku_(e));
      case 'movements_list':
        requireAuth_(e);
        return json(movementsList_(e));
      default:
        return json({ ok: false, error: 'Unknown action', action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err), stack: safeStack_(err) });
  }
}

function doPost(e) {
  try {
    const body = (e && e.parameter) ? e.parameter : {};
    const action = String(body.action || '').trim();
    if (!action) return json({ ok: false, error: 'Missing action' });

    switch (action) {
      case 'auth_login':
        return json(authLogin_(body));
      case 'movement_add':
        requireAuthBody_(body);
        body.qty = Number(body.qty);
        return json(movementAdd_(body));
      case 'product_update':
        requireAuthBody_(body);
        body.fields = safeJsonParse_(body.fields, {});
        return json(productUpdate_(body));
      case 'barcode_add':
        requireAuthBody_(body);
        return json(barcodeAdd_(body));
      case 'barcode_delete':
        requireAuthBody_(body);
        return json(barcodeDelete_(body));
      default:
        return json({ ok: false, error: 'Unknown action', action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err), stack: safeStack_(err) });
  }
}

function authLogin_(body) {
  const userId = String(body.userId || '').trim();
  const code = String(body.code || '').trim();
  if (!userId || !code) return { ok: false, error: 'Missing userId/code' };

  const { user } = findUserById_(userId);
  if (!user) return { ok: false, error: 'User not found' };

  if (String(user['קוד'] || '').trim() !== code) return { ok: false, error: 'Invalid code' };

  const role = String(user['גישה'] || '').trim() || 'Editor';
  const userName = String(user['שם'] || '').trim() || userId;
  const token = issueToken_({ userId, role });
  return { ok: true, userId, userName, role, token };
}

function requireAuth_(e) {
  const token = String((e.parameter && e.parameter.token) || '').trim();
  if (!token) throw new Error('Missing token');
  const auth = verifyToken_(token);
  if (!auth.ok) throw new Error('Invalid token: ' + auth.error);
  return auth;
}

function requireAuthBody_(body) {
  const token = String(body.token || '').trim();
  if (!token) throw new Error('Missing token');
  const auth = verifyToken_(token);
  if (!auth.ok) throw new Error('Invalid token: ' + auth.error);
  body._auth = auth;
  return auth;
}

function issueToken_({ userId, role }) {
  const secret = getOrCreateSecret_();
  const ts = Date.now();
  const payload = `${userId}|${role}|${ts}`;
  const sig = hmacHex_(secret, payload);
  return Utilities.base64EncodeWebSafe(`${payload}|${sig}`);
}

function verifyToken_(token) {
  try {
    const secret = getOrCreateSecret_();
    const decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(token)).getDataAsString('UTF-8');
    const parts = decoded.split('|');
    if (parts.length !== 4) return { ok: false, error: 'Bad token format' };

    const [userId, role, tsStr, sig] = parts;
    const ts = Number(tsStr);
    if (!userId || !role || !ts || !sig) return { ok: false, error: 'Bad token parts' };

    const expected = hmacHex_(secret, `${userId}|${role}|${ts}`);
    if (expected !== sig) return { ok: false, error: 'Bad signature' };

    const ttlMs = TOKEN_TTL_HOURS * 60 * 60 * 1000;
    if ((Date.now() - ts) > ttlMs) return { ok: false, error: 'Token expired' };

    return { ok: true, userId, role, issuedAt: ts };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

function getOrCreateSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('TOKEN_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', secret);
  }
  return secret;
}

function hmacHex_(secret, message) {
  const sigBytes = Utilities.computeHmacSha256Signature(message, secret);
  return sigBytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function movementAdd_(body) {
  const auth = body._auth;
  const source = String(body.source || '').trim();
  const sku = String(body.sku || '').trim();
  const barcode = String(body.barcode || '').trim();
  const qty = Number(body.qty);
  const notes = String(body.notes || '').trim();

  if (!sku) return { ok: false, error: 'Missing sku' };
  if (!barcode) return { ok: false, error: 'Missing barcode' };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: 'Invalid qty' };
  if (source !== 'כניסה' && source !== 'יציאה') return { ok: false, error: 'Invalid source' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const shMov = ss_().getSheetByName(SHEET_MOVEMENTS);
    if (!shMov) throw new Error('Missing sheet: ' + SHEET_MOVEMENTS);

    const product = findProductBySku_(sku);
    const productName = product ? String(product['שם מוצר'] || '').trim() : '';
    const user = findUserById_(auth.userId).user;
    const reporterName = String((user && user['שם']) || '').trim();

    const now = new Date();
    const dateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const timeOnly = new Date(1970, 0, 1, now.getHours(), now.getMinutes(), now.getSeconds());

    const headerMap = getHeaderMap_(shMov);
    const row = new Array(shMov.getLastColumn()).fill('');
    setByHeader_(row, headerMap, 'מק"ט', sku);
    setByHeader_(row, headerMap, 'שם מוצר', productName);
    setByHeader_(row, headerMap, 'ברקוד', barcode);
    setByHeader_(row, headerMap, 'כמות', qty);
    setByHeader_(row, headerMap, 'מקור', source);
    setByHeader_(row, headerMap, 'ID מדווח', auth.userId);
    setByHeader_(row, headerMap, 'שם מדווח', reporterName);
    setByHeader_(row, headerMap, 'הערות', notes);
    setByHeader_(row, headerMap, 'תאריך דיווח', dateOnly);
    setByHeader_(row, headerMap, 'שעת דיווח', timeOnly);

    const targetRow = findFirstEmptyByHeader_(shMov, headerMap, 'תאריך דיווח');
    shMov.getRange(targetRow, 1, 1, row.length).setValues([row]);

    return { ok: true, row: targetRow, sku, barcode, qty, source };
  } finally {
    lock.releaseLock();
  }
}

function productStatus_(e) {
  const sku = String((e.parameter && e.parameter.sku) || '').trim();
  const barcode = String((e.parameter && e.parameter.barcode) || '').trim();

  let resolvedSku = sku;
  if (!resolvedSku && barcode) resolvedSku = findSkuByBarcode_(barcode);
  if (!resolvedSku) return { ok: false, error: 'Missing sku or barcode (or not found)' };

  const product = findProductBySku_(resolvedSku);
  if (!product) return { ok: false, error: 'Product not found for sku: ' + resolvedSku };

  return { ok: true, sku: resolvedSku, product, lastMovements: getLastMovementsBySku_(resolvedSku, 5) };
}

function movementsList_(e) {
  const sku = String((e.parameter && e.parameter.sku) || '').trim();
  const sh = ss_().getSheetByName(SHEET_MOVEMENTS);
  if (!sh) throw new Error('Missing sheet: ' + SHEET_MOVEMENTS);

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, movements: [] };

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const values = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();

  const out = [];
  const skuIdx = headers.indexOf('מק"ט');
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (sku && skuIdx >= 0 && String(row[skuIdx] || '').trim() !== sku) continue;
    if (skuIdx >= 0 && !String(row[skuIdx] || '').trim()) continue;
    const obj = {};
    headers.forEach((h, j) => obj[h] = row[j]);
    out.push(obj);
  }
  return { ok: true, movements: out };
}

function barcodesForSku_(e) {
  const sku = String((e.parameter && e.parameter.sku) || '').trim();
  if (!sku) return { ok: false, error: 'Missing sku' };

  const sh = ss_().getSheetByName(SHEET_BARCODES);
  if (!sh) throw new Error('Missing sheet: ' + SHEET_BARCODES);
  const headerMap = getHeaderMap_(sh);
  const colSku = headerMap['מק"ט מוצר'];
  const colBarcode = headerMap['ברקוד'];
  if (!colSku || !colBarcode) throw new Error('Missing columns in ברקודים');

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, sku, barcodes: [] };

  const values = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  const barcodes = [];
  for (let i = 0; i < values.length; i++) {
    const s = String(values[i][colSku - 1] || '').trim();
    const b = String(values[i][colBarcode - 1] || '').trim();
    if (s === sku && b) barcodes.push({ barcode: b, rowNum: i + 2 });
  }
  return { ok: true, sku, barcodes };
}

function productUpdate_(body) {
  const auth = body._auth;
  const sku = String(body.sku || '').trim();
  const fields = body.fields || {};
  if (!sku) return { ok: false, error: 'Missing sku' };
  if (!fields || typeof fields !== 'object') return { ok: false, error: 'Missing fields object' };

  const editorAllowed = new Set(['שם מוצר', 'ספק', 'מותג', 'פסח']);
  const adminAllowed = new Set(['שם מוצר', 'ספק', 'מותג', 'פסח', 'מק"ט', 'קוד מזהה', 'מעמ', 'תמונה', 'ברקוד', 'מצב מלאי מחסן', 'מצב מלאי ליקוט']);
  const allowed = auth.role === 'Admin' ? adminAllowed : editorAllowed;

  const sh = ss_().getSheetByName(SHEET_PRODUCTS);
  if (!sh) throw new Error('Missing sheet: ' + SHEET_PRODUCTS);

  const headerMap = getHeaderMap_(sh);
  const skuCol = headerMap['מק"ט'];
  if (!skuCol) throw new Error('Missing column: מק"ט');

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'No products data' };

  const skuValues = sh.getRange(2, skuCol, lastRow - 1, 1).getValues().map(r => String(r[0]).trim());
  const idx = skuValues.indexOf(sku);
  if (idx < 0) return { ok: false, error: 'SKU not found: ' + sku };
  const rowNum = idx + 2;

  const updates = [];
  Object.keys(fields).forEach((key) => {
    const colName = String(key).trim();
    if (!allowed.has(colName)) return;
    const col = headerMap[colName];
    if (!col) return;
    updates.push({ colName, col, value: fields[key] });
  });
  if (!updates.length) return { ok: false, error: 'No allowed fields to update' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    updates.forEach(u => sh.getRange(rowNum, u.col).setValue(u.value));
  } finally {
    lock.releaseLock();
  }

  return { ok: true, sku, updated: updates.map(u => u.colName), row: rowNum };
}

function barcodeAdd_(body) {
  const sku = String(body.sku || '').trim();
  const barcode = String(body.barcode || '').trim();
  if (!sku) return { ok: false, error: 'Missing sku' };
  if (!barcode) return { ok: false, error: 'Missing barcode' };

  const product = findProductBySku_(sku);
  if (!product) return { ok: false, error: 'SKU not found in products: ' + sku };

  const sh = ss_().getSheetByName(SHEET_BARCODES);
  if (!sh) throw new Error('Missing sheet: ' + SHEET_BARCODES);
  const headerMap = getHeaderMap_(sh);

  const row = new Array(sh.getLastColumn()).fill('');
  setByHeader_(row, headerMap, 'מק"ט מוצר', sku);
  setByHeader_(row, headerMap, 'שם מוצר', String(product['שם מוצר'] || '').trim());
  setByHeader_(row, headerMap, 'ברקוד', barcode);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const targetRow = findFirstEmptyRowByHeaders_(sh, headerMap, ['מק"ט מוצר', 'ברקוד']);
    sh.getRange(targetRow, 1, 1, row.length).setValues([row]);
    return { ok: true, sku, barcode, row: targetRow };
  } finally {
    lock.releaseLock();
  }
}

function barcodeDelete_(body) {
  const auth = body._auth;
  if (auth.role !== 'Admin') return { ok: false, error: 'Admin only' };

  const sku = String(body.sku || '').trim();
  const barcode = String(body.barcode || '').trim();
  if (!barcode) return { ok: false, error: 'Missing barcode' };

  const sh = ss_().getSheetByName(SHEET_BARCODES);
  if (!sh) throw new Error('Missing sheet: ' + SHEET_BARCODES);

  const headerMap = getHeaderMap_(sh);
  const colBarcode = headerMap['ברקוד'];
  const colSku = headerMap['מק"ט מוצר'];
  if (!colBarcode) throw new Error('Missing column: ברקוד');

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'No barcodes data' };

  const values = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  let rowNum = -1;
  for (let i = 0; i < values.length; i++) {
    const b = String(values[i][colBarcode - 1] || '').trim();
    const s = colSku ? String(values[i][colSku - 1] || '').trim() : '';
    if (b === barcode && (!sku || s === sku)) {
      rowNum = i + 2;
      break;
    }
  }
  if (rowNum < 2) return { ok: false, error: 'Barcode not found' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sh.deleteRow(rowNum);
  } finally {
    lock.releaseLock();
  }

  return { ok: true, deletedRow: rowNum, barcode };
}

function ss_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getHeaderMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h, i) => {
    const key = String(h).trim();
    if (key) map[key] = i + 1;
  });
  return map;
}

function setByHeader_(rowArr, headerMap, headerName, value) {
  const col = headerMap[headerName];
  if (!col) return;
  rowArr[col - 1] = value;
}

function findFirstEmptyRowByHeaders_(sheet, headerMap, keyHeaders) {
  const cols = keyHeaders.map(h => headerMap[h]).filter(Boolean);
  if (!cols.length) return Math.max(2, sheet.getLastRow() + 1);

  const lastRow = Math.max(2, sheet.getLastRow());
  if (lastRow < 2) return 2;

  const rowCount = Math.max(0, lastRow - 1);
  if (!rowCount) return 2;

  const colValues = cols.map(col => sheet.getRange(2, col, rowCount, 1).getValues());
  for (let i = 0; i < rowCount; i++) {
    const occupied = colValues.some(arr => String(arr[i][0] || '').trim() !== '');
    if (!occupied) return i + 2;
  }
  return lastRow + 1;
}

function findFirstEmptyByHeader_(sheet, headerMap, headerName) {
  const col = headerMap[headerName];
  if (!col) return Math.max(2, sheet.getLastRow() + 1);

  const lastRow = Math.max(2, sheet.getLastRow());
  const rowCount = Math.max(0, lastRow - 1);
  if (!rowCount) return 2;

  const values = sheet.getRange(2, col, rowCount, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === '') return i + 2;
  }
  return lastRow + 1;
}

function findUserById_(userId) {
  const sh = ss_().getSheetByName(SHEET_USERS);
  if (!sh) throw new Error('Missing sheet: ' + SHEET_USERS);

  const headerMap = getHeaderMap_(sh);
  const colId = headerMap['ID'];
  if (!colId) throw new Error('Missing column: ID');

  const target = normalizeId_(userId);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { user: null, rowIndex: -1 };

  const ids = sh.getRange(2, colId, lastRow - 1, 1).getValues().map(r => normalizeId_(r[0]));
  const idx = ids.indexOf(target);
  if (idx < 0) return { user: null, rowIndex: -1 };

  const rowNum = idx + 2;
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rowVals = sh.getRange(rowNum, 1, 1, sh.getLastColumn()).getValues()[0];
  const obj = {};
  headers.forEach((h, i) => obj[String(h).trim()] = rowVals[i]);
  return { user: obj, rowIndex: idx };
}

function normalizeId_(v) {
  let s = String(v == null ? '' : v).trim();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  return s;
}

function findProductBySku_(sku) {
  const sh = ss_().getSheetByName(SHEET_PRODUCTS);
  if (!sh) throw new Error('Missing sheet: ' + SHEET_PRODUCTS);

  const headerMap = getHeaderMap_(sh);
  const colSku = headerMap['מק"ט'];
  if (!colSku) throw new Error('Missing column: מק"ט');

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;

  const skus = sh.getRange(2, colSku, lastRow - 1, 1).getValues().map(r => String(r[0] || '').trim());
  const idx = skus.indexOf(sku);
  if (idx < 0) return null;

  const rowNum = idx + 2;
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rowVals = sh.getRange(rowNum, 1, 1, sh.getLastColumn()).getValues()[0];
  const out = {};
  headers.forEach((h, i) => out[String(h).trim()] = rowVals[i]);
  out._row = rowNum;
  return out;
}

function findSkuByBarcode_(barcode) {
  const sh = ss_().getSheetByName(SHEET_BARCODES);
  if (!sh) throw new Error('Missing sheet: ' + SHEET_BARCODES);

  const headerMap = getHeaderMap_(sh);
  const colBarcode = headerMap['ברקוד'];
  const colSku = headerMap['מק"ט מוצר'];
  if (!colBarcode || !colSku) throw new Error('Missing columns in ברקודים');

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return '';

  const values = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  for (let i = 0; i < values.length; i++) {
    const b = String(values[i][colBarcode - 1] || '').trim();
    if (b === barcode) return String(values[i][colSku - 1] || '').trim();
  }
  return '';
}

function getLastMovementsBySku_(sku, limit) {
  const sh = ss_().getSheetByName(SHEET_MOVEMENTS);
  if (!sh) throw new Error('Missing sheet: ' + SHEET_MOVEMENTS);

  const headerMap = getHeaderMap_(sh);
  const colSku = headerMap['מק"ט'];
  if (!colSku) throw new Error('Missing column: מק"ט in תנועות');

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const values = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();

  const rows = [];
  for (let i = values.length - 1; i >= 0; i--) {
    if (String(values[i][colSku - 1] || '').trim() !== sku) continue;
    const obj = {};
    headers.forEach((h, j) => obj[h] = values[i][j]);
    rows.push(obj);
    if (rows.length >= limit) break;
  }
  return rows;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function safeStack_(err) {
  try {
    const s = err && err.stack ? String(err.stack) : '';
    return s.split('\n').slice(0, 6).join('\n');
  } catch (_) {
    return '';
  }
}

function safeJsonParse_(s, fallback) {
  try { return JSON.parse(String(s || '')); } catch (_) { return fallback; }
}
