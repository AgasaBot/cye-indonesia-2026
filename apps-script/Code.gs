/**
 * CYE Indonesia 2026 — registration backend (Google Apps Script)
 * ------------------------------------------------------------------
 * Container-bound to the responses Google Sheet (open the Sheet →
 * Extensions → Apps Script, then paste this file).
 *
 * It receives JSON POSTs from the website registration form, appends a
 * row to the Sheet, saves uploaded files (business plan PDF + headshot)
 * to a Google Drive folder, and emails the applicant a confirmation.
 *
 * No payment is handled here — the fee is collected manually afterwards.
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

const HEADERS = ['Timestamp', 'Ref', 'Full name', 'Email', 'Phone', 'Age', 'City',
  'Business', 'Sector', 'Active for', 'JCI member', 'Participation',
  'Pitch video link', 'Business plan link', 'Business plan file', 'Headshot file'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // avoid two submissions clobbering the same row
  try {
    const data = JSON.parse(e.postData.contents);

    // Save any uploaded files into a per-applicant Drive subfolder.
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
    const sheet = getSheet_();
    const row = [
      data.submittedAt || new Date().toISOString(),
      data.ref || '',
      data.fullname || '', data.email || '', data.phone || '', data.age || '', data.city || '',
      data.business || '', data.sector || '', durations[data.duration] || data.duration || '',
      data.jci === 'yes' ? 'Yes' : 'No', data.participation || '',
      data.videolink || '', data.planlink || '',
      fileUrls.plan || '', fileUrls.headshot || ''
    ];
    // Write as plain text so values like phone "+62..." aren't parsed as formulas.
    const target = sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length);
    target.setNumberFormat('@');
    target.setValues([row]);

    if (data.email) sendConfirmation_(data);
    if (NOTIFY_EMAIL) notifyOrganizer_(data, fileUrls);

    return json_({ ok: true, ref: data.ref });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Lets you open the /exec URL in a browser to confirm the app is deployed.
function doGet() {
  return json_({ ok: true, service: 'CYE Indonesia 2026 registration' });
}

function getSheet_() {
  const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getUploadFolder_(ref) {
  const it = DriveApp.getFoldersByName(UPLOAD_FOLDER_NAME);
  const root = it.hasNext() ? it.next() : DriveApp.createFolder(UPLOAD_FOLDER_NAME);
  return root.createFolder(ref || 'entry');
}

function sendConfirmation_(d) {
  const subject = 'CYE Indonesia 2026 — registration received (' + (d.ref || '') + ')';
  const body =
    'Hi ' + (d.fullname || '') + ',\n\n' +
    'Thank you for registering for the Creative Young Entrepreneur Award — Indonesia 2026.\n' +
    'We have received your registration. Your reference number is ' + (d.ref || '') + '.\n\n' +
    'There is nothing to pay right now. Our team will contact you on WhatsApp or email with the ' +
    'registration fee — IDR 200,000 (early bird, before 1 August 2026) or IDR 300,000 from 1 August onwards — and about any materials still to send.\n\n' +
    'National Final: 3 October 2026 — APL Tower L22, Galilee Centre, Jakarta.\n\n' +
    'See you on the world stage,\nJCI Nusantara · CYE Indonesia 2026';
  MailApp.sendEmail(d.email, subject, body);
}

function notifyOrganizer_(d, fileUrls) {
  const subject = 'New CYE 2026 registration: ' + (d.fullname || '') + ' (' + (d.ref || '') + ')';
  const lines = [
    'Ref: ' + (d.ref || ''), 'Name: ' + (d.fullname || ''), 'Email: ' + (d.email || ''),
    'Phone: ' + (d.phone || ''), 'Age: ' + (d.age || ''), 'City: ' + (d.city || ''),
    'Business: ' + (d.business || ''), 'Sector: ' + (d.sector || ''),
    'Participation: ' + (d.participation || ''), 'JCI member: ' + (d.jci || ''),
    'Pitch video: ' + (d.videolink || ''), 'Plan link: ' + (d.planlink || ''),
    'Plan file: ' + (fileUrls.plan || ''), 'Headshot: ' + (fileUrls.headshot || '')
  ];
  MailApp.sendEmail(NOTIFY_EMAIL, subject, lines.join('\n'));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
