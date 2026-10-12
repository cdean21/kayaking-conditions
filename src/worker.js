import { readLocalNotices, validateNoticePayload } from './local-notices.js';
import { assessLaunch, activityPreferenceFit } from './launch-assessment.js';
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
const RETURN_BUFFER_MINUTES = 30;
const FORECAST_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const STABLE_OPPORTUNITY_KEY_RE = /^[^:]+:[^:]+:\d{4}-\d{2}-\d{2}$/;
const isStableOpportunityKey = key => STABLE_OPPORTUNITY_KEY_RE.test(String(key || ''));
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
  const host = new URL(url).host;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': 'kayaking-conditions/0.1' },
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) {
        const error = new Error(`${host}: HTTP ${r.status}`);
        // Retry rate limiting and server-side/transient failures only.
        if (r.status !== 429 && r.status < 500) throw error;
        lastError = error;
      } else {
        return await r.json();
      }
    } catch (err) {
      lastError = err;
      // A non-retryable HTTP error thrown above should fail immediately.
      if (
        err instanceof Error &&
        /^.+: HTTP 4\d\d$/.test(err.message) &&
        !err.message.endsWith('HTTP 429')
      ) {
        throw err;
      }
    }
    if (attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 750));
    }
  }
  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `${host}: forecast fetch failed after 2 attempts: ${message}`
  );
}
async function collect() {
  const checkedAt = stamp();
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
  return { weather, marine, checkedAt };
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
function verifiedTideContext(at,tides=[]){
  const target=Date.parse(at);
  if(!Number.isFinite(target)) return {status:'missing',reference_station:'Melbourne (Williamstown)',reason:'invalid assessment time'};
  const sorted=(tides||[]).filter(t=>t?.reference_station==='Melbourne (Williamstown)'&&Number.isFinite(Date.parse(t.event_at))&&['high','low'].includes(t.event_type)&&Number.isFinite(Number(t.height_m))).sort((a,b)=>Date.parse(a.event_at)-Date.parse(b.event_at));
  let previous=null,next=null;
  for(const t of sorted){const ms=Date.parse(t.event_at);if(ms<=target)previous=t;if(ms>target){next=t;break;}}
  if(!previous||!next) return {status:'missing',reference_station:'Melbourne (Williamstown)',reason:'verified tide turning points do not bracket this hour'};
  const a=Date.parse(previous.event_at),b=Date.parse(next.event_at);
  if(!(b>a)||target-a>9*3600000||b-target>9*3600000) return {status:'missing',reference_station:'Melbourne (Williamstown)',reason:'verified tide turning points are too distant to cover this hour'};
  const fraction=Math.max(0,Math.min(1,(target-a)/(b-a)));
  const smooth=(1-Math.cos(Math.PI*fraction))/2;
  const estimated=Number(previous.height_m)+(Number(next.height_m)-Number(previous.height_m))*smooth;
  return {status:'verified_reference',reference_station:'Melbourne (Williamstown)',datum:previous.datum||next.datum||null,direction:next.event_type==='high'?'rising':'falling',estimated_height_m:+estimated.toFixed(2),previous_type:previous.event_type,previous_at:previous.event_at,previous_height_m:Number(previous.height_m),next_type:next.event_type,next_at:next.event_at,next_height_m:Number(next.height_m),minutes_to_next:Math.max(0,Math.round((b-target)/60000)),entrance_measurement:false,note:'BOM Melbourne (Williamstown) reference prediction only — not a Patterson River entrance depth/current measurement.'};
}
async function readVerifiedTides(env,startAt,endAt){
  const start=new Date(Date.parse(startAt)-12*3600000).toISOString();
  const end=new Date(Date.parse(endAt)+12*3600000).toISOString();
  const rows=await env.DB.prepare(`SELECT reference_station,event_at,event_type,height_m,datum,source_name,source_url FROM tbl_verified_tides WHERE reference_station='Melbourne (Williamstown)' AND datetime(event_at) >= datetime(?) AND datetime(event_at) <= datetime(?) ORDER BY datetime(event_at) LIMIT 100`).bind(start,end).all();
  return rows.results||[];
}

function environmentalStatus(assessment){
  if(assessment.status==='blocked'||assessment.status==='incomplete') return assessment.status;
  const environmentalCautions=(assessment.cautions||[]).filter(c=>!c.startsWith('Local navigation advisory'));
  return environmentalCautions.length?'marginal':'preferred';
}
function windowQuality(statuses){
  return statuses.every(s=>s==='preferred')?'preferred':'marginal';
}
function opportunityScore(run,quality){
  const peak=k=>Math.max(...run.map(x=>x.point[k]||0));
  const base=quality==='preferred'?92:76;
  return Math.max(0,Math.min(100,Math.round(base-peak('gust')*.35-peak('wave_m')*8)));
}

function activityFitScore(o) {
  const d=o.details||{};
  return activityPreferenceFit(o.activity,{wind:Number(d.mean_wind_kn),gust:Number(d.peak_gust_kn),wave:Number(d.max_wave_m)}).score;
}
function recommendationConfidence(o){
  const d=o.details||{},hourly=d.hourly||[];
  const preferred=hourly.filter(h=>h.assessment_status==='preferred').length,total=Math.max(1,hourly.length);
  let score=55+Math.round(25*(preferred/total));
  const bom=(d.bom_cross_check||[]).length,advisories=(d.advisories||[]).length;
  score+=bom?-12:12; score-=Math.min(18,advisories*8);
  const age=Date.now()-Date.parse(d.forecast_checked_at||'');
  if(Number.isFinite(age)){if(age<=3600000)score+=8;else if(age>7200000)score-=8;}else score-=20;
  score=Math.max(0,Math.min(100,score));
  return {score,level:score>=80?'HIGH':score>=60?'MEDIUM':'LOW',basis:{preferred_hours:preferred,total_hours:hourly.length,bom_model_disagreement:bom>0,advisory_count:advisories}};
}

function recommendationRank(o) {
  const d=o.details||{};
  const hourly=d.hourly||[];
  const underlyingPreferred=hourly.filter(
    h=>h.assessment_status==='preferred'
  ).length;

  return (
    (d.classification==='preferred'?100000:50000) +
    underlyingPreferred*5000 +
    activityFitScore(o)*500 +
    (Number(d.duration_hours)||0)*100 -
    (Number(d.peak_gust_kn)||0) -
    (Number(d.max_wave_m)||0)*10 -
    (d.advisories||[]).length*100
  );
}

function activityRecommendationReason(o, comparison=[]) {
  const d=o.details||{};
  const wind=Number(d.mean_wind_kn);
  const gust=Number(d.peak_gust_kn);
  const wave=Number(d.max_wave_m);
  const winnerFit=activityPreferenceFit(o.activity,{wind,gust,wave});
  const runner=[...comparison].filter(x=>x?.available&&x.activity!==o.activity).sort((a,b)=>(b.rank||0)-(a.rank||0))[0];

  const conditions=[
    Number.isFinite(wind)?`${wind.toFixed(1)} kt mean wind`:null,
    Number.isFinite(gust)?`gusts to ${gust.toFixed(1)} kt`:null,
    Number.isFinite(wave)?`modelled waves to ${wave.toFixed(2)} m`:null
  ].filter(Boolean).join(', ');

  const preferred=(winnerFit.reasons||[]).map(x=>x.replace(' in preferred range','')).join(', ');
  let why=preferred?`${activityLabel(o.activity)} matches the preferred ${preferred} bands.`:`${activityLabel(o.activity)} has the strongest overall fit for this window.`;

  if(runner){
    const gap=Math.round((recommendationRank(o)-Number(runner.rank||0))*10)/10;
    const closeness=gap<2500?'narrowly ':'';
    why+=` It ${closeness}ranks ahead of ${activityLabel(runner.activity).toLowerCase()}`;
    const runnerFit=Number(runner.fit_score);
    if(Number.isFinite(runnerFit)) why+=` (${winnerFit.score} vs ${runnerFit} preference-fit points)`;
    why+='.';
  }

  return `${conditions}. ${why}`;
}
function bestSpeciesForWindow(o,data,tides,official,noticesBySite) {
  if(o.activity!=='fishing') return null;

  const timeline=buildBiteTimeline({
    weather:data.weather,
    marine:data.marine,
    checkedAt:o.details?.forecast_checked_at||data.checkedAt,
    tides,
    site:o.site_id,
    now:o.starts_at,
    limit:Math.ceil(hours(o.starts_at,o.ends_at)),
    launchContext:{
      official,
      notices:noticesBySite[o.site_id]
    }
  });

  const start=Date.parse(o.starts_at);
  const end=Date.parse(o.ends_at);
  const relevant=(timeline.hours||[]).filter(h=>{
    const t=Date.parse(h.time);
    return t>=start&&t<end;
  });

  const species=new Map();

  for(const h of relevant){
    for(const s of h.species||[]){
      if(!Number.isFinite(Number(s.score))) continue;
      if(!species.has(s.id)){
        species.set(s.id,{
          id:s.id,
          name:s.name,
          scores:[],
          priority:Number(s.priority)||999
        });
      }
      species.get(s.id).scores.push(Number(s.score));
    }
  }

  const ranked=[...species.values()].map(s=>({
    id:s.id,
    name:s.name,
    mean_score:+(
      s.scores.reduce((a,b)=>a+b,0)/s.scores.length
    ).toFixed(1),
    peak_score:Math.max(...s.scores),
    priority:s.priority
  })).sort((a,b)=>
    b.mean_score-a.mean_score ||
    b.peak_score-a.peak_score ||
    a.priority-b.priority
  );

  return ranked[0]||null;
}

function annotateRecommendations(opportunities,data,official,noticesBySite,tides) {
  const groups=new Map();
  for(const o of opportunities){const key=localDateKey(o.starts_at);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(o);}
  for(const [localDate,group] of groups){
    const ranked=[...group].sort((a,b)=>recommendationRank(b)-recommendationRank(a)||Date.parse(a.starts_at)-Date.parse(b.starts_at));
    const winner=ranked[0]; if(!winner)continue;
    const species=bestSpeciesForWindow(winner,data,tides,official,noticesBySite),confidence=recommendationConfidence(winner);
    const comparison=['fishing','kayaking','sailing'].map(activity=>{const pick=ranked.find(x=>x.activity===activity);if(!pick)return {activity,available:false};const fit=activityPreferenceFit(activity,{wind:Number(pick.details?.mean_wind_kn),gust:Number(pick.details?.peak_gust_kn),wave:Number(pick.details?.max_wave_m)});return {activity,available:true,site_id:pick.site_id,starts_at:pick.starts_at,ends_at:pick.ends_at,classification:pick.details?.classification,rank:recommendationRank(pick),fit_score:fit.score,fit_reasons:fit.reasons,mean_wind_kn:pick.details?.mean_wind_kn,peak_gust_kn:pick.details?.peak_gust_kn,max_wave_m:pick.details?.max_wave_m,is_winner:pick===winner};});
    const reason=activityRecommendationReason(winner,comparison);
    for(const o of group)o.details.recommendation={local_date:localDate,best_activity:winner.activity,best_activity_label:activityLabel(winner.activity),best_site_id:winner.site_id,best_starts_at:winner.starts_at,best_ends_at:winner.ends_at,is_best_activity:o===winner,is_best_outing:o===winner,reason,best_species:species,confidence,comparison};
  }
  return opportunities;
}

function bomPeriodAt(official, at){
  const t=Date.parse(at);
  return (official?.forecast?.periods||[]).find(p=>{
    const start=Date.parse(p.start_at), end=Date.parse(p.end_at);
    return Number.isFinite(start)&&Number.isFinite(end)&&t>=start&&t<end;
  })||null;
}

function bomUpperWindKn(text){
  if(typeof text !== 'string') return null;
  const values = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:knots?|kt)\b/gi)]
    .map(m => Number(m[1]))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function bomUpperSeaM(text){
  if(typeof text !== 'string') return null;
  const values = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:metres?|meters?|m)\b/gi)]
    .map(m => Number(m[1]))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function bomCrossCheck(official, point, activity){
  const period=bomPeriodAt(official,point.time);
  if(!period) return {material:false,reason:null,period:null,bom_wind_upper_kn:null,bom_seas_upper_m:null};

  const bomWind=bomUpperWindKn(period.winds);
  const bomSea=bomUpperSeaM(period.seas);
  const modelWind=Number(point.wind);
  const modelWave=Number(point.wave_m);

  // Broad Port Phillip forecasts are a conservative cross-check, not a Carrum/Patterson measurement.
  // Only downgrade a preferred hour when the official forecast is materially rougher.
  const windMaterial=Number.isFinite(bomWind)&&Number.isFinite(modelWind)&&bomWind>=modelWind+5;
  const seaMaterial=Number.isFinite(bomSea)&&Number.isFinite(modelWave)&&bomSea>=modelWave+0.3;
  if(!windMaterial&&!seaMaterial) return {material:false,reason:null,period,bom_wind_upper_kn:bomWind,bom_seas_upper_m:bomSea};

  const parts=[];
  if(windMaterial) parts.push(`BOM Port Phillip winds up to ${bomWind} kn vs numerical model ${modelWind.toFixed(1)} kn`);
  if(seaMaterial) parts.push(`BOM Port Phillip seas up to ${bomSea.toFixed(1)} m vs numerical model ${modelWave.toFixed(2)} m`);
  return {
    material:true,
    reason:`Official Port Phillip local-waters forecast is materially rougher: ${parts.join('; ')}.`,
    period,
    bom_wind_upper_kn:bomWind,
    bom_seas_upper_m:bomSea
  };
}

function buildOpportunities(data, official, noticesBySite, tides=[], forecastCheckedAt=data?.checkedAt) {
  const result=[], now=Date.now();
  const forecastCheckedMs=Date.parse(forecastCheckedAt || '');
  const forecastAgeMs=Number.isFinite(forecastCheckedMs) ? now-forecastCheckedMs : Infinity;
  if(forecastAgeMs > FORECAST_MAX_AGE_MS) return result;
  for(const site of SITES) for(const activity of ACTIVITIES){
    const ps=points(data).filter(p=>p.site===site.id&&Date.parse(p.time)>=now&&Date.parse(p.time)<=now+72*3600000).sort((a,b)=>a.time.localeCompare(b.time));
    let run=[];
    const flush=()=>{
      if(run.length<2){run=[];return;}
      const start=run[0].point.time,end=new Date(Date.parse(run.at(-1).point.time)+3600000).toISOString();
      if(hours(start,end)<2){run=[];return;}
      const avg=k=>+(run.reduce((n,x)=>n+(x.point[k]||0),0)/run.length).toFixed(1);
      const peak=k=>+Math.max(...run.map(x=>x.point[k]||0)).toFixed(2);
      const environmentalStatuses=run.map(x=>{
        const base=environmentalStatus(x.assessment);
        return base==='preferred'&&x.bomCrossCheck?.material?'marginal':base;
      });
      const quality=windowQuality(environmentalStatuses);
      const preferredHours=environmentalStatuses.filter(x=>x==='preferred').length;
      const marginalHours=run.length-preferredHours;
      const ranked=[...run].sort((a,b)=>{
        const baseA=environmentalStatus(a.assessment), baseB=environmentalStatus(b.assessment);
        const as=baseA==='preferred'&&a.bomCrossCheck?.material?'marginal':baseA;
        const bs=baseB==='preferred'&&b.bomCrossCheck?.material?'marginal':baseB;
        if(as!==bs) return as==='preferred'?-1:1;
        const burden=x=>(x.point.wind||0)/10+(x.point.gust||0)/20+(x.point.wave_m||0)/.8;
        return burden(a)-burden(b) || a.point.time.localeCompare(b.point.time);
      });
      const bestDeparture=ranked[0]?.point.time||start;
      const advisories=[...new Set(run.flatMap(x=>(x.assessment.cautions||[]).filter(c=>c.startsWith('Local navigation advisory'))))];
      // Summarise each material BOM period once at window level; preserve precise hourly reasons below.
      const materialHours=run.filter(x=>x.bomCrossCheck?.material);
      const bomPeriodGroups=new Map();
      for(const x of materialHours){
        const period=x.bomCrossCheck.period;
        const key=period?.start_at||'unknown';
        if(!bomPeriodGroups.has(key)) bomPeriodGroups.set(key,{period,points:[]});
        bomPeriodGroups.get(key).points.push(x.point);
      }
      const bomComparisons=[...bomPeriodGroups.values()].map(({period,points:matched})=>{
        const values=field=>matched.map(p=>Number(p[field])).filter(Number.isFinite);
        const winds=values('wind'), waves=values('wave_m');
        return {
          period_start_at:period?.start_at||null,
          period_end_at:period?.end_at||null,
          bom_winds:period?.winds||null,
          bom_seas:period?.seas||null,
          bom_wind_upper_kn:bomUpperWindKn(period?.winds),
          bom_seas_upper_m:bomUpperSeaM(period?.seas),
          local_wind_min_kn:winds.length?+Math.min(...winds).toFixed(1):null,
          local_wind_max_kn:winds.length?+Math.max(...winds).toFixed(1):null,
          local_wave_min_m:waves.length?+Math.min(...waves).toFixed(2):null,
          local_wave_max_m:waves.length?+Math.max(...waves).toFixed(2):null
        };
      });
      const bomCrossChecks=bomComparisons.map(x=>{
        const localWind=x.local_wind_min_kn==null?'unavailable':`${x.local_wind_min_kn}${x.local_wind_max_kn===x.local_wind_min_kn?'':`–${x.local_wind_max_kn}`} kt`;
        const localWave=x.local_wave_min_m==null?'unavailable':`${x.local_wave_min_m}${x.local_wave_max_m===x.local_wave_min_m?'':`–${x.local_wave_max_m}`} m`;
        return `BOM Port Phillip local-waters forecast: winds ${x.bom_winds||'unavailable'} seas ${x.bom_seas||'unavailable'} Materially rougher than numerical model wind ${localWind}, waves ${localWave}. Broad-area forecast, not a launch-site measurement.`;
      });
      const details={classification:quality,duration_hours:hours(start,end),preferred_hours:preferredHours,marginal_hours:marginalHours,best_departure:bestDeparture,advisories,bom_cross_check:bomCrossChecks,bom_comparison:bomComparisons,
        mean_wind_kn:avg('wind'),peak_gust_kn:peak('gust'),max_wave_m:peak('wave_m'),mean_wave_period_s:avg('wave_period_s'),
        wind_direction_deg:avg('direction'),tide_reference:verifiedTideContext(bestDeparture,tides),hourly:run.map((x,i)=>({time:x.point.time,status:environmentalStatuses[i],assessment_status:x.assessment.status,tide:x.tide,cautions:[...(x.assessment.cautions||[]),...(x.bomCrossCheck?.reason?[x.bomCrossCheck.reason]:[])],blockers:x.assessment.blockers,bom_cross_check:x.bomCrossCheck?.material?{material:true,reason:x.bomCrossCheck.reason,winds:x.bomCrossCheck.period?.winds||null,seas:x.bomCrossCheck.period?.seas||null}:null})),
        arrival_checks:run[0].assessment.arrival_checks||[],return_buffer_minutes:RETURN_BUFFER_MINUTES,feasible_return_rule:'Window must end at least 30 minutes before forecast sunset',forecast_checked_at:forecastCheckedAt,launch_verified:false,official_checks_included:true};
      result.push({key:`${site.id}:${activity.id}:${localDateKey(start)}`,site_id:site.id,activity:activity.id,starts_at:start,ends_at:end,score:opportunityScore(run,quality),details});
      run=[];
    };
    for(const p of ps){
      const hourEnd=Date.parse(p.time)+3600000;
      const returnDeadline=Date.parse(p.sunset)-RETURN_BUFFER_MINUTES*60000;
      if(!eligible(p.time)||!p.is_day||!daylight(p.time,p.sunrise,p.sunset)||!Number.isFinite(returnDeadline)||hourEnd>returnDeadline){flush();continue;}
      const tide=verifiedTideContext(p.time,tides);
      const assessment=assessLaunch({site:site.id,activity:activity.id,official,notices:noticesBySite[site.id],point:p,forecastCheckedAt,at:p.time,tide});
      const crossCheck=bomCrossCheck(official,p,activity);
      if(['preferred','marginal'].includes(assessment.status)){
        if(run.length&&hours(run.at(-1).point.time,p.time)!==1)flush();
        run.push({point:p,assessment,bomCrossCheck:crossCheck,tide});
      }else flush();
    }
    flush();
  }
  return annotateRecommendations(
    result,
    data,
    official,
    noticesBySite,
    tides
  );
}
function localDateKey(iso){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Melbourne',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));
}
function parseDetails(row){ try{return JSON.parse(row.details_json||'{}')}catch{return {}} }
function overlapHours(aStart,aEnd,bStart,bEnd){
  return Math.max(0,(Math.min(Date.parse(aEnd),Date.parse(bEnd))-Math.max(Date.parse(aStart),Date.parse(bStart)))/3600000);
}
function stableWindowKey(o){
  return `${o.site_id}:${o.activity}:${localDateKey(o.starts_at)}`;
}
function matchPrior(o,rows,used){
  const same=rows.filter(r=>!used.has(r.opportunity_key)&&r.site_id===o.site_id&&r.activity===o.activity&&localDateKey(r.starts_at)===localDateKey(o.starts_at));
  if(!same.length)return null;
  return same.sort((a,b)=>{
    const ao=overlapHours(a.starts_at,a.ends_at,o.starts_at,o.ends_at),bo=overlapHours(b.starts_at,b.ends_at,o.starts_at,o.ends_at);
    if(ao!==bo)return bo-ao;
    return Math.abs(Date.parse(a.starts_at)-Date.parse(o.starts_at))-Math.abs(Date.parse(b.starts_at)-Date.parse(o.starts_at));
  })[0];
}
function classifyChange(prior,o){
  const pd=parseDetails(prior), nd=o.details||{};
  const oldClass=pd.classification||'marginal', newClass=nd.classification||'marginal';


  const oldDur=hours(prior.starts_at,prior.ends_at), newDur=hours(o.starts_at,o.ends_at);
  const startShift=(Date.parse(o.starts_at)-Date.parse(prior.starts_at))/3600000;
  const endShift=(Date.parse(o.ends_at)-Date.parse(prior.ends_at))/3600000;
  // Hysteresis: ignore ordinary one-hour model wobble unless quality changes.
  if(oldClass==='marginal'&&newClass==='preferred') return 'IMPROVED';
  if(oldClass==='preferred'&&newClass==='marginal') return 'DETERIORATING';
  if(newDur>=oldDur+2 || o.score>=prior.score+10 || startShift<=-2 || endShift>=2) return 'IMPROVED';
  if(newDur<=oldDur-2 || o.score<=prior.score-10 || startShift>=2 || endShift<=-2) return 'DETERIORATING';
  return null;
}
async function store(env,data,opportunities){
  const now=stamp();
  const forecastCheckedAt=data?.checkedAt || now;
  await env.DB.prepare('INSERT INTO tbl_forecast_runs (checked_at,status,weather_json,marine_json) VALUES (?,?,?,?)')
    .bind(forecastCheckedAt,'ok',JSON.stringify(data.weather),JSON.stringify(data.marine)).run();
  const active=await env.DB.prepare("SELECT * FROM tbl_opportunities WHERE status='candidate' AND ends_at > ?").bind(now).all();
  const rows=active.results||[], used=new Set(), surviving=new Set();
  let changes=0;
  for(const incoming of opportunities){
    const o={...incoming,key:stableWindowKey(incoming)};
    const prior=matchPrior(o,rows,used);
    let event=prior?classifyChange(prior,o):'NEW_OPPORTUNITY';
    const firstSeen=prior?.first_seen_at||now;
    // If an older key matched, retire it before writing the stable key. This avoids a shifted start becoming cancel+new.
    if(prior&&prior.opportunity_key!==o.key){
      used.add(prior.opportunity_key);
      await env.DB.prepare("UPDATE tbl_opportunities SET status='superseded',last_seen_at=? WHERE opportunity_key=?").bind(now,prior.opportunity_key).run();
    } else if(prior) used.add(prior.opportunity_key);
    surviving.add(o.key);
    await env.DB.prepare(`INSERT INTO tbl_opportunities (opportunity_key,site_id,activity,starts_at,ends_at,score,status,details_json,first_seen_at,last_seen_at)
      VALUES (?,?,?,?,?,?,'candidate',?,?,?)
      ON CONFLICT(opportunity_key) DO UPDATE SET starts_at=excluded.starts_at,ends_at=excluded.ends_at,score=excluded.score,status='candidate',details_json=excluded.details_json,last_seen_at=excluded.last_seen_at`)
      .bind(o.key,o.site_id,o.activity,o.starts_at,o.ends_at,o.score,JSON.stringify(o.details),firstSeen,now).run();
    if(event){
      await eventRow(env,o.key,event,{...o,previous:prior?{key:prior.opportunity_key,starts_at:prior.starts_at,ends_at:prior.ends_at,score:prior.score,details:parseDetails(prior)}:null});
      changes++;
    }
  }
  for(const prior of rows){
    if(used.has(prior.opportunity_key)||surviving.has(prior.opportunity_key))continue;
    // A still-future previously qualifying window has disappeared entirely: cancellation, not mere deterioration.
    await env.DB.prepare("UPDATE tbl_opportunities SET status='cancelled',last_seen_at=? WHERE opportunity_key=?").bind(now,prior.opportunity_key).run();
    if(isStableOpportunityKey(prior.opportunity_key)){
      await eventRow(env,prior.opportunity_key,'CANCELLED',{previous:{key:prior.opportunity_key,site_id:prior.site_id,activity:prior.activity,starts_at:prior.starts_at,ends_at:prior.ends_at,score:prior.score,details:parseDetails(prior)},note:'Previously qualifying window no longer has at least two consecutive usable hours.'});
      changes++;
    }
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
function localWindowLabel(start,end){
  if(!start||!end)return 'time unavailable';
  const day=fmt(start,{weekday:'short',day:'numeric',month:'short'});
  const a=fmt(start,{hour:'numeric',minute:'2-digit'});
  const b=fmt(end,{hour:'numeric',minute:'2-digit'});
  return `${day}, ${a}–${b}`;
}
function activityLabel(id){ return id==='kayaking'?'Kayaking':id==='sailing'?'Sailing':id==='fishing'?'Fishing':'Hobie outing'; }
function siteLabel(id){ return SITES.find(s=>s.id===id)?.name || id || 'Carrum'; }
function conditionSummary(d={}){
  const bits=[];
  if(Number.isFinite(Number(d.mean_wind_kn))) bits.push(`wind ~${Number(d.mean_wind_kn).toFixed(1)} kt`);
  if(Number.isFinite(Number(d.peak_gust_kn))) bits.push(`gusts ${Number(d.peak_gust_kn).toFixed(1)} kt`);
  if(Number.isFinite(Number(d.max_wave_m))) bits.push(`waves to ${Number(d.max_wave_m).toFixed(2)} m`);
  return bits.join(', ');
}
function tideSummary(d={}){
  const t=d.tide_reference;
  if(!t||t.status!=='verified_reference') return '';
  const height=Number.isFinite(Number(t.estimated_height_m))?`~${Number(t.estimated_height_m).toFixed(2)} m LAT`:'height unavailable';
  const nextHeight=Number.isFinite(Number(t.next_height_m))?`${Number(t.next_height_m).toFixed(2)} m LAT `:'';
  const next=t.next_type&&t.next_at?`; ${t.next_type} ${nextHeight}at ${fmt(t.next_at,{hour:'numeric',minute:'2-digit'})}`:'';
  return `Williamstown reference tide: ${t.direction||'state unknown'}, ${height}${next}.`;
}
function formatAlert(eventType,payload){
  const current=eventType==='CANCELLED' ? null : payload;
  const previous=payload.previous || null;
  const base=current || previous || payload;
  const site=siteLabel(base.site_id || payload.site_id || previous?.site_id);
  const activity=activityLabel(base.activity || payload.activity || previous?.activity);
  const window=localWindowLabel(base.starts_at,base.ends_at);
  const d=base.details || {};
  const rec=d.recommendation||{};
  const species=rec.best_species||null;

  // Pushover is a lock-screen decision summary. Detailed BOM/tide/advisory
  // evidence remains on the dashboard.
  if(eventType==='CANCELLED'){
    return {
      title:`${activity.toUpperCase()} · CANCELLED`,
      message:`${site} · ${window}\nWindow no longer qualifies. Recheck dashboard before making plans.`,
      priority:0
    };
  }

  const quality=d.classification==='preferred'?'GOOD WINDOW':'MARGINAL WINDOW';
  const wind=Number.isFinite(Number(d.mean_wind_kn))?Number(d.mean_wind_kn).toFixed(1):null;
  const gust=Number.isFinite(Number(d.peak_gust_kn))?Number(d.peak_gust_kn).toFixed(1):null;
  const wave=Number.isFinite(Number(d.max_wave_m))?Number(d.max_wave_m).toFixed(2):null;

  const conditionBits=[];
  if(wind!==null) conditionBits.push(`Wind ${wind}`);
  if(gust!==null) conditionBits.push(`Gust ${gust} kt`);
  if(wave!==null) conditionBits.push(`Waves ${wave} m`);

  const cautionBits=[];
  if((d.bom_cross_check||[]).length) cautionBits.push('BOM rougher');
  if((d.advisories||[]).length) cautionBits.push('local advisory');

  let change='';
  if(eventType==='IMPROVED') change=' · IMPROVED';
  else if(eventType==='DETERIORATING') change=' · DETERIORATING';

  const title=`${activity.toUpperCase()} · ${window.toUpperCase()}${change}`;
  const lines=[`${site} · ${quality}`];

  if(activity==='Fishing'&&species){
    lines.push(`Best target: ${species.name} · ${species.mean_score}/100`);
  }
  if(conditionBits.length) lines.push(conditionBits.join(' · '));

  lines.push(
    cautionBits.length
      ? `${cautionBits.join(' · ')} · Recheck before launch`
      : 'Recheck before launch'
  );

  return {title,message:lines.join('\n').slice(0,1024),priority:0};
}
async function positiveAlertGate(env,row,details){
  if(!isStableOpportunityKey(row.opportunity_key)) return {ok:false,permanent:true,reason:'unstable opportunity key'};
  const candidate=await env.DB.prepare("SELECT * FROM tbl_opportunities WHERE opportunity_key=? AND status='candidate' AND ends_at > ?").bind(row.opportunity_key,stamp()).first();
  if(!candidate) return {ok:false,permanent:true,reason:'opportunity is no longer current'};
  const currentDetails=parseDetails(candidate);

  if(currentDetails.recommendation?.is_best_activity!==true){
    return {
      ok:false,
      permanent:true,
      reason:'another activity is the better recommendation for this outing'
    };
  }

  const forecastAt=Date.parse(currentDetails.forecast_checked_at||'');
  if(!Number.isFinite(forecastAt)||Date.now()-forecastAt>FORECAST_MAX_AGE_MS) return {ok:false,permanent:false,reason:'numerical forecast is stale'};
  const official=await readOfficialMarineSnapshot(env);
  if(official.stale || official.status!=='verified_no_port_phillip_warning' || official.warning?.port_phillip_warning_active || official.positive_alert_gate!=='warning_check_passed'){
    return {ok:false,permanent:false,reason:'official BOM positive-alert gate is blocked'};
  }
  const at=currentDetails.best_departure||candidate.starts_at;
  const assessment=await currentLaunchAssessment(env,candidate.site_id,candidate.activity,at);
  if(!assessment || !['preferred','marginal'].includes(assessment.status) || (assessment.blockers||[]).length){
    return {ok:false,permanent:false,reason:'current launch assessment is blocked or incomplete'};
  }
  return {ok:true,candidate:{key:candidate.opportunity_key,site_id:candidate.site_id,activity:candidate.activity,starts_at:candidate.starts_at,ends_at:candidate.ends_at,score:candidate.score,details:currentDetails},assessment};
}
const ALERT_ACTIVATION_EVENT_ID = 56;
const NEGATIVE_ALERT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DELIVERY_CLAIM_MAX_AGE_MS = 15 * 60 * 1000;

function eventAgeMs(row){
  const t=Date.parse(row.created_at||'');
  return Number.isFinite(t) ? Date.now()-t : Infinity;
}
async function newestPendingEventIds(env){
  const rows=await env.DB.prepare(`SELECT opportunity_key, MAX(id) AS newest_id FROM tbl_alert_events
    WHERE delivery_status='pending' AND event_type IN ('NEW_OPPORTUNITY','IMPROVED','DETERIORATING','CANCELLED')
    GROUP BY opportunity_key`).all();
  return new Map((rows.results||[]).map(r=>[r.opportunity_key,Number(r.newest_id)]));
}
function queueGate(row,newestByKey){
  if(!isStableOpportunityKey(row.opportunity_key)) return {ok:false,permanent:true,status:'suppressed_legacy',reason:'unstable or legacy opportunity key'};
  if(Number(row.id)<=ALERT_ACTIVATION_EVENT_ID) return {ok:false,permanent:true,status:'suppressed_activation_backlog',reason:`predates notification activation boundary (event ${ALERT_ACTIVATION_EVENT_ID})`};
  if(newestByKey.get(row.opportunity_key)!==Number(row.id)) return {ok:false,permanent:true,status:'suppressed_superseded',reason:'a newer pending event exists for this opportunity'};
  if((row.event_type==='DETERIORATING'||row.event_type==='CANCELLED') && eventAgeMs(row)>NEGATIVE_ALERT_MAX_AGE_MS){
    return {ok:false,permanent:true,status:'suppressed_stale',reason:'negative event is older than 6 hours'};
  }
  return {ok:true,permanent:false,status:null,reason:null};
}
async function expireAbandonedDeliveryClaims(env) {
  const cutoff = new Date(Date.now() - DELIVERY_CLAIM_MAX_AGE_MS).toISOString();

  const result = await env.DB.prepare(`
    UPDATE tbl_alert_events
    SET delivery_status='delivery_unknown',
        delivery_error='Delivery claim expired before a confirmed result; not automatically resent.'
    WHERE delivery_status='sending'
      AND (
        delivery_claimed_at IS NULL
        OR datetime(delivery_claimed_at) < datetime(?)
      )
  `).bind(cutoff).run();

  return Number(result?.meta?.changes || 0);
}

async function deliverPendingAlerts(env) {
  if (env.ALERTS_ENABLED !== 'true') return { sent: 0, note: 'Alerts disabled' };

  // A stranded sending row is deliberately NOT returned to pending.
  // Once Pushover may have been contacted, automatic retry could duplicate an alert.
  const deliveryUnknown = await expireAbandonedDeliveryClaims(env);

  const rows = await env.DB.prepare(`
    SELECT id, opportunity_key, event_type, created_at, details_json
    FROM tbl_alert_events
    WHERE delivery_status='pending'
      AND event_type IN ('NEW_OPPORTUNITY','IMPROVED','DETERIORATING','CANCELLED')
    ORDER BY id ASC
    LIMIT 50
  `).all();

  const newestByKey = await newestPendingEventIds(env);
  let sent = 0, deferred = 0, suppressed = 0, claimedElsewhere = 0, failed = 0;

  for (const row of rows.results || []) {
    const q = queueGate(row, newestByKey);

    if (!q.ok) {
      await env.DB.prepare(`
        UPDATE tbl_alert_events
        SET delivery_status=?,
            delivery_error=?
        WHERE id=? AND delivery_status='pending'
      `).bind(q.status, q.reason || null, row.id).run();

      suppressed++;
      continue;
    }

    let details;
    try {
      details = JSON.parse(row.details_json || '{}');
    } catch {
      details = {};
    }

    let payload = details;

    if (row.event_type === 'NEW_OPPORTUNITY' || row.event_type === 'IMPROVED') {
      const gate = await positiveAlertGate(env, row, details);

      if (!gate.ok) {
        if (gate.permanent) {
          const suppressionStatus =
            gate.reason === 'opportunity is no longer current'
              ? 'suppressed_obsolete'
              : 'suppressed_stale';

          await env.DB.prepare(`
            UPDATE tbl_alert_events
            SET delivery_status=?,
                delivery_error=?
            WHERE id=? AND delivery_status='pending'
          `).bind(suppressionStatus, gate.reason || null, row.id).run();

          suppressed++;
        } else {
          deferred++;
        }

        continue;
      }

      payload = { ...gate.candidate, previous: details.previous || null };
    }

    const claimedAt = stamp();

    // Atomic pending -> sending claim. Only the invocation that changes one row
    // is permitted to contact Pushover.
    const claim = await env.DB.prepare(`
      UPDATE tbl_alert_events
      SET delivery_status='sending',
          delivery_claimed_at=?,
          delivery_error=NULL,
          pushover_request_id=NULL
      WHERE id=? AND delivery_status='pending'
    `).bind(claimedAt, row.id).run();

    const claimed = Number(claim?.meta?.changes || 0) === 1;

    if (!claimed) {
      claimedElsewhere++;
      continue;
    }

    const formatted = formatAlert(row.event_type, payload);

    try {
      const result = await sendPushover(env, formatted);

      await env.DB.prepare(`
        UPDATE tbl_alert_events
        SET delivery_status='sent',
            delivery_error=NULL,
            pushover_request_id=?
        WHERE id=? AND delivery_status='sending'
      `).bind(result?.request || null, row.id).run();

      sent++;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);

      // Do not automatically retry after Pushover may have been contacted.
      // A timeout/network error can occur after the remote service accepted
      // the message, so pending would create a duplicate-delivery risk.
      await env.DB.prepare(`
        UPDATE tbl_alert_events
        SET delivery_status='delivery_unknown',
            delivery_error=?
        WHERE id=? AND delivery_status='sending'
      `).bind(error.slice(0, 1000), row.id).run();

      failed++;

      console.error('Pushover delivery outcome unknown', {
        alert_event_id: row.id,
        opportunity_key: row.opportunity_key,
        event_type: row.event_type,
        error
      });
    }
  }

  return {
    sent,
    deferred,
    suppressed,
    claimed_elsewhere: claimedElsewhere,
    failed,
    delivery_unknown_from_expired_claims: deliveryUnknown
  };
}
async function previewPendingAlerts(env){
  const rows=await env.DB.prepare(`SELECT id,opportunity_key,event_type,created_at,delivery_status,details_json FROM tbl_alert_events
    WHERE delivery_status='pending' AND event_type IN ('NEW_OPPORTUNITY','IMPROVED','DETERIORATING','CANCELLED') ORDER BY id ASC LIMIT 100`).all();
  const newestByKey=await newestPendingEventIds(env);
  const out=[];
  for(const row of rows.results||[]){
    let details; try{details=JSON.parse(row.details_json||'{}')}catch{details={}};
    const q=queueGate(row,newestByKey);
    let gate=q, payload=details;
    if(q.ok && (row.event_type==='NEW_OPPORTUNITY'||row.event_type==='IMPROVED')){
      gate=await positiveAlertGate(env,row,details);
      if(gate.ok) payload={...gate.candidate,previous:details.previous||null};
    } else if(q.ok) {
      gate={ok:true,permanent:false,reason:'negative event is current and within the 6-hour delivery window'};
    }
    out.push({
      id:row.id,opportunity_key:row.opportunity_key,event_type:row.event_type,created_at:row.created_at,delivery_status:row.delivery_status,
      queue_action:!q.ok
  ? q.status
  : gate.ok
    ? 'eligible'
    : gate.permanent
      ? 'suppressed_obsolete'
      : 'deferred',
      gate:{ok:gate.ok,permanent:!!gate.permanent,reason:gate.reason||null},
      formatted:formatAlert(row.event_type,payload)
    });
  }
  return out;
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

function forecastPointForSite(row, site, at=new Date().toISOString()) {
  if (!row) return null;
  const weather=JSON.parse(row.weather_json||'[]');
  const marine=JSON.parse(row.marine_json||'{}');
  const w=weather.find(x=>x.site===site)?.data?.hourly;
  const mh=marine?.hourly;
  if(!w?.time?.length || !mh?.time?.length) return null;
  const target=Date.parse(at);
  let wi=0,best=Infinity;
  w.time.forEach((t,i)=>{const d=Math.abs(Date.parse(t+'Z')-target);if(d<best){best=d;wi=i}});
  const mt=w.time[wi], mi=mh.time.indexOf(mt);
  return {time:mt+'Z',wind:w.wind_speed_10m?.[wi]??null,gust:w.wind_gusts_10m?.[wi]??null,direction:w.wind_direction_10m?.[wi]??null,precipitation:w.precipitation?.[wi]??null,weather_code:w.weather_code?.[wi]??null,is_day:w.is_day?.[wi]===1,wave_m:mi>=0?(mh.wave_height?.[mi]??null):null};
}
async function currentLaunchAssessment(env, site='carrum-foreshore', activity='fishing', at=new Date().toISOString()) {
  const tideStart=new Date(Date.parse(at)-12*3600000).toISOString();
  const tideEnd=new Date(Date.parse(at)+12*3600000).toISOString();
  const [official,notices,row,tides]=await Promise.all([
    readOfficialMarineSnapshot(env), readLocalNotices(env,site),
    env.DB.prepare("SELECT checked_at,weather_json,marine_json FROM tbl_forecast_runs WHERE status='ok' ORDER BY id DESC LIMIT 1").first(),
    readVerifiedTides(env,tideStart,tideEnd)
  ]);
  const point=forecastPointForSite(row,site,at);
  const tide=verifiedTideContext(at,tides);
  return assessLaunch({site,activity,official,notices,point,forecastCheckedAt:row?.checked_at,at,tide});
}


function recommendationWinners(opportunities){const out=new Map();for(const o of opportunities)if(o.details?.recommendation?.is_best_outing===true)out.set(localDateKey(o.starts_at),o);return out;}
function recommendationSnapshot(o){const r=o.details?.recommendation||{};return {local_date:localDateKey(o.starts_at),site_id:o.site_id,activity:o.activity,starts_at:o.starts_at,ends_at:o.ends_at,classification:o.details?.classification||'marginal',score:o.score,mean_wind_kn:o.details?.mean_wind_kn,peak_gust_kn:o.details?.peak_gust_kn,max_wave_m:o.details?.max_wave_m,best_species:r.best_species||null,confidence:r.confidence||recommendationConfidence(o),comparison:r.comparison||[],reason:r.reason||null};}
function recommendationEventType(prev,next){if(!prev)return 'NEW_RECOMMENDATION';if(prev.activity!==next.activity||prev.site_id!==next.site_id||(prev.best_species?.id||null)!==(next.best_species?.id||null))return 'RECOMMENDATION_CHANGED';if(prev.classification==='marginal'&&next.classification==='preferred')return 'RECOMMENDATION_IMPROVED';if(prev.classification==='preferred'&&next.classification==='marginal')return 'RECOMMENDATION_DETERIORATING';const od=hours(prev.starts_at,prev.ends_at),nd=hours(next.starts_at,next.ends_at),oc=Number(prev.confidence?.score)||0,nc=Number(next.confidence?.score)||0;if(nd>=od+2||nc>=oc+15)return 'RECOMMENDATION_IMPROVED';if(nd<=od-2||nc<=oc-15)return 'RECOMMENDATION_DETERIORATING';return null;}
async function recommendationEventRow(env,date,type,current,previous){await env.DB.prepare(`INSERT INTO tbl_recommendation_events (local_date,event_type,created_at,details_json,delivery_status) VALUES (?,?,?,?, 'pending')`).bind(date,type,stamp(),JSON.stringify({current,previous})).run();}
async function storeRecommendationState(env,opportunities){
 const winners=recommendationWinners(opportunities),now=stamp(),count=await env.DB.prepare("SELECT COUNT(*) AS n FROM tbl_recommendations").first(),bootstrap=Number(count?.n||0)===0;
 const active=await env.DB.prepare("SELECT * FROM tbl_recommendations WHERE status='active'").all(),prior=new Map((active.results||[]).map(r=>[r.local_date,r]));let events=0;
 for(const [date,o] of winners){const next=recommendationSnapshot(o),row=prior.get(date);let prev=null;if(row){try{prev=JSON.parse(row.details_json||'{}')}catch{}}const type=bootstrap?null:recommendationEventType(prev,next);await env.DB.prepare(`INSERT INTO tbl_recommendations (local_date,site_id,activity,starts_at,ends_at,status,details_json,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,'active',?,?,?) ON CONFLICT(local_date) DO UPDATE SET site_id=excluded.site_id,activity=excluded.activity,starts_at=excluded.starts_at,ends_at=excluded.ends_at,status='active',details_json=excluded.details_json,last_seen_at=excluded.last_seen_at`).bind(date,next.site_id,next.activity,next.starts_at,next.ends_at,JSON.stringify(next),row?.first_seen_at||now,now).run();if(type){await recommendationEventRow(env,date,type,next,prev);events++;}prior.delete(date);}
 for(const [date,row] of prior){if(Date.parse(row.ends_at)<=Date.now())continue;let prev={};try{prev=JSON.parse(row.details_json||'{}')}catch{}await env.DB.prepare("UPDATE tbl_recommendations SET status='cancelled',last_seen_at=? WHERE local_date=?").bind(now,date).run();if(!bootstrap){await recommendationEventRow(env,date,'RECOMMENDATION_CANCELLED',null,prev);events++;}}
 return {events,bootstrapped:bootstrap};
}
function formatRecommendationAlert(type,details){const x=details.current||details.previous||{},activity=activityLabel(x.activity).toUpperCase(),window=localWindowLabel(x.starts_at,x.ends_at);let suffix='';if(type==='RECOMMENDATION_CHANGED')suffix=' · CHANGED';else if(type==='RECOMMENDATION_IMPROVED')suffix=' · IMPROVED';else if(type==='RECOMMENDATION_DETERIORATING')suffix=' · DETERIORATING';else if(type==='RECOMMENDATION_CANCELLED')suffix=' · CANCELLED';if(type==='RECOMMENDATION_CANCELLED')return {title:`${activity}${suffix}`,message:`${siteLabel(x.site_id)} · ${window}\nWindow no longer qualifies. Recheck dashboard before making plans.`,priority:0};const quality=x.classification==='preferred'?'GOOD WINDOW':'MARGINAL WINDOW',lines=[`${siteLabel(x.site_id)} · ${quality}`];if(x.activity==='fishing'&&x.best_species)lines.push(`Best target: ${x.best_species.name} · ${x.best_species.mean_score}/100`);const bits=[];if(Number.isFinite(Number(x.mean_wind_kn)))bits.push(`Wind ${Number(x.mean_wind_kn).toFixed(1)}`);if(Number.isFinite(Number(x.peak_gust_kn)))bits.push(`Gust ${Number(x.peak_gust_kn).toFixed(1)} kt`);if(Number.isFinite(Number(x.max_wave_m)))bits.push(`Waves ${Number(x.max_wave_m).toFixed(2)} m`);if(bits.length)lines.push(bits.join(' · '));lines.push(`${x.confidence?.level||'UNKNOWN'} confidence · Recheck before launch`);return {title:`${activity} · ${window.toUpperCase()}${suffix}`,message:lines.join('\n'),priority:0};}
function recommendationTransitionTest(type,base){
  const current={...base,confidence:{...(base.confidence||{})}};
  const previous={...base,confidence:{...(base.confidence||{})}};
  if(type==='RECOMMENDATION_CHANGED'){
    previous.activity=current.activity==='sailing'?'kayaking':'sailing';
    previous.best_species=null;
  }else if(type==='RECOMMENDATION_IMPROVED'){
    previous.classification='marginal';
    current.classification='preferred';
    previous.confidence={...(previous.confidence||{}),score:Math.max(0,(Number(current.confidence?.score)||75)-20),level:'LOW'};
  }else if(type==='RECOMMENDATION_DETERIORATING'){
    previous.classification='preferred';
    current.classification='marginal';
    current.confidence={...(current.confidence||{}),score:Math.min(Number(current.confidence?.score)||55,55),level:'LOW'};
  }else if(type==='RECOMMENDATION_CANCELLED'){
    return {current:null,previous};
  }
  return {current,previous};
}
async function recommendationPositiveGate(env,row,details){const x=details.current;if(!x)return {ok:false,permanent:true,reason:'missing current recommendation'};const state=await env.DB.prepare("SELECT status,details_json FROM tbl_recommendations WHERE local_date=?").bind(row.local_date).first();if(!state||state.status!=='active')return {ok:false,permanent:true,reason:'recommendation is no longer active'};let latest={};try{latest=JSON.parse(state.details_json||'{}')}catch{}if(latest.activity!==x.activity||latest.site_id!==x.site_id||latest.starts_at!==x.starts_at)return {ok:false,permanent:true,reason:'recommendation has been superseded'};const official=await readOfficialMarineSnapshot(env);if(official.stale||official.status!=='verified_no_port_phillip_warning'||official.warning?.port_phillip_warning_active||official.positive_alert_gate!=='warning_check_passed')return {ok:false,permanent:false,reason:'official BOM positive-alert gate is blocked'};const assessment=await currentLaunchAssessment(env,x.site_id,x.activity,x.starts_at);if(!assessment||!['preferred','marginal'].includes(assessment.status)||(assessment.blockers||[]).length)return {ok:false,permanent:false,reason:'current launch assessment is blocked or incomplete'};return {ok:true};}
async function deliverRecommendationAlerts(env){if(env.ALERTS_ENABLED!=='true')return {sent:0,note:'Alerts disabled'};const rows=await env.DB.prepare(`SELECT id,local_date,event_type,created_at,details_json FROM tbl_recommendation_events WHERE delivery_status='pending' ORDER BY id ASC LIMIT 30`).all(),newestRows=await env.DB.prepare(`SELECT local_date,MAX(id) newest_id FROM tbl_recommendation_events WHERE delivery_status='pending' GROUP BY local_date`).all(),newest=new Map((newestRows.results||[]).map(r=>[r.local_date,Number(r.newest_id)]));let sent=0,deferred=0,suppressed=0,failed=0;for(const row of rows.results||[]){if(newest.get(row.local_date)!==Number(row.id)){await env.DB.prepare("UPDATE tbl_recommendation_events SET delivery_status='suppressed_superseded',delivery_error=? WHERE id=? AND delivery_status='pending'").bind('newer recommendation event exists',row.id).run();suppressed++;continue;}let details={};try{details=JSON.parse(row.details_json||'{}')}catch{}const positive=['NEW_RECOMMENDATION','RECOMMENDATION_CHANGED','RECOMMENDATION_IMPROVED'].includes(row.event_type);if(positive){const gate=await recommendationPositiveGate(env,row,details);if(!gate.ok){if(gate.permanent){await env.DB.prepare("UPDATE tbl_recommendation_events SET delivery_status='suppressed',delivery_error=? WHERE id=? AND delivery_status='pending'").bind(gate.reason,row.id).run();suppressed++;}else deferred++;continue;}}const claim=await env.DB.prepare("UPDATE tbl_recommendation_events SET delivery_status='sending',delivery_claimed_at=? WHERE id=? AND delivery_status='pending'").bind(stamp(),row.id).run();if(Number(claim?.meta?.changes||0)!==1)continue;const msg=formatRecommendationAlert(row.event_type,details),base=env.DASHBOARD_URL||'https://kayaking-conditions.delicate-meadow-3eb1.workers.dev/dashboard';msg.url=`${base}?date=${encodeURIComponent(row.local_date)}`;try{const result=await sendPushover(env,msg);await env.DB.prepare("UPDATE tbl_recommendation_events SET delivery_status='sent',delivery_request_id=?,delivered_at=? WHERE id=?").bind(result.request||null,stamp(),row.id).run();sent++;}catch(e){await env.DB.prepare("UPDATE tbl_recommendation_events SET delivery_status='delivery_unknown',delivery_error=? WHERE id=?").bind(String(e),row.id).run();failed++;}}return {sent,deferred,suppressed,failed};}

async function run(env) {
  try {
    const official = await readOfficialMarineSnapshot(env);
    const tideStart=new Date(Date.now()-12*3600000).toISOString();
    const tideEnd=new Date(Date.now()+84*3600000).toISOString();
    const [carrumNotices,pattersonNotices,data,tides] = await Promise.all([
      readLocalNotices(env,'carrum-foreshore'),
      readLocalNotices(env,'patterson-river'),
      collect(),
      readVerifiedTides(env,tideStart,tideEnd)
    ]);
    const opportunities = buildOpportunities(data,official,{
      'carrum-foreshore':carrumNotices,
      'patterson-river':pattersonNotices
    },tides,data.checkedAt);
    const changes = await store(env,data,opportunities);
    const recommendation = await storeRecommendationState(env,opportunities);
    const delivery = await deliverRecommendationAlerts(env);
    return { checked_at:stamp(), candidates:opportunities.length, change_events:changes, recommendation_events:recommendation.events, recommendation_bootstrapped:recommendation.bootstrapped, delivery, official_marine:official, safety_verified:false, note:'Pushover is driven by date-level recommendation state. Underlying opportunity events remain stored for environmental history. Missing or stale BOM data blocks positive alerts; launch conditions still require on-arrival verification.' };
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
      if (u.pathname === '/api/opportunity-preview' && request.method === 'GET') {
        const official=await readOfficialMarineSnapshot(env);
        const tideStart=new Date(Date.now()-12*3600000).toISOString();
        const tideEnd=new Date(Date.now()+84*3600000).toISOString();
        const [carrumNotices,pattersonNotices,row,tides]=await Promise.all([
          readLocalNotices(env,'carrum-foreshore'),readLocalNotices(env,'patterson-river'),
          env.DB.prepare("SELECT checked_at,weather_json,marine_json FROM tbl_forecast_runs WHERE status='ok' ORDER BY id DESC LIMIT 1").first(),
          readVerifiedTides(env,tideStart,tideEnd)
        ]);
        if(!row) return json({error:'No stored forecast'},404);
        const data={weather:JSON.parse(row.weather_json),marine:JSON.parse(row.marine_json),checkedAt:row.checked_at};
        const windows=buildOpportunities(data,official,{'carrum-foreshore':carrumNotices,'patterson-river':pattersonNotices},tides,row.checked_at);
        const forecastAgeMinutes=Math.max(0,Math.round((Date.now()-Date.parse(row.checked_at))/60000));
        return json({
          checked_at:row.checked_at,
          forecast_age_minutes:Number.isFinite(forecastAgeMinutes)?forecastAgeMinutes:null,
          forecast_stale:!Number.isFinite(Date.parse(row.checked_at))||Date.now()-Date.parse(row.checked_at)>FORECAST_MAX_AGE_MS,
          horizon_hours:72,min_window_hours:2,return_buffer_minutes:RETURN_BUFFER_MINUTES,
          availability:'Weekends daylight; Wed/Fri after 16:00; Mon/Tue/Thu after 17:00 Melbourne time',
          alerts_enabled:env.ALERTS_ENABLED==='true',
          event_matching:'stable by site + activity + Melbourne local date; >=2h/10pt hysteresis',
          windows
        });
      }
      if (u.pathname === '/api/recommendations' && request.method === 'GET') {
        const rows=await env.DB.prepare("SELECT local_date,site_id,activity,starts_at,ends_at,status,details_json,last_seen_at FROM tbl_recommendations WHERE status='active' AND ends_at > ? ORDER BY starts_at ASC LIMIT 14").bind(stamp()).all();
        return json({recommendations:(rows.results||[]).map(r=>{let details={};try{details=JSON.parse(r.details_json||'{}')}catch{}return {...r,details,details_json:undefined};}),safety_verified:false});
      }
      if (u.pathname === '/api/opportunities') {
        const rows = await env.DB.prepare("SELECT * FROM tbl_opportunities WHERE status='candidate' AND ends_at > ? ORDER BY starts_at ASC LIMIT 100").bind(stamp()).all();
        return json({ safety_verified:false, opportunities:rows.results.map(x=>({ ...x, details:JSON.parse(x.details_json), details_json:undefined })) });
      }
      if (u.pathname === '/api/launch-assessment' && request.method === 'GET') {
        const site=u.searchParams.get('site')||'carrum-foreshore';
        const activity=u.searchParams.get('activity')||'fishing';
        const at=u.searchParams.get('at')||stamp();
        if (!SITES.some(s=>s.id===site)) return json({error:'Unknown site'},400);
        if (!ACTIVITIES.some(a=>a.id===activity)) return json({error:'Unknown activity'},400);
        if (!Number.isFinite(Date.parse(at))) return json({error:'Invalid at timestamp'},400);
        return json(await currentLaunchAssessment(env,site,activity,at));
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
        const [official,notices]=await Promise.all([readOfficialMarineSnapshot(env),readLocalNotices(env,site)]);
        return json(buildBiteTimeline({weather:JSON.parse(row.weather_json),marine:JSON.parse(row.marine_json),checkedAt:row.checked_at,tides:tides.results,site,launchContext:{official,notices}}));
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
        const [official,notices]=await Promise.all([readOfficialMarineSnapshot(env),readLocalNotices(env,'patterson-river')]);
        return json({ latest_run:row, official_marine_external_ingest:true,official_port_phillip_forecast_integrated:true,local_notices_integrated:true,official_safety_feeds_integrated:official.status==='verified_no_port_phillip_warning'&&notices.status==='no_unresolved_in_recent_listing', notifications_integrated:true, notifications_enabled:env.ALERTS_ENABLED === 'true', positive_alerts_blocked:true });
      }
      if (u.pathname === '/api/alerts/preview' && request.method === 'GET') {
        if (!await auth(request,env)) return json({ error:'Unauthorized' },401);
        return json({ alerts_enabled:env.ALERTS_ENABLED==='true', safety_verified:false, pending:await previewPendingAlerts(env) });
      }
      if (u.pathname === '/api/pushover/test' && request.method === 'POST') {
        if (!await auth(request,env)) return json({ error:'Unauthorized' },401);

        let body={};
        try { body=await request.json(); } catch {}
        const mode=body?.mode||'connection';

        // Preserve the existing dashboard connection test.
        if(mode==='connection'){
          const delivery=await sendPushover(env,{
            title:'Kayaking Conditions Watch — Test',
            message:'Your Carrum Hobie lock-screen notifications are connected. This is a test, not a marine forecast.',
            priority:0
          });
          return json({ok:true,mode,delivery});
        }

        const transitionModes={
          'transition-changed':'RECOMMENDATION_CHANGED',
          'transition-improved':'RECOMMENDATION_IMPROVED',
          'transition-deteriorating':'RECOMMENDATION_DETERIORATING',
          'transition-cancelled':'RECOMMENDATION_CANCELLED'
        };
        if(!['current-best','best-fishing',...Object.keys(transitionModes)].includes(mode)){
          return json({error:'Unknown test mode. Use connection, current-best, best-fishing, transition-changed, transition-improved, transition-deteriorating, or transition-cancelled.'},400);
        }

        // Build a fresh recommendation preview from the latest stored numerical
        // forecast plus current BOM/local-notice/tide state. This does NOT call
        // store(), eventRow(), deliverPendingAlerts(), or mutate dedupe state.
        const official=await readOfficialMarineSnapshot(env);
        const tideStart=new Date(Date.now()-12*3600000).toISOString();
        const tideEnd=new Date(Date.now()+84*3600000).toISOString();
        const [carrumNotices,pattersonNotices,row,tides]=await Promise.all([
          readLocalNotices(env,'carrum-foreshore'),
          readLocalNotices(env,'patterson-river'),
          env.DB.prepare("SELECT checked_at,weather_json,marine_json FROM tbl_forecast_runs WHERE status='ok' ORDER BY id DESC LIMIT 1").first(),
          readVerifiedTides(env,tideStart,tideEnd)
        ]);
        if(!row) return json({error:'No stored forecast available for test'},404);

        const data={
          weather:JSON.parse(row.weather_json),
          marine:JSON.parse(row.marine_json),
          checkedAt:row.checked_at
        };
        const noticesBySite={
          'carrum-foreshore':carrumNotices,
          'patterson-river':pattersonNotices
        };
        const windows=buildOpportunities(data,official,noticesBySite,tides,row.checked_at);
        if(!windows.length) return json({error:'No current qualifying windows available for test'},409);

        let candidate;
        if(mode==='current-best'||transitionModes[mode]){
          candidate=windows
            .filter(o=>o.details?.recommendation?.is_best_activity===true)
            .sort((a,b)=>Date.parse(a.starts_at)-Date.parse(b.starts_at))[0];
        } else {
          candidate=windows
            .filter(o=>o.activity==='fishing')
            .sort((a,b)=>
              recommendationRank(b)-recommendationRank(a) ||
              Date.parse(a.starts_at)-Date.parse(b.starts_at)
            )[0];

          if(candidate){
            const species=bestSpeciesForWindow(candidate,data,tides,official,noticesBySite);
            candidate={
              ...candidate,
              details:{
                ...candidate.details,
                recommendation:{
                  ...(candidate.details?.recommendation||{}),
                  best_activity:'fishing',
                  best_activity_label:'Fishing',
                  best_site_id:candidate.site_id,
                  best_starts_at:candidate.starts_at,
                  best_ends_at:candidate.ends_at,
                  is_best_activity:true,
                  is_best_outing:true,
                  reason:activityRecommendationReason(candidate,candidate.details?.recommendation?.comparison||[]),
                  best_species:species
                }
              }
            };
          }
        }

        if(!candidate) return json({error:`No ${mode} candidate available for test`},409);

        const snapshot=recommendationSnapshot(candidate);
        const eventType=transitionModes[mode]||'NEW_RECOMMENDATION';
        const transition=transitionModes[mode]
          ? recommendationTransitionTest(eventType,snapshot)
          : {current:snapshot,previous:null};
        const formatted=formatRecommendationAlert(eventType,transition);
        const base=env.DASHBOARD_URL||'https://kayaking-conditions.delicate-meadow-3eb1.workers.dev/dashboard';
        const testMessage={
          ...formatted,
          title:`TEST — ${formatted.title}`,
          message:`TEST ONLY — ${formatted.message}`,
          url:`${base}?date=${encodeURIComponent(localDateKey(candidate.starts_at))}`
        };
        const delivery=await sendPushover(env,testMessage);

        return json({
          ok:true,
          mode,
          mutated_event_state:false,
          candidate:{
            site_id:candidate.site_id,
            activity:candidate.activity,
            starts_at:candidate.starts_at,
            ends_at:candidate.ends_at,
            recommendation:candidate.details?.recommendation||null
          },
          formatted:testMessage,
          delivery
        });
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
