// Landing 落地页 /catalog：公开、英文、面向经销/分销/集成/安装买家。索取批发价单表单 → POST /api/inbound。
// 自包含 HTML（内联 CSS/JS，无外部资源）。不放任何价格。
// ⚠️ AirSonde 文案为 C1 搬迁时的**占位草稿**（结构照上游，品类/卖点/FAQ 换成 IAQ 泛写），
//    待 Joe 审定后重写；且 C1 未配 API_HOST → 本页无公开入口，纯留壳。

const COUNTRY_OPTIONS = [
  ["us", "United States"], ["ca", "Canada"], ["au", "Australia"], ["nz", "New Zealand"],
  ["gb", "United Kingdom"], ["ie", "Ireland"], ["de", "Germany"], ["fr", "France"],
  ["es", "Spain"], ["it", "Italy"], ["nl", "Netherlands"], ["br", "Brazil"], ["mx", "Mexico"],
  ["cl", "Chile"], ["co", "Colombia"], ["pe", "Peru"], ["ar", "Argentina"], ["za", "South Africa"],
  ["ng", "Nigeria"], ["ke", "Kenya"], ["ph", "Philippines"], ["id", "Indonesia"],
].map(([v, n]) => `<option value="${v}">${n}</option>`).join("") + `<option value="">Other</option>`;

const CATEGORIES = [
  ["Indoor Air Quality Monitors", "CO2, PM2.5/PM10, TVOC, temperature &amp; humidity"],
  ["Wall &amp; Panel Displays", "Wall-mount monitors, desktop units, LED panels"],
  ["Sensors &amp; Modules", "Replacement sensors, OEM modules, calibration"],
  ["Connected Monitoring", "Data-ready monitor options for building projects"],
  ["Commercial &amp; HVAC Integration", "BMS-ready units for buildings, schools &amp; offices"],
  ["Custom &amp; OEM/ODM", "Private-label &amp; custom-spec monitors at volume"],
].map(([t, d]) => `<div class="cat"><h3>${t}</h3><p>${d}</p></div>`).join("");

// ⚠️ claims 纪律（画像终稿 §5 + 总工裁定 2026-08-12）：认证名/协议名/技术方案断言一律不出现，
//    与官网同口径——有真证书/工厂书面确认才加回，不做"support on request"式保守暗示。
const FAQS = [
  ["Do you do private label / ODM?", "Yes — your branding, your spec, no AirSonde marks. Private-label is our core business."],
  ["Is there a minimum order?", "Flexible MOQs for growing brands and distributors — we scale with you."],
  ["How do we get pricing?", "Trade pricing is inquiry-based — tell us your models and volumes and we'll quote."],
].map(([q, a]) => `<div class="faq"><h4>${q}</h4><p>${a}</p></div>`).join("");

export function catalogHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AirSonde — Air Quality Monitors OEM/ODM | Request Trade Price List</title>
<meta name="description" content="Air quality monitors straight from the manufacturer. OEM/ODM, private-label and trade pricing for brands, distributors and HVAC integrators worldwide.">
<style>
  :root{ --navy:#0f2740; --blue:#1c74d4; --ink:#1a2330; --muted:#5b6b7f; --bg:#f5f8fc; --line:#e2e9f2; --accent:#0ea5e9; }
  *{ box-sizing:border-box; }
  body{ margin:0; font:16px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:var(--ink); background:#fff; }
  a{ color:var(--blue); }
  .wrap{ max-width:1040px; margin:0 auto; padding:0 20px; }
  .btn{ display:inline-block; background:var(--blue); color:#fff; text-decoration:none; font-weight:600;
        padding:13px 26px; border-radius:8px; border:0; cursor:pointer; font-size:16px; }
  .btn:hover{ background:#155bb0; }
  header.hero{ background:linear-gradient(160deg,#0f2740,#1b3a5c); color:#fff; padding:64px 0 72px; }
  .hero h1{ font-size:40px; line-height:1.15; margin:0 0 16px; font-weight:800; letter-spacing:-.5px; }
  .hero p.sub{ font-size:19px; color:#cfe0f2; max-width:680px; margin:0 0 28px; }
  .hero .brand{ font-weight:800; letter-spacing:1px; color:#8fc7ff; margin:0 0 20px; font-size:14px; }
  .trust{ display:flex; flex-wrap:wrap; gap:10px 22px; margin-top:26px; color:#bcd4ee; font-size:14px; }
  .trust span::before{ content:"✓ "; color:#5fd0a0; font-weight:700; }
  section{ padding:52px 0; }
  section h2{ font-size:27px; margin:0 0 8px; letter-spacing:-.3px; }
  section .lead{ color:var(--muted); margin:0 0 26px; max-width:720px; }
  .grid{ display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
  .cat{ background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:18px; }
  .cat h3{ margin:0 0 5px; font-size:16px; }
  .cat p{ margin:0; color:var(--muted); font-size:14px; }
  .why{ background:var(--bg); }
  .why .grid4{ display:grid; grid-template-columns:repeat(4,1fr); gap:16px; }
  .why .card{ background:#fff; border:1px solid var(--line); border-radius:10px; padding:18px; }
  .why .card b{ display:block; font-size:15px; margin-bottom:5px; }
  .why .card p{ margin:0; color:var(--muted); font-size:14px; }
  .faq h4{ margin:0 0 3px; font-size:16px; }
  .faq{ padding:14px 0; border-bottom:1px solid var(--line); }
  .faq p{ margin:0; color:var(--muted); }
  .formwrap{ background:linear-gradient(160deg,#0f2740,#1b3a5c); color:#fff; }
  .formcard{ background:#fff; color:var(--ink); border-radius:14px; padding:30px; max-width:620px; margin:0 auto;
             box-shadow:0 12px 40px rgba(0,0,0,.25); }
  .formcard h2{ margin:0 0 4px; color:var(--ink); }
  .formcard p.hint{ color:var(--muted); margin:0 0 20px; font-size:14px; }
  .field{ margin-bottom:14px; }
  .field label{ display:block; font-size:13px; font-weight:600; margin-bottom:5px; color:#33465c; }
  .field input,.field select{ width:100%; padding:11px 12px; border:1px solid #cdd8e6; border-radius:8px; font:inherit; color:var(--ink); background:#fff; }
  .field input:focus,.field select:focus{ outline:2px solid var(--accent); border-color:var(--accent); }
  .hp{ position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden; }
  .row2{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  #msg{ margin-top:14px; font-size:14px; min-height:20px; }
  #msg.ok{ color:#0b8a4b; } #msg.err{ color:#c0392b; }
  footer{ background:#0b1c2e; color:#8ba3bd; font-size:13px; padding:26px 0; }
  @media(max-width:760px){ .grid,.why .grid4{ grid-template-columns:1fr 1fr; } .hero h1{ font-size:31px; } .row2{ grid-template-columns:1fr; } }
  @media(max-width:480px){ .grid,.why .grid4{ grid-template-columns:1fr; } }
</style>
</head>
<body>
  <header class="hero">
    <div class="wrap">
      <p class="brand">AIRSONDE · AIR QUALITY MONITORING SUPPLY</p>
      <h1>Air Quality Monitors — Straight From the Manufacturer</h1>
      <p class="sub">CO2, PM2.5, TVOC &amp; multi-sensor IAQ monitors. Factory-direct supply, OEM/ODM private-label, and volume trade pricing for brands, distributors &amp; HVAC integrators worldwide.</p>
      <a class="btn" href="#request">Request Wholesale Price List</a>
      <div class="trust">
        <span>Factory-direct</span><span>OEM/ODM ready</span><span>Flexible MOQs</span>
      </div>
    </div>
  </header>

  <section>
    <div class="wrap">
      <h2>Product Categories</h2>
      <p class="lead">A full IAQ monitoring line for homes, offices, schools and commercial buildings — built for resale, integration and private label.</p>
      <div class="grid">${CATEGORIES}</div>
    </div>
  </section>

  <section class="why">
    <div class="wrap">
      <h2>Why partner with AirSonde</h2>
      <p class="lead">Factory-direct IAQ hardware with the flexibility big brands won't give you. Sell more, integrate faster, keep your margin.</p>
      <div class="grid4">
        <div class="card"><b>Factory-direct</b><p>Manufacturer supply, stable stock, and pricing that leaves you real margin.</p></div>
        <div class="card"><b>OEM/ODM ready</b><p>Private-label and custom-spec builds — your brand on proven hardware.</p></div>
        <div class="card"><b>Project-friendly</b><p>Custom specs and data options scoped per project — built for integrators.</p></div>
        <div class="card"><b>Flexible engagement</b><p>From samples to volume — we scale with growing brands and project pipelines.</p></div>
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <h2>FAQ</h2>
      ${FAQS}
    </div>
  </section>

  <section class="formwrap" id="request">
    <div class="wrap">
      <div class="formcard">
        <h2>Request Wholesale Price List</h2>
        <p class="hint">Tell us a bit about your business and we'll email you the catalog and trade pricing shortly.</p>
        <form id="inbound-form" autocomplete="on">
          <div class="field"><label>Company name *</label><input name="company_name" required maxlength="200" placeholder="Your company"></div>
          <div class="row2">
            <div class="field"><label>Email *</label><input name="email" type="email" required maxlength="200" placeholder="you@company.com"></div>
            <div class="field"><label>Country</label><select name="country">${COUNTRY_OPTIONS}</select></div>
          </div>
          <div class="row2">
            <div class="field"><label>Where do you sell?</label><input name="where_sell" maxlength="300" placeholder="e.g. own brand, HVAC projects, Amazon US"></div>
            <div class="field"><label>Monthly volume</label><select name="monthly_volume">
              <option value="">Select…</option><option>&lt; 100 units</option><option>100–1,000 units</option><option>1,000–10,000 units</option><option>10,000+ units</option><option>Not sure yet</option>
            </select></div>
          </div>
          <div class="hp"><label>Company URL</label><input name="company_url" tabindex="-1" autocomplete="off"></div>
          <button class="btn" type="submit" id="submitbtn" style="width:100%;margin-top:6px">Request Price List</button>
          <div id="msg"></div>
        </form>
      </div>
    </div>
  </section>

  <footer><div class="wrap">AirSonde — Air quality monitoring supply for brands, distributors &amp; integrators worldwide.</div></footer>

  <script>
    var f = document.getElementById('inbound-form'), msg = document.getElementById('msg'), btn = document.getElementById('submitbtn');
    f.addEventListener('submit', async function(e){
      e.preventDefault();
      msg.className = ''; msg.textContent = '';
      var d = {};
      new FormData(f).forEach(function(v,k){ d[k] = v; });
      if (!d.company_name || !d.email) { msg.className='err'; msg.textContent='Please fill in your company name and email.'; return; }
      btn.disabled = true; var t = btn.textContent; btn.textContent = 'Sending…';
      try {
        var res = await fetch('/api/inbound', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(d) });
        var j = await res.json().catch(function(){ return {}; });
        if (res.ok && j.ok) {
          f.style.display = 'none';
          msg.className='ok';
          msg.innerHTML = '<div style="text-align:center;padding:10px 0"><div style="font-size:40px">✅</div><h3 style="margin:8px 0">Thank you!</h3><p style="color:#5b6b7f">We\\'ve received your request. Our team will email your wholesale catalog and trade pricing shortly.</p></div>';
        } else if (res.status === 429) {
          msg.className='err'; msg.textContent='You just submitted a request — please wait a moment before trying again.';
        } else {
          msg.className='err'; msg.textContent = (j && j.error) ? j.error : 'Something went wrong. Please try again.';
        }
      } catch (err) {
        msg.className='err'; msg.textContent='Network error. Please try again.';
      } finally { btn.disabled = false; btn.textContent = t; }
    });
  </script>
</body>
</html>`;
}
