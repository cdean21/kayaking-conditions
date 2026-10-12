import { readLocalNotices, validateNoticePayload } from './local-notices.js';
import { buildOfficialMarineSnapshot, BOM_MARINE_WARNINGS, validateTideEvents } from './official-marine.js';
import { buildBiteTimeline } from './bite-timeline.js';
import { lunarDetails } from './lunar.js';
import { dashboard } from './dashboard.js';
import { SPECIES, moonPhase, fishingOutlook } from './fishing.js';
import { MARINE_FIELDS, enrichMarine, tideEvidence } from './fishing-enrichment.js';
const SITES = [
  { id: 'carrum-foreshore', name: 'Carrum Foreshore', lat: -38.077, lon: 145.121 },
  { id: 'patterson-river', name: 'Patterson River Boat Ramp', lat: -38.068, lon: 145.131 }
];
// Approximate offshore sample point; not a measured nearshore station or river-mouth model.
const MARINE_SAMPLE = { lat: -38.09, lon: 145.10 };
const ACTIVITIES = [
  { id: 'fishing', min: 0, max: 10 },
  { id: 'kayaking', min: 0, max: 12 },
  { id: 'sailing', min: 8, max: 20 }
];
const json = (value, status = 200) => new Response(JSON.stringify(value, null, 2), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }
});
const stamp = () => new Date().toISOString();
const hours = (a, b) => (new Date(b) - new Date(a)) / 3600000;
const fmt = (date, opts) => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', ...opts }).format(new Date(date));
const localParts = date => {
  const d = new Date(date);
  const weekday = fmt(d, { weekday: 'short' });
  const hour = Number(fmt(d, { hour: '2-digit', hourCycle: 'h23' }));
  return { weekday, hour };
};
function eligible(date) {
  const { weekday, hour } = localParts(date);
  if (weekday === 'Sat' || weekday === 'Sun') return true;
  return hour >= (weekday === 'Wed' || weekday === 'Fri' ? 16 : 17);
}
function daylight(date, sunrise, sunset) {
  return sunrise && sunset && new Date(date) >= new Date(sunrise) && new Date(date) < new Date(sunset);
}
function apiUrl(base, args) { const u = new URL(base); Object.entries(args).forEach(([k,v]) => u.searchParams.set(k,String(v))); return u; }
async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'kayaking-conditions/0.1' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
  return r.json();
}
async function collect() {
  // Fetch each site separately so wind forecasts aren't mistakenly treated as identical.
  const weather = await Promise.all(SITES.map(async site => ({
    site: site.id,
    data: await fetchJson(apiUrl('https://api.open-meteo.com/v1/forecast', {
      latitude: site.lat, longitude: site.lon, timezone: 'UTC', forecast_days: 4,
      wind_speed_unit: 'kn',
      hourly: 'wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,weather_code,is_day',
      daily: 'sunrise,sunset'
    }))
  })));
  const marine = await fetchJson(apiUrl('https://marine-api.open-meteo.com/v1/marine', {
    latitude: MARINE_SAMPLE.lat, longitude: MARINE_SAMPLE.lon, timezone: 'UTC', forecast_days: 4,
    hourly: 'wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,' + MARINE_FIELDS.join(',')
  }));
  return { weather, marine };
}
function points(data) {
  const wave = new Map((data.marine.hourly?.time || []).map((t, i) => [t, {
    wave_m: data.marine.hourly.wave_height?.[i] ?? null,
    wave_period_s: data.marine.hourly.wave_period?.[i] ?? null,
    wave_direction: data.marine.hourly.wave_direction?.[i] ?? null,
    swell_m: data.marine.hourly.swell_wave_height?.[i] ?? null,
    sea_surface_temp_c: data.marine.hourly.sea_surface_temperature?.[i] ?? null,
    model_sea_level_msl_m: data.marine.hourly.sea_level_height_msl?.[i] ?? null
  }]));
  return data.weather.flatMap(({ site, data: w }) => {
    const h = w.hourly;
    return (h?.time || []).map((t,i) => {
      const time = `${t}Z`;
      const day = (w.daily?.time || []).findIndex(d => t.slice(0,10) === d);
      return {
        site, time, wind: h.wind_speed_10m?.[i] ?? null,
        gust: h.wind_gusts_10m?.[i] ?? null,
        direction: h.wind_direction_10m?.[i] ?? null,
        precipitation: h.precipitation?.[i] ?? null,
        weather_code: h.weather_code?.[i] ?? null,
        is_day: h.is_day?.[i] === 1,
        sunrise: day >= 0 ? `${w.daily.sunrise[day]}Z` : null,
        sunset: day >= 0 ? `${w.daily.sunset[day]}Z` : null,
        ...(wave.get(t) || {})
      };
    });
  });
}
function assess(p, a) {
  const reasons = [];
  if (p.wind === null || p.gust === null || p.wave_m === null) return { ok:false, reasons:['Missing essential forecast values'] };
  if (p.wind < a.min || p.wind > a.max) reasons.push('Sustained wind outside preference');
  // Conservative provisional filters. Not certified safety thresholds.
  if (p.gust > (a.id === 'sailing' ? 24 : 16)) reasons.push('Gusts above provisional preference');
  if (p.wave_m > (a.id === 'sailing' ? 0.7 : 0.4)) reasons.push('Modelled waves above provisional preference');
  if ((p.precipitation ?? 0) >= 2) reasons.push('Heavy precipitation forecast');
  if ([95,96,99].includes(p.weather_code)) reasons.push('Thunderstorm weather code');
  if (!p.is_day || !daylight(p.time,p.sunrise,p.sunset)) reasons.push('Outside daylight');
  if (!eligible(p.time)) reasons.push('Outside preferred outing hours');
  return { ok: reasons.length === 0, reasons };
}
function buildOpportunities(data) {
  const result = [];
  const now = Date.now();
  for (const site of SITES) for (const activity of ACTIVITIES) {
    const ps = points(data).filter(p => p.site === site.id && new Date(p.time).getTime() >= now)
      .sort((a,b) => a.time.localeCompare(b.time));
    let run = [];
    function flush() {
      if (run.length < 2) { run = []; return; }
      const start = run[0].time;
      const end = new Date(new Date(run.at(-1).time).getTime() + 3600000).toISOString();
      if (hours(start,end) < 2) { run=[]; return; }
      const avg = k => +(run.reduce((s,p) => s + (p[k] || 0),0)/run.length).toFixed(1);
      const peak = k => +Math.max(...run.map(p => p[k] || 0)).toFixed(1);
      const details = { mean_wind_kn:avg('wind'), peak_gust_kn:peak('gust'), max_wave_m:peak('wave_m'), mean_wave_period_s:avg('wave_period_s'), sea_surface_temp_c:run.some(p=>p.sea_surface_temp_c !== null) ? +(run.filter(p=>p.sea_surface_temp_c !== null).reduce((a,p)=>a+p.sea_surface_temp_c,0)/run.filter(p=>p.sea_surface_temp_c !== null).length).toFixed(1) : null, wind_direction_deg:avg('direction'), forecast_only:true, safety_verified:false, missing_checks:['official marine warnings','local entrance conditions','site-specific tides and currents','live wind observations'] };
      const key = `${site.id}:${activity.id}:${start.slice(0,13)}`;
      const score = Math.max(0,Math.min(100,Math.round(85 - peak('gust') * .7 - peak('wave_m') * 12)));
      result.push({ key, site_id:site.id, activity:activity.id, starts_at:start, ends_at:end, score, details });
      run = [];
    }
    for (const p of ps) {
      if (assess(p,activity).ok) {
        if (run.length && hours(run.at(-1).time,p.time) !== 1) flush();
        run.push(p);
      } else flush();
    }
    flush();
  }
  return result;
}
async function store(env, data, opportunities) {
  const now = stamp();
  await env.DB.prepare('INSERT INTO tbl_forecast_runs (checked_at,status,weather_json,marine_json) VALUES (?,?,?,?)')
    .bind(now,'ok',JSON.stringify(data.weather),JSON.stringify(data.marine)).run();
  const active = await env.DB.prepare("SELECT * FROM tbl_opportunities WHERE status='candidate' AND ends_at > ?").bind(now).all();
  const old = new Map(active.results.map(o => [o.opportunity_key,o]));
  const keys = new Set();
  let changes = 0;
  for (const o of opportunities) {
    keys.add(o.key);
    const prior = old.get(o.key);
    let event = null;
    if (!prior) event = 'NEW_OPPORTUNITY';
    else if (o.score >= prior.score + 10 || hours(o.starts_at,o.ends_at) >= hours(prior.starts_at,prior.ends_at) + 2) event = 'IMPROVED';
    else if (o.score <= prior.score - 10 || hours(o.starts_at,o.ends_at) <= hours(prior.starts_at,prior.ends_at) - 2) event = 'DETERIORATING';
    await env.DB.prepare(`INSERT INTO tbl_opportunities (opportunity_key,site_id,activity,starts_at,ends_at,score,status,details_json,first_seen_at,last_seen_at)
      VALUES (?,?,?,?,? ,?,'candidate',?,?,?) ON CONFLICT(opportunity_key) DO UPDATE SET ends_at=excluded.ends_at,score=excluded.score,status='candidate',details_json=excluded.details_json,last_seen_at=excluded.last_seen_at`)
      .bind(o.key,o.site_id,o.activity,o.starts_at,o.ends_at,o.score,JSON.stringify(o.details),prior?.first_seen_at || now,now).run();
    if (event) { await eventRow(env,o.key,event,{ ...o, prior_score:prior?.score ?? null }); changes++; }
  }
  for (const o of active.results) if (!keys.has(o.opportunity_key)) {
    await env.DB.prepare("UPDATE tbl_opportunities SET status='expired_or_deteriorated',last_seen_at=? WHERE opportunity_key=?").bind(now,o.opportunity_key).run();
    await eventRow(env,o.opportunity_key,'DETERIORATING_OR_CANCELLED',{ previous: o, note:'Previously detected forecast window no longer meets provisional model criteria; re-check sources.' }); changes++;
  }
  return changes;
}
async function eventRow(env,key,type,details) {
  await env.DB.prepare('INSERT INTO tbl_alert_events (opportunity_key,event_type,created_at,details_json) VALUES (?,?,?,?)')
    .bind(key,type,stamp(),JSON.stringify(details)).run();
}
// Pushover delivery is intentionally opt-in. Unverified forecast candidates must not
// generate positive launch recommendations until official safety feeds are integrated.
async function sendPushover(env, { title, message, priority = 0, url }) {
  if (!env.PUSHOVER_APP_TOKEN || !env.PUSHOVER_USER_KEY) throw new Error('Pushover secrets are not configured');
  const body = new URLSearchParams({
    token: env.PUSHOVER_APP_TOKEN, user: env.PUSHOVER_USER_KEY,
    title, message, priority: String(priority), sound: 'pushover'
  });
  if (url) { body.set('url', url); body.set('url_title', 'View Kayaking conditions'); }
  const response = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(), signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== 1) {
    throw new Error(`Pushover delivery failed (HTTP ${response.status}): ${JSON.stringify(payload.errors || [])}`);
  }
  return { status: 'sent', request: payload.request || null };
}
async function deliverPendingAlerts(env) {
  if (env.ALERTS_ENABLED !== 'true') return { sent: 0, note: 'Alerts disabled' };
  // Positive events are blocked until independent safety checks exist.
  // This avoids sending a misleading 'good to go' notification from forecast-only data.
  const rows = await env.DB.prepare(`SELECT id, event_type, details_json FROM tbl_alert_events
    WHERE delivery_status='pending' AND event_type IN ('DETERIORATING','DETERIORATING_OR_CANCELLED')
    ORDER BY id ASC LIMIT 20`).all();
  let sent = 0;
  for (const row of rows.results) {
    const details = JSON.parse(row.details_json || '{}');
    const site = SITES.find(s => s.id === (details.site_id || details.previous?.site_id));
    const activity = details.activity || details.previous?.activity || 'Hobie outing';
    const result = await sendPushover(env, {
      title: 'Hobie: conditions deteriorating',
      message: `${activity} at ${site?.name || 'Carrum'}: a previously identified forecast window no longer meets the provisional conditions. Recheck official marine warnings and local conditions before departure.`,
      priority: 0
    });
    await env.DB.prepare(`UPDATE tbl_alert_events SET delivery_status='sent' WHERE id=?`).bind(row.id).run();
    sent++;
  }
  return { sent };
}
const BOM_SNAPSHOT_MAX_AGE_MS = 3 * 60 * 60 * 1000;

async function ingestOfficialMarine(env, warningXml, forecastXml) {
  if (typeof warningXml !== 'string' || typeof forecastXml !== 'string') throw new Error('Expected warning_xml and forecast_xml strings');
  if (warningXml.length > 750000 || forecastXml.length > 750000) throw new Error('BOM product exceeds size limit');
  const checkedAt = stamp();
  const official = buildOfficialMarineSnapshot(warningXml, forecastXml, new Date());
  await env.DB.prepare(`INSERT INTO tbl_bom_snapshots (id,checked_at,status,details_json) VALUES (1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,status=excluded.status,details_json=excluded.details_json`)
    .bind(checkedAt,official.status,JSON.stringify(official)).run();
  return { ok:true, ...official };
}

async function readOfficialMarineSnapshot(env) {
  const row = await env.DB.prepare('SELECT checked_at,status,details_json FROM tbl_bom_snapshots WHERE id=1').first();
  if (!row) return { status:'missing', positive_alert_gate:'blocked', stale:true, note:'No validated BOM snapshot has been ingested yet.' };
  let details;
  try { details = JSON.parse(row.details_json || '{}'); }
  catch { return { status:'invalid', positive_alert_gate:'blocked', stale:true, checked_at:row.checked_at, note:'Stored BOM snapshot could not be parsed.' }; }
  const checkedMs = Date.parse(row.checked_at);
  const ageMs = Number.isFinite(checkedMs) ? Date.now() - checkedMs : Infinity;
  const productStale = !!details.warning?.stale || !!details.forecast?.stale;
  const stale = ageMs > BOM_SNAPSHOT_MAX_AGE_MS || productStale;
  return { ...details, checked_at:row.checked_at, snapshot_age_minutes:Number.isFinite(ageMs)?Math.max(0,Math.round(ageMs/60000)):null, stale, positive_alert_gate:stale?'blocked':(details.positive_alert_gate || 'blocked') };
}

async function run(env) {
  try {
    const official = await readOfficialMarineSnapshot(env);
    const data = await collect();
    const opportunities = buildOpportunities(data);
    const changes = await store(env,data,opportunities);
    const delivery = await deliverPendingAlerts(env);
    return { checked_at:stamp(), candidates:opportunities.length, change_events:changes, delivery, official_marine:official, safety_verified:false, note:'Forecast run reads the latest validated BOM snapshot from D1 and never waits on FTP. Missing or stale BOM data blocks positive alerts. Patterson River entrance/live launch conditions remain a separate safety gate.' };
  } catch (e) {
    await env.DB.prepare('INSERT INTO tbl_forecast_runs (checked_at,status,error) VALUES (?,?,?)').bind(stamp(),'error',String(e)).run();
    throw e;
  }
}
async function auth(request,env) {
  const expected = env.ADMIN_TOKEN;
  return !!expected && request.headers.get('authorization') === `Bearer ${expected}`;
}
export default {
  async fetch(request,env) {
    const u = new URL(request.url);
    try {
      if (u.pathname === '/' || u.pathname === '/dashboard') return new Response(dashboard,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
      if (u.pathname === '/api/health') return json({ ok:true, service:'kayaking-conditions', time:stamp() });
      if (u.pathname === '/api/sites') return json({ sites:SITES, marine_sample:MARINE_SAMPLE, note:'Coordinates are approximate and require verification.' });
      if (u.pathname === '/api/opportunities') {
        const rows = await env.DB.prepare("SELECT * FROM tbl_opportunities WHERE status='candidate' AND ends_at > ? ORDER BY starts_at ASC LIMIT 100").bind(stamp()).all();
        return json({ safety_verified:false, opportunities:rows.results.map(x=>({ ...x, details:JSON.parse(x.details_json), details_json:undefined })) });
      }
      if (u.pathname === '/api/local/notices' && request.method === 'GET') {
        const site=u.searchParams.get('site')||'patterson-river';
        if (!SITES.some(s=>s.id===site)) return json({error:'Unknown site'},400);
        return json(await readLocalNotices(env,site));
      }
      if (u.pathname === '/api/local/notices/ingest' && request.method === 'POST') {
        const expected=env.BOM_INGEST_TOKEN;
        if(!expected || request.headers.get('authorization')!==`Bearer ${expected}`) return json({error:'Unauthorized'},401);
        const payload=validateNoticePayload(await request.json());
        await env.DB.prepare('INSERT INTO tbl_local_notice_snapshots (fetched_at,payload_json) VALUES (?,?)').bind(payload.fetched_at,JSON.stringify(payload)).run();
        return json({ok:true,ingested:payload.notices.length,launch_verified:false});
      }
      if (u.pathname === '/api/official/marine') {
        const check=await readOfficialMarineSnapshot(env);
        return json({ check, safety_verified:false });
      }
      if (u.pathname === '/api/fishing/sources') return json({ temperature:'Open-Meteo numerical marine forecast (not observed)', tide:tideEvidence(), safety_verified:false });
      if (u.pathname === '/api/fishing/species') return json({ species:SPECIES, note:'Priority order is user preference, not a catch likelihood ranking.' });
      if (u.pathname === '/api/fishing/moon') {
        const requested = u.searchParams.get('at') || stamp();
        if (!Number.isFinite(Date.parse(requested))) return json({ error:'Invalid at timestamp' },400);
        return json({ at:requested, moon:lunarDetails(requested) });
      }
      if (u.pathname === '/api/fishing/tides' && request.method === 'GET') {
        const rows=await env.DB.prepare("SELECT reference_station,event_at,event_type,height_m,datum,source_name,source_url FROM tbl_verified_tides WHERE datetime(event_at) >= datetime(?) ORDER BY datetime(event_at) LIMIT 40").bind(new Date(Date.now()-86400000).toISOString()).all();
        return json({events:rows.results,source:'manually entered, source-verified predictions only',local_entrance_verified:false});
      }
      if (u.pathname === '/api/fishing/tides' && request.method === 'POST') {
        if (!await auth(request,env)) return json({error:'Unauthorized'},401);
        const data=await request.json();
        if (!Array.isArray(data.events)||data.events.length>100) return json({error:'Expected events array of up to 100'},400);
        let events;
        try { events=validateTideEvents(data.events); }
        catch(e) { return json({error:String(e)},400); }
        const statements=events.map(e=>env.DB.prepare('INSERT OR REPLACE INTO tbl_verified_tides (reference_station,event_at,event_type,height_m,datum,source_name,source_url,source_year,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(e.reference_station,e.event_at,e.event_type,e.height_m,e.datum,e.source_name,e.source_url,e.source_year,stamp()));
        if(statements.length) await env.DB.batch(statements);
        return json({ok:true,imported:statements.length,warning:'Only enter values transcribed and checked against the official BOM tide PDF; this endpoint cannot independently verify them.'});
      }
      if (u.pathname === '/api/fishing/timeline') {
        const site=u.searchParams.get('site')||'carrum-foreshore';
        if (!SITES.some(s=>s.id===site)) return json({error:'Unknown site'},400);
        const row=await env.DB.prepare("SELECT checked_at,weather_json,marine_json FROM tbl_forecast_runs WHERE status='ok' ORDER BY id DESC LIMIT 1").first();
        if(!row) return json({site,status:'missing_forecast',hours:[],message:'Run forecast collection first'});
        const tideStart=new Date(Date.now()-12*3600000).toISOString();
        const tideEnd=new Date(Date.now()+84*3600000).toISOString();
        const tides=await env.DB.prepare("SELECT reference_station,event_at,event_type,height_m,datum,source_name FROM tbl_verified_tides WHERE datetime(event_at) >= datetime(?) AND datetime(event_at) <= datetime(?) ORDER BY datetime(event_at) LIMIT 100").bind(tideStart,tideEnd).all();
        return json(buildBiteTimeline({weather:JSON.parse(row.weather_json),marine:JSON.parse(row.marine_json),checkedAt:row.checked_at,tides:tides.results,site}));
      }
      if (u.pathname === '/api/fishing/outlook') {
        const rows = await env.DB.prepare("SELECT * FROM tbl_opportunities WHERE activity='fishing' AND status='candidate' AND ends_at > ? ORDER BY starts_at ASC LIMIT 100").bind(stamp()).all();
        const opportunities = rows.results.map(x=>({ key:x.opportunity_key,site_id:x.site_id,activity:x.activity,starts_at:x.starts_at,ends_at:x.ends_at,details:JSON.parse(x.details_json) }));
        return json({ outlook:fishingOutlook(opportunities), source:'stored provisional forecasts', safety_verified:false });
      }
      if (u.pathname === '/api/events') {
        const rows = await env.DB.prepare('SELECT * FROM tbl_alert_events ORDER BY id DESC LIMIT 100').all();
        return json({ events:rows.results });
      }
      if (u.pathname === '/api/status') {
        const row = await env.DB.prepare('SELECT id,checked_at,status,error FROM tbl_forecast_runs ORDER BY id DESC LIMIT 1').first();
        return json({ latest_run:row, official_marine_external_ingest:true,official_port_phillip_forecast_integrated:true,official_safety_feeds_integrated:false, notifications_integrated:true, notifications_enabled:env.ALERTS_ENABLED === 'true', positive_alerts_blocked:true });
      }
      if (u.pathname === '/api/pushover/test' && request.method === 'POST') {
        if (!await auth(request,env)) return json({ error:'Unauthorized' },401);
        const delivery = await sendPushover(env, {
          title: 'Kayaking Conditions Watch — Test',
          message: 'Your Carrum Hobie lock-screen notifications are connected. This is a test, not a marine forecast.',
          priority: 0
        });
        return json({ ok:true, delivery });
      }
      if (u.pathname === '/api/bom/ingest' && request.method === 'POST') {
        const expected = env.BOM_INGEST_TOKEN;
        if (!expected || request.headers.get('authorization') !== `Bearer ${expected}`) return json({ error:'Unauthorized' },401);
        const body = await request.json();
        return json(await ingestOfficialMarine(env, body.warning_xml, body.forecast_xml));
      }
      if (u.pathname === '/api/run' && request.method === 'POST') {
        if (!await auth(request,env)) return json({ error:'Unauthorized' },401);
        return json(await run(env));
      }
      return json({ error:'Not found' },404);
    } catch(e) { return json({ error:String(e) },500); }
  },
  async scheduled(event,env,ctx) {
    // Official BOM products are ingested independently by GitHub Actions every 30 minutes.
    // Opportunity checks run only at the selected Melbourne-local notification times.
    const { weekday, hour } = localParts(event.scheduledTime);
    const weekend = weekday === 'Sat' || weekday === 'Sun';
    if (hour !== 7 && hour !== 15 && !(weekend && hour === 11)) return;
    ctx.waitUntil(run(env));
  }
};
