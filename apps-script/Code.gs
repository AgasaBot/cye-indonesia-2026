/**
 * CYE Indonesia 2026 — registration backend (Google Apps Script)
 * ------------------------------------------------------------------
 * Standalone script bound to the responses Google Sheet by ID.
 *
 * Receives JSON POSTs from the website registration form, appends a row to
 * the Sheet, saves uploaded files (business introduction deck + headshot) to
 * a Google Drive folder, emails the applicant a confirmation, and creates a
 * Midtrans Snap payment so the fee can be paid online.
 *
 * Payment is OPTIONAL — applicants can submit first and pay now or later.
 * The fee amount is decided HERE (server-side) so it can't be tampered with.
 *
 * Secrets live in Script Properties (Project Settings → Script Properties):
 *   MIDTRANS_SERVER_KEY    — Midtrans Server Key (sandbox or production)
 *   MIDTRANS_IS_PRODUCTION — 'true' for live, 'false'/absent for sandbox
 *
 * See SETUP.md for the one-time deploy steps.
 */

// If deploying as a STANDALONE script (script.new), put the responses
// spreadsheet ID here. If bound to the Sheet (Extensions → Apps Script), leave ''.
const SPREADSHEET_ID = '';
// Optional: receive an email copy of every new submission. Leave '' to skip.
const NOTIFY_EMAIL = 'cye-indonesia@jcinusantara.com';
// Drive folder where uploaded files are stored (created automatically).
const UPLOAD_FOLDER_NAME = 'CYE 2026 Submissions';
// Tab name inside the Sheet where rows are written.
const SHEET_NAME = 'Registrations';
// Public site URL (Midtrans payment redirect target).
const SITE_URL = 'https://cye-indonesia.com';
// This web app's own /exec URL — used as a per-transaction Midtrans notification
// URL (X-Override-Notification) so CYE payment notifications come here WITHOUT
// changing the account-wide notification setting (which another site uses).
const NOTIFICATION_URL = 'https://script.google.com/macros/s/AKfycbwY5zaPSyDHNjbjvBsBUbMrjWd_mMPWyywfEFBIFtsgkmodhG8D9gxC9dGezsCf6iwN/exec';

const HEADERS = ['Timestamp', 'Ref', 'Full name', 'Email', 'Phone', 'Age', 'City',
  'Business', 'Sector', 'Active for', 'JCI member', 'Participation',
  'Pitch video link', 'Business intro deck link', 'Business intro deck file', 'Headshot file',
  'Payment status', 'Amount (IDR)', 'Order ID', 'Paid at'];

/* ---------------- Midtrans config (secrets via Script Properties) ---------------- */
function cfg_() {
  const p = PropertiesService.getScriptProperties();
  return {
    serverKey: p.getProperty('MIDTRANS_SERVER_KEY') || '',
    isProd: (p.getProperty('MIDTRANS_IS_PRODUCTION') || 'false') === 'true'
  };
}
function appBase_() { return cfg_().isProd ? 'https://app.midtrans.com' : 'https://app.sandbox.midtrans.com'; }
function apiBase_() { return cfg_().isProd ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com'; }

// Early-bird IDR 200,000 before 1 Aug 2026 (WIB); IDR 300,000 from 1 Aug onwards.
function feeForToday_() {
  const cutoff = Date.UTC(2026, 6, 31, 17, 0, 0); // 2026-08-01 00:00:00 +07:00
  return (new Date().getTime() < cutoff) ? 200000 : 300000;
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // avoid two submissions clobbering the same row
  try {
    const data = JSON.parse(e.postData.contents);

    // (1) Midtrans server-to-server payment notification (webhook)
    if (data.transaction_status && data.signature_key) {
      return handleNotification_(data);
    }

    // (2) Frontend asking us to verify a payment after the Snap popup closes
    if (data.action === 'paymentCheck') {
      const st = midtransStatus_(data.order_id);
      const label = paymentLabel_(st.transaction_status, st.fraud_status);
      if (label) setPayment_(data.order_id, label, st.settlement_time || st.transaction_time);
      return json_({ ok: true, order_id: data.order_id, status: st.transaction_status || null, label: label });
    }

    // (3) New registration (default)
    const folder = getUploadFolder_(data.ref);
    const fileUrls = {};
    (data.files || []).forEach(function (f) {
      const blob = Utilities.newBlob(
        Utilities.base64Decode(f.dataBase64),
        f.type || 'application/octet-stream',
        f.name || f.field
      );
      fileUrls[f.field] = folder.createFile(blob).getUrl();
    });

    const durations = { 'under': '<3 months', '3-6': '3–6 months', '6-12': '6–12 months', '1-2': '1–2 years', '2plus': '2+ years' };
    const amount = feeForToday_();
    const sheet = getSheet_();
    const row = [
      data.submittedAt || new Date().toISOString(),
      data.ref || '',
      data.fullname || '', data.email || '', data.phone || '', data.age || '', data.city || '',
      data.business || '', data.sector || '', durations[data.duration] || data.duration || '',
      data.jci === 'yes' ? 'Yes' : 'No', data.participation || '',
      data.videolink || '', data.planlink || '',
      fileUrls.plan || '', fileUrls.headshot || '',
      'Unpaid', amount, data.ref || '', ''
    ];
    // Write as plain text so values like phone "+62..." aren't parsed as formulas.
    const target = sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length);
    target.setNumberFormat('@');
    target.setValues([row]);

    // Create a Midtrans Snap payment (optional — applicant may pay now or later).
    let snap = {};
    try { snap = createSnap_(data.ref, amount, data); } catch (e2) { snap = { error: String(e2) }; }

    if (data.email) sendConfirmation_(data, snap.redirect_url || '', amount);
    if (NOTIFY_EMAIL) notifyOrganizer_(data, fileUrls, amount);

    return json_({ ok: true, ref: data.ref, amount: amount, snapToken: snap.token || null, redirectUrl: snap.redirect_url || null });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Open the /exec URL in a browser to confirm the app is deployed.
function doGet() {
  return json_({ ok: true, service: 'CYE Indonesia 2026 registration' });
}

/* ---------------- Midtrans Snap + verification ---------------- */
function createSnap_(ref, amount, d) {
  const c = cfg_();
  if (!c.serverKey) return { error: 'MIDTRANS_SERVER_KEY not set' };
  const payload = {
    transaction_details: { order_id: ref, gross_amount: amount },
    item_details: [{ id: 'cye2026', price: amount, quantity: 1, name: 'CYE 2026 Registration Fee' }],
    customer_details: {
      first_name: (d.fullname || '').toString().slice(0, 50),
      email: d.email || '',
      phone: (d.phone || '').toString().slice(0, 30)
    },
    callbacks: { finish: SITE_URL + '/?paid=' + encodeURIComponent(ref) }
  };
  const res = UrlFetchApp.fetch(appBase_() + '/snap/v1/transactions', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(c.serverKey + ':'),
      // Route THIS transaction's payment notification to our own web app, so it
      // works even if the user closes the tab mid-redirect — without touching the
      // account-wide notification URL (used by jcinusantara.or.id).
      'X-Override-Notification': NOTIFICATION_URL
    },
    muteHttpExceptions: true,
    payload: JSON.stringify(payload)
  });
  return JSON.parse(res.getContentText());
}

function midtransStatus_(orderId) {
  const c = cfg_();
  const res = UrlFetchApp.fetch(apiBase_() + '/v2/' + encodeURIComponent(orderId) + '/status', {
    method: 'get',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(c.serverKey + ':'), Accept: 'application/json' },
    muteHttpExceptions: true
  });
  return JSON.parse(res.getContentText());
}

function handleNotification_(n) {
  const c = cfg_();
  const expected = sha512_('' + n.order_id + n.status_code + n.gross_amount + c.serverKey);
  if (expected !== n.signature_key) return json_({ ok: false, error: 'invalid signature' });
  const label = paymentLabel_(n.transaction_status, n.fraud_status);
  if (label) setPayment_(n.order_id, label, n.settlement_time || n.transaction_time);
  return json_({ ok: true });
}

function paymentLabel_(status, fraud) {
  if (status === 'capture') return (fraud === 'challenge') ? 'Pending (review)' : 'Paid';
  if (status === 'settlement') return 'Paid';
  if (status === 'pending') return 'Pending';
  if (status === 'deny') return 'Denied';
  if (status === 'cancel' || status === 'expire') return 'Cancelled/Expired';
  if (status === 'refund' || status === 'partial_refund') return 'Refunded';
  return status || '';
}

function setPayment_(orderId, label, when) {
  const sheet = getSheet_();
  const values = sheet.getDataRange().getValues();
  const head = values[0];
  const cO = head.indexOf('Order ID');
  const cS = head.indexOf('Payment status');
  const cP = head.indexOf('Paid at');
  const cEmail = head.indexOf('Email');
  const cName = head.indexOf('Full name');
  const cAmt = head.indexOf('Amount (IDR)');
  for (var r = 1; r < values.length; r++) {
    if (cO >= 0 && String(values[r][cO]) === String(orderId)) {
      const wasPaid = cS >= 0 && String(values[r][cS]) === 'Paid';
      if (cS >= 0) sheet.getRange(r + 1, cS + 1).setValue(label);
      if (cP >= 0 && label === 'Paid') sheet.getRange(r + 1, cP + 1).setValue(when || new Date().toISOString());
      // Email the applicant the first time payment is confirmed (guard against
      // duplicates if both the frontend check and the webhook fire).
      if (label === 'Paid' && !wasPaid && cEmail >= 0 && values[r][cEmail]) {
        sendPaymentReceived_(values[r][cEmail], cName >= 0 ? values[r][cName] : '', orderId, cAmt >= 0 ? values[r][cAmt] : '');
      }
      return true;
    }
  }
  return false;
}

function sendPaymentReceived_(email, name, ref, amount) {
  const amt = amount ? ('IDR ' + Number(amount).toLocaleString('en-US')) : 'your registration fee';
  const subject = 'CYE Indonesia 2026 — payment received (' + (ref || '') + ')';
  const body =
    'Hi ' + (name || '') + ',\n\n' +
    'We have received your registration fee payment of ' + amt + ' for the Creative Young ' +
    'Entrepreneur Award — Indonesia 2026. Your spot is confirmed.\n' +
    'Reference: ' + (ref || '') + '\n\n' +
    'Our team will be in touch with the next steps. May the best candidate win!\n\n' +
    'National Final: 3 October 2026 — APL Tower L22, Galilee Centre, Jakarta.\n\n' +
    'JCI Nusantara · CYE Indonesia 2026';
  MailApp.sendEmail(email, subject, body);
}

function sha512_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_512, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { b = (b < 0) ? b + 256 : b; var h = b.toString(16); return h.length === 1 ? '0' + h : h; }).join('');
}

/* ---------------- Sheet / Drive ---------------- */
function getSheet_() {
  const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  const n = HEADERS.length;
  const empty = sheet.getLastRow() === 0;
  const firstRow = empty ? [] : sheet.getRange(1, 1, 1, Math.max(n, sheet.getLastColumn())).getValues()[0];
  if (empty || firstRow[0] !== HEADERS[0] || firstRow[n - 1] !== HEADERS[n - 1]) {
    sheet.getRange(1, 1, 1, n).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getUploadFolder_(ref) {
  const it = DriveApp.getFoldersByName(UPLOAD_FOLDER_NAME);
  const root = it.hasNext() ? it.next() : DriveApp.createFolder(UPLOAD_FOLDER_NAME);
  return root.createFolder(ref || 'entry');
}

function sendConfirmation_(d, payUrl, amount) {
  const amt = 'IDR ' + Number(amount).toLocaleString('en-US');
  const subject = 'CYE Indonesia 2026 — registration received (' + (d.ref || '') + ')';
  let body =
    'Hi ' + (d.fullname || '') + ',\n\n' +
    'Thank you for registering for the Creative Young Entrepreneur Award — Indonesia 2026.\n' +
    'We have received your registration. Your reference number is ' + (d.ref || '') + '.\n\n' +
    'Registration fee: ' + amt + ' (early-bird before 1 August 2026; IDR 300,000 afterwards).\n';
  if (payUrl) {
    body += 'You can pay online securely anytime here:\n' + payUrl + '\n\n';
  } else {
    body += 'Our team will contact you on WhatsApp or email with the payment details.\n\n';
  }
  body +=
    'National Final: 3 October 2026 — APL Tower L22, Galilee Centre, Jakarta.\n\n' +
    'See you on the world stage,\nJCI Nusantara · CYE Indonesia 2026';
  MailApp.sendEmail(d.email, subject, body);
}

function notifyOrganizer_(d, fileUrls, amount) {
  const subject = 'New CYE 2026 registration: ' + (d.fullname || '') + ' (' + (d.ref || '') + ')';
  const lines = [
    'Ref: ' + (d.ref || ''), 'Name: ' + (d.fullname || ''), 'Email: ' + (d.email || ''),
    'Phone: ' + (d.phone || ''), 'Age: ' + (d.age || ''), 'City: ' + (d.city || ''),
    'Business: ' + (d.business || ''), 'Sector: ' + (d.sector || ''),
    'Participation: ' + (d.participation || ''), 'JCI member: ' + (d.jci || ''),
    'Pitch video: ' + (d.videolink || ''), 'Deck link: ' + (d.planlink || ''),
    'Deck file: ' + (fileUrls.plan || ''), 'Headshot: ' + (fileUrls.headshot || ''),
    'Fee: IDR ' + Number(amount || 0).toLocaleString('en-US') + ' (status: Unpaid at submission)'
  ];
  MailApp.sendEmail(NOTIFY_EMAIL, subject, lines.join('\n'));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
