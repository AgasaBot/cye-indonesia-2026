/* ============================================================
   CYE Indonesia 2026 — interactions
   ============================================================ */
(function(){
  'use strict';
  const $ = (s, c) => (c||document).querySelector(s);
  const $$ = (s, c) => Array.from((c||document).querySelectorAll(s));

  /* ---------- nav scroll state ---------- */
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 30);
  onScroll();
  window.addEventListener('scroll', onScroll, {passive:true});

  /* ---------- mobile menu ---------- */
  const menuBtn = $('#menuBtn'), mobileMenu = $('#mobileMenu');
  const closeMenu = () => { mobileMenu.classList.remove('open'); menuBtn.setAttribute('aria-expanded','false'); document.body.style.overflow=''; };
  menuBtn.addEventListener('click', () => {
    const open = mobileMenu.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', open ? 'true':'false');
    document.body.style.overflow = open ? 'hidden' : '';
  });
  $$('#mobileMenu a').forEach(a => a.addEventListener('click', closeMenu));

  /* ---------- scroll reveal ---------- */
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } });
  }, {threshold:0.12, rootMargin:'0px 0px -60px 0px'});
  $$('.reveal').forEach(el => io.observe(el));

  /* ---------- FAQ accordion ---------- */
  $$('.faq-item').forEach(item => {
    const q = $('.faq-q', item), a = $('.faq-a', item);
    q.addEventListener('click', () => {
      const open = item.classList.contains('open');
      $$('.faq-item').forEach(other => {
        other.classList.remove('open');
        $('.faq-a', other).style.maxHeight = null;
      });
      if (!open){ item.classList.add('open'); a.style.maxHeight = a.scrollHeight + 'px'; }
    });
  });

  /* ---------- file upload labels ---------- */
  $$('[data-upload]').forEach(label => {
    const input = $('input', label), lbl = $('[data-uplabel]', label);
    const original = lbl.textContent;
    input.addEventListener('change', () => {
      if (input.files && input.files.length){
        label.classList.add('filled');
        lbl.textContent = input.files[0].name.length > 28 ? input.files[0].name.slice(0,26)+'…' : input.files[0].name;
      } else {
        label.classList.remove('filled'); lbl.textContent = original;
      }
    });
  });

  /* ---------- multi-step form ---------- */
  const form = $('#regForm');
  const steps = $$('.fstep', form);
  const stepsInd = $$('#stepsInd .si');
  const stepLabel = $('#stepLabel');
  const nextBtn = $('#nextBtn');
  const backBtn = $('#backBtn');
  const actions = $('#formActions');
  const labels = ['About you','Your business','Your submission','Review & submit','Done'];
  let cur = 1; // 1..5
  const TOTAL_FORM = 3;   // collecting steps
  const REVIEW = 4, SUCCESS = 5;

  function showStep(n){
    cur = n;
    steps.forEach(s => s.classList.toggle('active', +s.dataset.step === n));
    // progress indicator (3 collecting steps + review fills all)
    stepsInd.forEach((si, i) => {
      si.classList.remove('active','done');
      const stepNum = i+1;
      if (n >= REVIEW) si.classList.add('done');
      else if (stepNum < n) si.classList.add('done');
      else if (stepNum === n) si.classList.add('active');
    });
    // labels & buttons
    if (n <= TOTAL_FORM) stepLabel.textContent = `Step ${n} of ${TOTAL_FORM} · ${labels[n-1]}`;
    else if (n === REVIEW) stepLabel.textContent = `Almost there · ${labels[3]}`;
    else stepLabel.textContent = 'Registration complete';

    backBtn.style.visibility = (n === 1 || n === SUCCESS) ? 'hidden' : 'visible';
    if (n === SUCCESS){ actions.style.display = 'none'; }
    else { actions.style.display = 'flex'; }
    if (n === REVIEW) nextBtn.innerHTML = 'Submit registration <span class="arw">→</span>';
    else if (n === TOTAL_FORM) nextBtn.innerHTML = 'Review <span class="arw">→</span>';
    else nextBtn.innerHTML = 'Continue <span class="arw">→</span>';

    // scroll form into view on the card (not the whole page jump)
    const card = $('.form-card');
    const top = card.getBoundingClientRect().top + window.scrollY - 96;
    if (n > 1) window.scrollTo({top, behavior:'smooth'});
  }

  function clearErrors(stepEl){
    $$('.field.err', stepEl).forEach(f => f.classList.remove('err'));
    const cm = $('#consentMsg'); if (cm) cm.style.display = 'none';
  }

  function validateStep(n){
    const stepEl = steps[n-1];
    clearErrors(stepEl);
    let ok = true, firstErr = null;

    // required inputs/selects
    $$('[data-required]', stepEl).forEach(inp => {
      const field = inp.closest('.field');
      let bad = !inp.value.trim();
      if (!bad && inp.dataset.type === 'email') bad = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inp.value);
      if (!bad && inp.dataset.type === 'age'){ const a = +inp.value; bad = !(a >= 18 && a <= 40); }
      if (!bad && inp.dataset.type === 'duration'){ bad = inp.value === 'under'; }
      if (bad){ field.classList.add('err'); ok = false; firstErr = firstErr || field; }
    });
    // required radio groups
    const radioGroups = {};
    $$('[data-required-radio]', stepEl).forEach(r => { radioGroups[r.name] = radioGroups[r.name] || r.closest('.field'); });
    Object.keys(radioGroups).forEach(name => {
      const checked = $(`input[name="${name}"]:checked`, stepEl);
      if (!checked){ radioGroups[name].classList.add('err'); ok = false; firstErr = firstErr || radioGroups[name]; }
    });
    // consent checkbox
    const consent = $('[data-required-check]', stepEl);
    if (consent && !consent.checked){
      const cm = $('#consentMsg'); if (cm) cm.style.display = 'block';
      ok = false; firstErr = firstErr || cm;
    }

    if (firstErr) firstErr.scrollIntoView({behavior:'smooth', block:'center'});
    return ok;
  }

  function buildReview(){
    const d = new FormData(form);
    const get = k => (d.get(k) || '').toString().trim();
    const rows = [
      ['Name', get('fullname')],
      ['Email', get('email')],
      ['Phone', get('phone')],
      ['Age', get('age')],
      ['City', get('city') || '—'],
      ['Business', get('business')],
      ['Sector', get('sector') || '—'],
      ['Active for', ({'3-6':'3–6 months','6-12':'6–12 months','1-2':'1–2 years','2plus':'2+ years'})[get('duration')] || '—'],
      ['JCI member', get('jci') === 'yes' ? 'Yes' : 'No'],
      ['Pitch video', get('videolink') || '—'],
    ];
    $('#reviewList').innerHTML = rows.map(([k,v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  }
  function escapeHtml(s){ return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  /* ---- registration submission ----
     Posts to a Google Apps Script web app that appends a row to a Google Sheet
     and saves uploaded files to a Google Drive folder. Set ENDPOINT to the
     deployed web-app URL. Files (business plan PDF + headshot) are sent as
     base64; the pitch video is collected as a link, not a file. */
  const ENDPOINT = 'https://script.google.com/macros/s/AKfycbwY5zaPSyDHNjbjvBsBUbMrjWd_mMPWyywfEFBIFtsgkmodhG8D9gxC9dGezsCf6iwN/exec';

  function readFileAsBase64(file){
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function buildPayload(ref){
    const fd = new FormData(form);
    const payload = { ref, submittedAt: new Date().toISOString(), files: [] };
    for (const [k, v] of fd.entries()){
      if (v instanceof File){
        if (v.size > 0) payload.files.push({ field: k, name: v.name, type: v.type, dataBase64: await readFileAsBase64(v) });
      } else {
        payload[k] = v;
      }
    }
    return payload;
  }

  async function submitRegistration(ref){
    const payload = await buildPayload(ref);
    if (!ENDPOINT){
      // No backend configured yet (preview): keep a local copy so nothing is lost.
      try { const all = JSON.parse(localStorage.getItem('cye_subs')||'[]'); all.push(payload); localStorage.setItem('cye_subs', JSON.stringify(all)); } catch(e){}
      console.warn('[CYE] ENDPOINT not set — registration stored locally only:', payload);
      return {};
    }
    // text/plain body keeps this a "simple" request (no CORS preflight); Apps Script
    // reads it from e.postData.contents and returns JSON (it sends Access-Control-Allow-Origin: *).
    const res = await fetch(ENDPOINT, { method:'POST', body: JSON.stringify(payload) });
    try { return await res.json(); } catch(e){ return {}; }
  }

  let submitting = false;
  nextBtn.addEventListener('click', async () => {
    if (cur <= TOTAL_FORM){
      if (!validateStep(cur)) return;
      if (cur === TOTAL_FORM){ buildReview(); showStep(REVIEW); }
      else showStep(cur + 1);
    } else if (cur === REVIEW){
      if (submitting) return;
      submitting = true;
      const errEl = $('#submitErr'); if (errEl) errEl.style.display = 'none';
      const original = nextBtn.innerHTML;
      nextBtn.disabled = true; nextBtn.innerHTML = 'Submitting…';
      const ref = 'CYE-2026-' + Math.floor(100000 + Math.random()*900000);
      try {
        const result = await submitRegistration(ref);
        $('#refCode').textContent = 'REF · ' + ref;
        setupPayment(ref, result || {});
        showStep(SUCCESS);
      } catch (e){
        console.error('[CYE] submission failed', e);
        if (errEl) errEl.style.display = 'block';
        nextBtn.disabled = false; nextBtn.innerHTML = original;
      } finally {
        submitting = false;
      }
    }
  });
  backBtn.addEventListener('click', () => {
    if (cur === REVIEW) showStep(TOTAL_FORM);
    else if (cur > 1) showStep(cur - 1);
  });

  // live-clear error on input
  form.addEventListener('input', e => {
    const f = e.target.closest('.field');
    if (f) f.classList.remove('err');
    if (e.target.name === 'consent'){ const cm = $('#consentMsg'); if (cm) cm.style.display = 'none'; }
  });

  /* ---------- Midtrans payment (optional, shown on the success screen) ---------- */
  let payRef = null;
  function fmtIDR(n){ return 'IDR ' + Number(n || 0).toLocaleString('en-US'); }
  function setupPayment(ref, result){
    const payNow = $('#payNow'), payFallback = $('#payFallback');
    const amount = result.amount || 200000;
    const amtEl = $('#payAmount'); if (amtEl) amtEl.textContent = fmtIDR(amount);
    const badge = $('#payBadge'); if (badge) badge.textContent = amount <= 200000 ? 'early bird' : 'standard';
    if (result.snapToken && window.snap){
      payRef = ref;
      if (payNow){ payNow.dataset.token = result.snapToken; payNow.style.display = ''; }
      if (payFallback) payFallback.style.display = 'none';
    } else {
      if (payNow) payNow.style.display = 'none';
      if (payFallback) payFallback.style.display = '';
    }
  }
  function setPayStatus(msg, color){ const el = $('#payStatus'); if (el){ el.textContent = msg; el.style.color = color || 'inherit'; el.style.display = ''; } }
  async function verifyPayment(ref){
    if (!ENDPOINT || !ref) return null;
    try { const r = await fetch(ENDPOINT, { method:'POST', body: JSON.stringify({ action:'paymentCheck', order_id: ref }) }); return await r.json(); } catch(e){ return null; }
  }
  const payBtn = $('#payBtn');
  if (payBtn) payBtn.addEventListener('click', () => {
    const pn = $('#payNow'); const tok = pn && pn.dataset.token;
    if (!tok || !window.snap) return;
    window.snap.pay(tok, {
      onSuccess: () => onPaid('success'),
      onPending: () => onPaid('pending'),
      onError:   () => setPayStatus('Payment didn’t go through. You can try again.', '#d23a57'),
      onClose:   () => setPayStatus('Payment window closed — you can pay anytime from the link in your email.', '')
    });
  });
  async function onPaid(kind){
    setPayStatus('Verifying your payment…', '');
    const j = await verifyPayment(payRef);
    const label = (j && j.label) || (kind === 'success' ? 'Paid' : 'Pending');
    if (/paid/i.test(label)){
      setPayStatus('✓ Payment received — thank you! Your spot is confirmed.', 'var(--teal-deep)');
      if (payBtn) payBtn.style.display = 'none';
    } else {
      setPayStatus('Payment status: ' + label + '. We’ll confirm once it settles.', '');
    }
  }
  // If someone returns from the hosted payment page (email link → /?paid=REF), verify silently.
  (function(){ const m = location.search.match(/[?&]paid=([^&]+)/); if (m) verifyPayment(decodeURIComponent(m[1])); })();

  /* ---------- WhatsApp CTA prefill ---------- */
  (function(){
    const num = '6281905687888';
    const isHttp = /^https?:/.test(location.protocol);
    const site = isHttp ? (location.origin + location.pathname) : '';
    const msg = 'Hello, I would like to know more about CYE Indonesia' + (site ? '\n\n' + site : '');
    const href = 'https://wa.me/' + num + '?text=' + encodeURIComponent(msg);
    $$('.js-wa').forEach(a => { a.href = href; });
  })();

})();
