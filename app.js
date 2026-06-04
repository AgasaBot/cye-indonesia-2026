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
  const labels = ['About you','Your business','Your submission','Review & payment','Done'];
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
    if (n === REVIEW) nextBtn.innerHTML = 'Pay IDR 150,000 <span class="arw">→</span>';
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
      ['Participation', get('participation')],
    ];
    $('#reviewList').innerHTML = rows.map(([k,v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  }
  function escapeHtml(s){ return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  /* ---- placeholder spreadsheet submission (swap endpoint later) ---- */
  function submitToSpreadsheet(){
    const d = {}; new FormData(form).forEach((v,k) => { if (!(v instanceof File)) d[k] = v; });
    d.submittedAt = new Date().toISOString();
    // Swap this block for your real Google Sheet / Airtable / webhook POST.
    // Example:
    // fetch('YOUR_WEBHOOK_URL', {method:'POST', body: JSON.stringify(d)});
    try { const all = JSON.parse(localStorage.getItem('cye_subs')||'[]'); all.push(d); localStorage.setItem('cye_subs', JSON.stringify(all)); } catch(e){}
    console.log('[CYE] Registration captured (placeholder):', d);
  }

  nextBtn.addEventListener('click', () => {
    if (cur <= TOTAL_FORM){
      if (!validateStep(cur)) return;
      if (cur === TOTAL_FORM){ buildReview(); showStep(REVIEW); }
      else showStep(cur + 1);
    } else if (cur === REVIEW){
      // mock payment -> capture -> success
      submitToSpreadsheet();
      const ref = 'CYE-2026-' + Math.floor(100000 + Math.random()*900000);
      $('#refCode').textContent = 'REF · ' + ref;
      showStep(SUCCESS);
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

})();
