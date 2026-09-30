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

// Early-bird IDR 200,000 through 14 Aug 2026 (WIB); IDR 300,000 from 15 Aug onwards.
function feeForToday_() {
  const cutoff = Date.UTC(2026, 7, 14, 17, 0, 0); // 2026-08-15 00:00:00 +07:00
  return (new Date().getTime() < cutoff) ? 200000 : 300000;
}

// Admin-only: add a participant who registered & paid OFFLINE, straight in as Paid.
// Guarded by a shared passcode stored in Script Properties (ADMIN_PASSCODE) so the
// public /exec endpoint can't be used to inject fake paid rows.
function handleManualEntry_(data) {
  const pass = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSCODE') || '';
  if (!pass) return json_({ ok: false, error: 'Server not set up: ADMIN_PASSCODE is missing.' });
  if (String(data.passcode || '') !== pass) return json_({ ok: false, error: 'Wrong passcode.' });
  if (!data.fullname || !data.email) return json_({ ok: false, error: 'Name and email are required.' });

  const durations = { 'under': '<3 months', '3-6': '3–6 months', '6-12': '6–12 months', '1-2': '1–2 years', '2plus': '2+ years' };
  const ref = 'CYE-2026-M' + Math.floor(10000 + Math.random() * 90000);
  const amount = Number(data.amount) > 0 ? Math.round(Number(data.amount)) : 200000;
  const paidAt = data.paidAt || new Date().toISOString().slice(0, 10);
  const paidNote = 'Manual — ' + paidAt + (data.note ? (' · ' + data.note) : '');

  const sheet = getSheet_();
  const row = [
    new Date().toISOString(),
    ref,
    data.fullname || '', data.email || '', data.phone || '', data.age || '', data.city || '',
    data.business || '', data.sector || '', durations[data.duration] || data.duration || '',
    data.jci === 'yes' ? 'Yes' : 'No', data.participation || '',
    data.videolink || '', data.planlink || '',
    '', '',                 // deck file / headshot file — not collected on manual entry
    'Paid', amount, ref, paidNote
  ];
  // Write as plain text so values like phone "+62..." aren't parsed as formulas.
  const target = sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length);
  target.setNumberFormat('@');
  target.setValues([row]);

  // Confirm to the participant that their (already-paid) spot is secured.
  if (data.email) { try { sendPaymentReceived_(data.email, data.fullname || '', ref, amount); } catch (e) {} }
  // Copy the organizer inbox, flagged as a manual entry.
  if (NOTIFY_EMAIL) {
    try {
      MailApp.sendEmail(NOTIFY_EMAIL,
        'Manual CYE 2026 entry (PAID): ' + (data.fullname || '') + ' (' + ref + ')',
        ['Added manually as PAID (registered/paid offline).',
         'Ref: ' + ref, 'Name: ' + (data.fullname || ''), 'Email: ' + (data.email || ''),
         'Phone: ' + (data.phone || ''), 'Business: ' + (data.business || ''),
         'Amount: IDR ' + Number(amount).toLocaleString('en-US'), 'Paid: ' + paidNote].join('\n'));
    } catch (e) {}
  }

  return json_({ ok: true, ref: ref, amount: amount });
}

// Admin-only: attach submission files (deck, video link, headshot) to an EXISTING
// registration — for participants who registered/paid but haven't submitted yet.
// Finds the row by Ref (preferred) or Email, uploads any files to Drive, and writes
// the URLs/links into that row's submission columns (only the fields provided).
function handleManualFiles_(data) {
  const pass = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSCODE') || '';
  if (!pass) return json_({ ok: false, error: 'Server not set up: ADMIN_PASSCODE is missing.' });
  if (String(data.passcode || '') !== pass) return json_({ ok: false, error: 'Wrong passcode.' });

  const lookup = String(data.lookup || '').trim();
  if (!lookup) return json_({ ok: false, error: 'Enter the participant Ref or email to find them.' });

  const sheet = getSheet_();
  const values = sheet.getDataRange().getValues();
  const head = values[0];
  const cRef = head.indexOf('Ref');
  const cEmail = head.indexOf('Email');
  const cName = head.indexOf('Full name');
  const cVideo = head.indexOf('Pitch video link');
  const cDeckLink = head.indexOf('Business intro deck link');
  const cDeckFile = head.indexOf('Business intro deck file');
  const cHeadshot = head.indexOf('Headshot file');

  const byRef = /^CYE-/i.test(lookup);
  const want = lookup.toLowerCase();
  const rows = [];
  for (var i = 1; i < values.length; i++) {
    const col = byRef ? cRef : cEmail;
    if (col >= 0 && String(values[i][col] || '').trim().toLowerCase() === want) rows.push(i);
  }
  if (rows.length === 0) return json_({ ok: false, error: 'No registration found for "' + lookup + '".' });
  if (rows.length > 1) return json_({ ok: false, error: 'More than one row matches that email — use the exact Ref (column B) instead.' });

  const r = rows[0];
  const ref = String(values[r][cRef] || ('row' + (r + 1)));

  // Save any uploaded files to the participant's Drive folder.
  const fileUrls = {};
  const files = data.files || [];
  if (files.length) {
    const folder = getUploadFolder_(ref);
    files.forEach(function (f) {
      if (!f || !f.dataBase64) return;
      const blob = Utilities.newBlob(Utilities.base64Decode(f.dataBase64), f.type || 'application/octet-stream', f.name || f.field);
      fileUrls[f.field] = folder.createFile(blob).getUrl();
    });
  }

  const updated = [];
  function setCell(col, val, labelText) {
    if (col >= 0 && val) { sheet.getRange(r + 1, col + 1).setValue(val); updated.push(labelText); }
  }
  setCell(cVideo, String(data.videolink || '').trim(), 'pitch video');
  setCell(cDeckLink, String(data.planlink || '').trim(), 'deck link');
  setCell(cDeckFile, fileUrls.plan || '', 'deck file');
  setCell(cHeadshot, fileUrls.headshot || '', 'headshot');

  if (!updated.length) return json_({ ok: false, error: 'Nothing to save — add a file or link first.' });

  const name = cName >= 0 ? String(values[r][cName] || '') : '';
  if (NOTIFY_EMAIL) {
    try {
      MailApp.sendEmail(NOTIFY_EMAIL,
        'CYE 2026 files attached: ' + name + ' (' + ref + ')',
        ['Submission materials added to an existing registration.',
         'Ref: ' + ref, 'Name: ' + name, 'Updated: ' + updated.join(', '),
         'Video: ' + (data.videolink || '—'), 'Deck link: ' + (data.planlink || '—'),
         'Deck file: ' + (fileUrls.plan || '—'), 'Headshot: ' + (fileUrls.headshot || '—')].join('\n'));
    } catch (e) {}
  }

  return json_({ ok: true, ref: ref, name: name, updated: updated });
}

// Admin-only: list of registrations still missing submission materials
// (video / deck / headshot). Passcode-gated, so it returns full names for the admin.
function handlePendingList_(data) {
  const pass = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSCODE') || '';
  if (!pass) return json_({ ok: false, error: 'Server not set up: ADMIN_PASSCODE is missing.' });
  if (String(data.passcode || '') !== pass) return json_({ ok: false, error: 'Wrong passcode.' });

  const sheet = getSheet_();
  const values = sheet.getDataRange().getValues();
  const head = values[0];
  const cRef = head.indexOf('Ref');
  const cName = head.indexOf('Full name');
  const cBiz = head.indexOf('Business');
  const cCity = head.indexOf('City');
  const cVideo = head.indexOf('Pitch video link');
  const cDeckLink = head.indexOf('Business intro deck link');
  const cDeckFile = head.indexOf('Business intro deck file');
  const cHeadshot = head.indexOf('Headshot file');

  const has = function (row, c) { return c >= 0 && String(row[c] || '').trim() !== ''; };
  const pending = [];
  for (var i = 1; i < values.length; i++) {
    const row = values[i];
    const ref = String(row[cRef] || '').trim();
    if (!ref) continue;
    const missing = [];
    if (!has(row, cVideo)) missing.push('video');
    if (!(has(row, cDeckFile) || has(row, cDeckLink))) missing.push('deck');
    if (!has(row, cHeadshot)) missing.push('headshot');
    if (!missing.length) continue;
    pending.push({
      ref: ref,
      name: cName >= 0 ? String(row[cName] || '') : '',
      business: cBiz >= 0 ? String(row[cBiz] || '') : '',
      city: cCity >= 0 ? String(row[cCity] || '') : '',
      missing: missing
    });
  }
  return json_({ ok: true, count: pending.length, pending: pending });
}

function doPost(e) {
  // Judge-tool + read-only admin actions skip the global lock: reads don't need it, and the two
  // writers (saveScore / reopenScore) take the lock themselves for their short write. Holding one
  // lock around every request made all judges' refreshes and saves queue up single-file.
  var early = null;
  try { early = JSON.parse(e.postData.contents); } catch (x) {}
  var FAST = { judgeNames: handleJudgeNames_, judgeLogin: handleJudgeLogin_, judgeData: handleJudgeData_,
               saveScore: handleSaveScore_, reopenScore: handleReopenScore_, adminScores: handleAdminScores_,
               setFinalists: handleSetFinalists_, pendingList: handlePendingList_ };
  if (early && early.action && Object.prototype.hasOwnProperty.call(FAST, early.action)) {
    try { return FAST[early.action](early); }
    catch (err) { return json_({ ok: false, error: String((err && err.message) || err) }); }
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // avoid two submissions clobbering the same row
  try {
    const data = JSON.parse(e.postData.contents);

    // (0) Admin: manually add an already-paid participant (registered offline).
    if (data.action === 'manualEntry') {
      return handleManualEntry_(data);
    }

    // (0b) Admin: attach submission files/links to an EXISTING registration row.
    if (data.action === 'manualFiles') {
      return handleManualFiles_(data);
    }

    // (0c/0d) pendingList and the judge-tool actions are dispatched above, before the lock.

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
    'Registration fee: ' + amt + ' (early-bird through 14 August 2026; IDR 300,000 afterwards).\n';
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

/* =====================================================================
 * JUDGE SCORING TOOL (Semifinal + Final)
 * ---------------------------------------------------------------------
 * Judges log in (name + password from the "Judges" tab), score each
 * semifinalist across the 5 criteria (total /100), and lock each score.
 * A judge may reopen only their 3 most-recently-locked scores. Once all
 * active judges have locked a participant, its average = drop the highest
 * and lowest total, then average the rest (with 6 judges, the middle 4).
 * The Final works the same way for the Top 4: the admin picks them (in
 * pitch order) on /scores-admin, which fills the "Finalists" tab; their
 * scores go to "Final Scores", and the winner is the top Final average.
 * All data lives in the same spreadsheet: tabs "Judges", "Semifinalists",
 * "Scores", "Finalists", "Final Scores" (each created on first use).
 * =================================================================== */

const JUDGE_CRITERIA = [
  { key: 'impact',       label: 'Community & Social Impact',         max: 15 },
  { key: 'business',     label: 'Business & International Impact',    max: 25 },
  { key: 'innovation',   label: 'Innovation & Originality',          max: 20 },
  { key: 'leadership',   label: 'Leadership Ability',                max: 20 },
  { key: 'presentation', label: 'Clarity & Quality of Presentation', max: 20 }
];
const JUDGES_SHEET = 'Judges';
const SEMIS_SHEET  = 'Semifinalists';
const SCORES_SHEET = 'Scores';
const FINALISTS_SHEET    = 'Finalists';     // the Top 4, written by the admin's "Start the Final"
const FINAL_SCORES_SHEET = 'Final Scores';
const FINAL_SIZE = 4;
const REOPEN_WINDOW = 3; // a judge can reopen their N most-recently-locked scores (per round)
const JUDGE_API = 2;     // tells the pages this backend understands rounds (Semifinal / Final)

// Seed data — written to the tabs the first time they're read (if empty).
// Passwords are NOT kept in code (this repo is public). Set each judge's password in the
// "Judges" tab; a judge whose Password cell is blank cannot log in.
const DEFAULT_JUDGES = [
  ['Rico Tedyono', '', true],
  ['Darwin Tjoe', '', true],
  ['Imelda Lim', '', true],
  ['Natali Ardianto', '', true],
  ['Dr. Anggara Hayun Anujuprana', '', true],
  ['Steven Leong', '', true]
];
const SEMIFINALIST_NAMES = [
  'Al Fath Nuur Rochman', 'Nadia Nathania', 'Alpvy Ramadhan', 'Clarabelle Laura Suhandinata',
  'Yessi Calissa', 'Salsabilla Mazaya Ramadhani', 'Fahrizal Maulana', 'Jessica Diana Kartika',
  'Gilbert Xervaxius Naphan', 'Arvega Andika Putra', 'Sidhi Umbara', 'Anastasia Laura Widjaja',
  'Felicia Magdalena Limantoro', 'Bobby Yulandika Putra', 'Victor Osman', 'Ramzi Putera Faisal',
  'Joshua William', 'Redha Bhawika Putra', 'Ilham Pinastiko', 'Fielien Kosasih'
];

// Opened once per request (each web-app call is its own execution) instead of on every tab read.
var SS_BOOK_ = null;
function ssBook_() {
  if (!SS_BOOK_) SS_BOOK_ = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  return SS_BOOK_;
}

// Judges + Semifinalists barely change, yet every refresh/save re-read them from the sheet.
// Cache them for 30s (edits to those tabs show up within 30 seconds).
function cachedRead_(key, fn) {
  const c = CacheService.getScriptCache();
  const hit = c.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const val = fn();
  try { c.put(key, JSON.stringify(val), 30); } catch (e) {}
  return val;
}
function judgesCached_() { return cachedRead_('cye_judges_v1', getJudges_); }
function semisCached_()  { return cachedRead_('cye_semis_v1', getSemifinalists_); }
function finalistsCached_() { return cachedRead_('cye_finalists_v1', getFinalists_); }

/* ---- rounds: the Semifinal and the Final share every scoring rule (criteria, locking, reopen
 * window, trimmed average); each has its own participant tab and its own score tab. ---- */
function roundOf_(data) { return String((data && data.round) || '') === 'final' ? 'final' : 'semi'; }
function participantsFor_(round) { return round === 'final' ? finalistsCached_() : semisCached_(); }

/* ---- auth: token binds a judge name to a server secret ---- */
// Signing secret for judge sessions. Created randomly the first time it's needed and kept in
// Script Properties (JUDGE_SECRET) — never in code, since this repository is public.
// Changing/deleting it logs every judge out (they just sign in again).
function judgeSecret_() {
  const props = PropertiesService.getScriptProperties();
  var s = props.getProperty('JUDGE_SECRET');
  if (s) return s;
  const lk = LockService.getScriptLock(); lk.waitLock(10000);
  try {
    s = props.getProperty('JUDGE_SECRET');
    if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('JUDGE_SECRET', s); }
    return s;
  } finally { lk.releaseLock(); }
}
function judgeToken_(name) {
  const sig = Utilities.computeHmacSha256Signature(String(name), judgeSecret_());
  const hex = sig.map(function (b) { b = (b < 0) ? b + 256 : b; return ('0' + b.toString(16)).slice(-2); }).join('');
  return String(name) + '|' + hex.slice(0, 24);
}
function judgeFromToken_(token) {
  token = String(token || '');
  const i = token.lastIndexOf('|');
  if (i < 1) return '';
  const name = token.slice(0, i);
  if (judgeToken_(name) !== token) return '';
  // The judge must still be active under that exact name — a renamed or deactivated judge signs in
  // again, so their scores can never land under a name the averages no longer count.
  return judgesCached_().some(function (j) { return j.active && j.name === name; }) ? name : '';
}

/* ---- data readers ---- */
function getJudges_() {
  const ss = ssBook_();
  let sh = ss.getSheetByName(JUDGES_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    sh = sh || ss.insertSheet(JUDGES_SHEET);
    sh.clear();
    sh.getRange(1, 1, 1, 3).setValues([['Name', 'Password', 'Active']]);
    sh.getRange(2, 1, DEFAULT_JUDGES.length, 3).setValues(DEFAULT_JUDGES);
    sh.setFrozenRows(1);
  }
  const v = sh.getDataRange().getValues();
  const head = v[0];
  const cN = head.indexOf('Name'), cP = head.indexOf('Password'), cA = head.indexOf('Active');
  const out = [];
  for (var i = 1; i < v.length; i++) {
    var name = String(v[i][cN] || '').trim();
    if (!name) continue;
    var act = cA < 0 ? true : (String(v[i][cA]).toUpperCase().indexOf('FALSE') < 0 && String(v[i][cA]).toUpperCase().indexOf('NO') !== 0);
    out.push({ name: name, password: String(v[i][cP] || ''), active: act });
  }
  return out;
}

function getSemifinalists_() {
  const ss = ssBook_();
  let sh = ss.getSheetByName(SEMIS_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    sh = sh || ss.insertSheet(SEMIS_SHEET);
    // match each name to its business from the Registrations tab (best effort, one time)
    const reg = getSheet_().getDataRange().getValues();
    const rh = reg[0], rcN = rh.indexOf('Full name'), rcB = rh.indexOf('Business');
    const norm = function (s) { return String(s || '').toLowerCase().split(' ').filter(function (w) { return w; }).join(' '); };
    const biz = {};
    for (var r = 1; r < reg.length; r++) { var nm = norm(reg[r][rcN]); if (nm) biz[nm] = String(reg[r][rcB] || ''); }
    const rows = SEMIFINALIST_NAMES.map(function (nm, i) { return [i + 1, nm, biz[norm(nm)] || '']; });
    sh.clear();
    sh.getRange(1, 1, 1, 3).setValues([['Seq', 'Name', 'Company']]);
    sh.getRange(2, 1, rows.length, 3).setValues(rows);
    sh.setFrozenRows(1);
  }
  const v = sh.getDataRange().getValues();
  const head = v[0];
  const cS = head.indexOf('Seq'), cN = head.indexOf('Name'), cC = head.indexOf('Company');
  const out = [];
  for (var i = 1; i < v.length; i++) {
    var name = String(v[i][cN] || '').trim();
    if (!name) continue;
    out.push({ seq: Number(v[i][cS]) || i, name: name, company: String(v[i][cC] || '').trim() });
  }
  out.sort(function (a, b) { return a.seq - b.seq; });
  return out;
}

// Filled by the admin's "Start the Final" (setFinalists): the Top 4 in their Final pitch order.
// An empty tab means the Final hasn't started yet.
function getFinalists_() {
  const sh = ssBook_().getSheetByName(FINALISTS_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getDataRange().getValues();
  const head = v[0];
  const cS = head.indexOf('Seq'), cN = head.indexOf('Name'), cC = head.indexOf('Company'), cF = head.indexOf('Semifinal #');
  const out = [];
  for (var i = 1; i < v.length; i++) {
    var name = String(v[i][cN] || '').trim();
    if (!name) continue;
    out.push({ seq: Number(v[i][cS]) || i, name: name, company: String(v[i][cC] || '').trim(),
               semiSeq: cF < 0 ? null : (Number(v[i][cF]) || null) });
  }
  out.sort(function (a, b) { return a.seq - b.seq; });
  return out;
}

function getScoresSheet_(round) {
  const ss = ssBook_();
  const tab = round === 'final' ? FINAL_SCORES_SHEET : SCORES_SHEET;
  const headers = ['Judge', 'Seq', 'Participant']
    .concat(JUDGE_CRITERIA.map(function (c) { return c.label + ' /' + c.max; }))
    .concat(['Total', 'Locked', 'Locked at']);
  let sh = ss.getSheetByName(tab);
  if (!sh) sh = ss.insertSheet(tab);
  if (sh.getLastRow() === 0) { sh.getRange(1, 1, 1, headers.length).setValues([headers]); sh.setFrozenRows(1); }
  return sh;
}

function readScores_(round) {
  const sh = getScoresSheet_(round);
  if (sh.getLastRow() < 2) return [];
  const v = sh.getDataRange().getValues();
  const nC = JUDGE_CRITERIA.length;
  const out = [];
  for (var i = 1; i < v.length; i++) {
    var judge = String(v[i][0] || '').trim();
    if (!judge) continue;
    var scores = [];
    for (var k = 0; k < nC; k++) scores.push(Number(v[i][3 + k]) || 0);
    var lockedCell = v[i][3 + nC + 1];
    out.push({
      row: i + 1, judge: judge, seq: Number(v[i][1]) || 0, participant: String(v[i][2] || ''),
      scores: scores, total: Number(v[i][3 + nC]) || 0,
      locked: (lockedCell === true || String(lockedCell).toUpperCase() === 'TRUE'),
      lockedAt: v[i][3 + nC + 2] ? new Date(v[i][3 + nC + 2]).getTime() : 0
    });
  }
  return out;
}

function trimmedMean_(totals) {
  if (!totals || !totals.length) return null;
  const a = totals.slice().sort(function (x, y) { return x - y; });
  if (a.length > 2) { a.shift(); a.pop(); } // drop one lowest + one highest
  const sum = a.reduce(function (s, x) { return s + x; }, 0);
  return Math.round((sum / a.length) * 100) / 100;
}

/* ---- handlers ---- */
function handleJudgeNames_() {
  return json_({ ok: true, judges: judgesCached_().filter(function (j) { return j.active; }).map(function (j) { return j.name; }) });
}

function handleJudgeLogin_(data) {
  const name = String(data.name || '').trim();
  const pass = String(data.password || '');
  const j = judgesCached_().filter(function (x) { return x.active && x.name.toLowerCase() === name.toLowerCase(); })[0];
  if (!j || !String(j.password || '') || String(j.password) !== pass) return json_({ ok: false, error: 'Wrong name or password.' });
  return json_({ ok: true, token: judgeToken_(j.name), name: j.name });
}

// Sheet writes are buffered; commit them BEFORE releasing the lock, otherwise the next judge's request can
// take the lock, read the sheet without this write and append to the same row (Google's LockService advice).
function releaseAfterFlush_(lk) {
  try { SpreadsheetApp.flush(); } catch (e) {}
  lk.releaseLock();
}

// A judge's reopen window = their REOPEN_WINDOW most recently locked scores, INCLUDING ones that are
// currently reopened (a reopened score keeps its lock time). So reopening never makes an older score
// eligible — the window can't be walked back to reopen everything.
function reopenWindow_(all, name) {
  return all.filter(function (s) { return s.judge === name && s.lockedAt; })
    .sort(function (a, b) { return b.lockedAt - a.lockedAt; })
    .slice(0, REOPEN_WINDOW);
}

function handleJudgeData_(data) {
  const name = judgeFromToken_(data.token);
  if (!name) return json_({ ok: false, error: 'Session expired — please log in again.' });
  const round = roundOf_(data);
  const finalists = finalistsCached_();
  const participants = round === 'final' ? finalists : semisCached_();
  const active = judgesCached_().filter(function (j) { return j.active; }).map(function (j) { return j.name; });
  const nJudges = active.length;
  const all = participants.length ? readScores_(round) : [];

  const mine = {}, reopened = [];
  all.filter(function (s) { return s.judge === name; }).forEach(function (s) {
    mine[s.seq] = { scores: s.scores, total: s.total, locked: s.locked };
    if (!s.locked && s.lockedAt) reopened.push(s.seq);           // was locked, reopened, not locked again yet
  });
  const reopenable = reopenWindow_(all, name).filter(function (s) { return s.locked; }).map(function (s) { return s.seq; });

  // only ACTIVE judges' locked scores count (same rule as the admin dashboard)
  const bySeq = {};
  all.filter(function (s) { return s.locked && active.indexOf(s.judge) >= 0; })
     .forEach(function (s) { (bySeq[s.seq] = bySeq[s.seq] || []).push(s.total); });
  const lockCount = {}, average = {};
  participants.forEach(function (p) {
    var totals = bySeq[p.seq] || [];
    lockCount[p.seq] = totals.length;
    average[p.seq] = (nJudges >= 3 && totals.length >= nJudges) ? trimmedMean_(totals) : null;
  });

  return json_({ ok: true, api: JUDGE_API, round: round, finalReady: finalists.length > 0,
    name: name, nJudges: nJudges, criteria: JUDGE_CRITERIA,
    participants: participants, mine: mine, reopenable: reopenable, reopened: reopened, lockCount: lockCount, average: average });
}

function handleSaveScore_(data) {
  const name = judgeFromToken_(data.token);
  if (!name) return json_({ ok: false, error: 'Session expired — please log in again.' });
  const round = roundOf_(data);
  const seq = Number(data.seq);
  var p = null;
  if (round !== 'final') {
    p = semisCached_().filter(function (x) { return x.seq === seq; })[0];
    if (!p) return json_({ ok: false, error: 'Unknown participant.' });
    // the page says who it thinks #seq is; if the list changed underneath it, refuse rather than file the score under someone else
    if (data.expect && String(data.expect) !== p.name) return json_({ ok: false, error: 'The line-up changed — refreshing.', lineup: true });
  }
  const lock = !!data.lock;

  const lk = LockService.getScriptLock(); lk.waitLock(20000);
  try {
    if (round === 'final') {
      // the line-up may have changed while this request waited for the lock (or the 30s cache is behind) —
      // check it against the sheet itself before filing a Final score
      p = getFinalists_().filter(function (x) { return x.seq === seq; })[0];
      if (!p) return json_({ ok: false, error: 'That finalist is not in the Final line-up.', lineup: true });
      if (data.expect && String(data.expect) !== p.name) return json_({ ok: false, error: 'The line-up changed — refreshing.', lineup: true });
    }
    const sh = getScoresSheet_(round);
    const existing = readScores_(round).filter(function (s) { return s.judge === name && s.seq === seq; })[0];
    if (existing && existing.locked) return json_({ ok: false, error: 'That score is locked — reopen it first.' });

    const nC = JUDGE_CRITERIA.length;
    const scores = []; var total = 0;
    for (var k = 0; k < nC; k++) {
      var val = Math.round(Number((data.scores || [])[k]) || 0);
      val = Math.max(0, Math.min(JUDGE_CRITERIA[k].max, val));
      scores.push(val); total += val;
    }
    // Locking stamps "Locked at"; a draft save on a reopened score keeps its original lock time,
    // so the score keeps its place in the judge's reopen window.
    const lockedAtCell = lock ? new Date() : (existing && existing.lockedAt ? new Date(existing.lockedAt) : '');
    const rowVals = [name, seq, p.name + (p.company ? (' — ' + p.company) : '')]
      .concat(scores).concat([total, lock, lockedAtCell]);
    if (existing) sh.getRange(existing.row, 1, 1, rowVals.length).setValues([rowVals]);
    else sh.getRange(sh.getLastRow() + 1, 1, 1, rowVals.length).setValues([rowVals]);
    return json_({ ok: true, locked: lock, total: total });
  } finally { releaseAfterFlush_(lk); }
}

function handleReopenScore_(data) {
  const name = judgeFromToken_(data.token);
  if (!name) return json_({ ok: false, error: 'Session expired — please log in again.' });
  const round = roundOf_(data);
  const seq = Number(data.seq);
  const lk = LockService.getScriptLock(); lk.waitLock(20000);
  try {
    const sh = getScoresSheet_(round);
    const target = reopenWindow_(readScores_(round), name).filter(function (s) { return s.seq === seq; })[0];
    if (!target) return json_({ ok: false, error: 'Only your ' + REOPEN_WINDOW + ' most-recently-locked scores can be reopened.' });
    if (!target.locked) return json_({ ok: true, already: true });   // already open
    const nC = JUDGE_CRITERIA.length;
    // 1-based columns: Judge=1, Seq=2, Participant=3, criteria=4..3+nC, Total=3+nC+1, Locked=3+nC+2, Locked at=3+nC+3.
    // Only clear the Locked flag — "Locked at" stays, so this score keeps its slot in the reopen window.
    sh.getRange(target.row, 3 + nC + 2).setValue(false); // Locked
    return json_({ ok: true });
  } finally { releaseAfterFlush_(lk); }
}

function checkAdmin_(data) {
  const pass = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSCODE') || '';
  if (!pass) return 'Server not set up: ADMIN_PASSCODE is missing.';
  if (String(data.passcode || '') !== pass) return 'Wrong passcode.';
  return '';
}

function handleAdminScores_(data) {
  const bad = checkAdmin_(data);
  if (bad) return json_({ ok: false, error: bad });
  const round = roundOf_(data);
  const finalists = finalistsCached_();
  const participants = round === 'final' ? finalists : semisCached_();
  const judges = judgesCached_().filter(function (j) { return j.active; }).map(function (j) { return j.name; });
  const nJudges = judges.length;
  const all = participants.length ? readScores_(round) : [];
  const rows = participants.map(function (p) {
    var perJudge = judges.map(function (jn) {
      var s = all.filter(function (x) { return x.judge === jn && x.seq === p.seq; })[0];
      return s ? { judge: jn, total: s.total, locked: s.locked, reopened: !s.locked && !!s.lockedAt, scores: s.scores }
               : { judge: jn, total: null, locked: false, scores: null };
    });
    var lockedTotals = perJudge.filter(function (x) { return x.locked && x.total != null; }).map(function (x) { return x.total; });
    var avg = (nJudges >= 3 && lockedTotals.length >= nJudges) ? trimmedMean_(lockedTotals) : null;
    return { seq: p.seq, name: p.name, company: p.company, semiSeq: p.semiSeq || null,
             perJudge: perJudge, locks: lockedTotals.length, average: avg };
  });
  // once any Final score exists the line-up is frozen (setFinalists refuses), so the page can say so
  const finalStarted = finalists.length > 0 && (round === 'final' ? all.length > 0 : readScores_('final').length > 0);
  return json_({ ok: true, api: JUDGE_API, round: round, finalReady: finalists.length > 0, finalStarted: finalStarted,
    finalists: finalists, finalSize: FINAL_SIZE, judges: judges, nJudges: nJudges, criteria: JUDGE_CRITERIA, rows: rows });
}

// Admin: start the Final by naming the Top 4 in their Final pitch order (data.seqs = Semifinal seq
// numbers, e.g. [7, 2, 11, 5]) — or change/clear it (data.clear) — but only before any Final score exists.
function handleSetFinalists_(data) {
  const bad = checkAdmin_(data);
  if (bad) return json_({ ok: false, error: bad });
  const rows = [];
  if (!data.clear) {
    const seqs = (data.seqs || []).map(Number);
    if (seqs.length !== FINAL_SIZE) return json_({ ok: false, error: 'Pick exactly ' + FINAL_SIZE + ' finalists.' });
    const semis = getSemifinalists_();   // fresh read, not the 30s cache
    const seen = {};
    for (var i = 0; i < seqs.length; i++) {
      var p = semis.filter(function (x) { return x.seq === seqs[i]; })[0];
      if (!p) return json_({ ok: false, error: 'Unknown semifinalist #' + seqs[i] + '.' });
      if (seen[p.seq]) return json_({ ok: false, error: p.name + ' is picked twice.' });
      seen[p.seq] = true;
      rows.push([i + 1, p.name, p.company, p.seq]);
    }
  }
  const lk = LockService.getScriptLock(); lk.waitLock(20000);
  try {
    if (readScores_('final').length) {
      return json_({ ok: false, error: 'Final scoring has already started, so the line-up is locked. To change it, first clear the "' + FINAL_SCORES_SHEET + '" tab in the sheet.' });
    }
    const ss = ssBook_();
    const sh = ss.getSheetByName(FINALISTS_SHEET) || ss.insertSheet(FINALISTS_SHEET);
    sh.clear();
    sh.getRange(1, 1, 1, 4).setValues([['Seq', 'Name', 'Company', 'Semifinal #']]);
    if (rows.length) sh.getRange(2, 1, rows.length, 4).setValues(rows);
    sh.setFrozenRows(1);
    SpreadsheetApp.flush();   // commit the new line-up before dropping the cache, so no reader re-caches the old one
    try { CacheService.getScriptCache().remove('cye_finalists_v1'); } catch (e) {}
    return json_({ ok: true, finalists: rows.map(function (r) { return { seq: r[0], name: r[1], company: r[2], semiSeq: r[3] }; }) });
  } finally { releaseAfterFlush_(lk); }
}

/* Optional manual seeder — not required, since getJudges_/getSemifinalists_/
 * getScoresSheet_ create and seed their tabs on first use. Reading them here
 * simply forces that seeding to happen now. */
function setupJudging() {
  getJudges_();
  getSemifinalists_();
  getScoresSheet_();
  return 'Judging tabs ensured (Judges, Semifinalists, Scores).';
}
