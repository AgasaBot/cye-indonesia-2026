# Registration backend — one-time setup (Google Sheet + Drive)

The website form sends each registration to a **Google Apps Script web app**, which:

- appends a row to a **Google Sheet** (one row per applicant), and
- saves the uploaded **business plan (PDF)** and **headshot** into a **Google Drive** folder, and
- emails the applicant a confirmation (and optionally emails you a copy).

No payment is taken — you collect the IDR 150,000 fee manually afterwards.

> Do this while signed in to the Google account that should **own** the responses
> (e.g. `cye-indonesia@jcinusantara.com`). I can also do these steps for you in
> your browser once the "Claude in Chrome" extension is connected and you're
> logged into Google.

## Steps

1. Go to <https://sheets.google.com> and create a new blank spreadsheet. Name it
   e.g. **"CYE 2026 Registrations"**.
2. In that sheet: **Extensions → Apps Script**. Delete any sample code.
3. Copy the entire contents of [`Code.gs`](Code.gs) into the editor and **Save**.
   *(Optional)* set `NOTIFY_EMAIL` near the top to get an email for every new
   submission.
4. Click **Deploy → New deployment**. Choose type **Web app**.
   - **Execute as:** *Me*
   - **Who has access:** *Anyone*
   - Click **Deploy**, then **Authorize access** and approve the permissions
     (you'll see a "Google hasn't verified this app" screen — click *Advanced →
     Go to … (unsafe)*; it's your own script).
5. Copy the **Web app URL** — it ends in `/exec`.
6. Paste that URL into [`../app.js`](../app.js) as the value of `ENDPOINT`, then
   redeploy the site. *(I'll do this part.)*

## Test it

Open the `/exec` URL in a browser — you should see
`{"ok":true,"service":"CYE Indonesia 2026 registration"}`. Then submit a test
registration from the website; a row should appear in the sheet and a folder in
your Drive under **"CYE 2026 Submissions"**.

## Updating the script later

If you change `Code.gs`, **Deploy → Manage deployments → (edit) → New version →
Deploy**. The `/exec` URL stays the same, so no website change is needed.
