import { scoreSpecies } from './fishing.js';
import { lunarDetails } from './lunar.js';
import { assessLaunch } from './launch-assessment.js';
const SITES = ['carrum-foreshore','patterson-river'];
const clamp = (n,a=0,b=100) => Math.max(a,Math.min(b,n));
const asIso = s => typeof s==='string' && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
const number = n => typeof n==='number' && Number.isFinite(n) ? n : null;
function normalizeTime(t) { return asIso(/(?:Z|[+-]\d\d:\d\d)$/.test(t) ? t : t+'Z'); }
function findTide(time, tides) {
  const ts=Date.parse(time);
  const sorted=tides.filter(t=>asIso(t.event_at)&&t.reference_station==='Melbourne (Williamstown)').sort((a,b)=>Date.parse(a.event_at)-Date.parse(b.event_at));
  const previous=[...sorted].reverse().find(t=>Date.parse(t.event_at)<=ts);
  const next=sorted.find(t=>Date.parse(t.event_at)>ts);
  const closest=[previous,next].filter(Boolean).sort((a,b)=>Math.abs(Date.parse(a.event_at)-ts)-Math.abs(Date.parse(b.event_at)-ts))[0];
  if (!closest || Math.abs(Date.parse(closest.event_at)-ts)>12*3600000) return null;
  // Rising/falling is a reference-station inference between successive verified extrema.
  const direction=previous&&next&&previous.event_type!==next.event_type&&
    (Date.parse(next.event_at)-Date.parse(previous.event_at))<=12*3600000
    ? (next.event_type==='high'?'rising':'falling') : 'unknown';
  const minutesToNext=next ? Math.max(0,Math.round((Date.parse(next.event_at)-ts)/60000)) : null;
  return { type:closest.event_type, at:closest.event_at, height_m:closest.height_m,
    previous_type:previous?.event_type||null,previous_at:previous?.event_at||null,previous_height_m:previous?.height_m??null,
    next_type:next?.event_type||null,next_at:next?.event_at||null,next_height_m:next?.height_m??null,
    minutes_to_next:minutesToNext,
    direction,hours_from_event:+((ts-Date.parse(closest.event_at))/3600000).toFixed(1),
    station:closest.reference_station, source:closest.source_name, datum:closest.datum,
    verified_reference:true, local_entrance_prediction:false };
}
function clarityEstimate(p) {
  // Wind/wave proxies do not measure turbidity. Don't create a fictitious clarity number.
  const wind=number(p.wind), wave=number(p.wave_m), rain=number(p.precipitation);
  if (wind===null || wave===null || rain===null) return { status:'unknown', measured:false, note:'No measured turbidity or visibility data' };
  const rough = wind>14 || wave>0.6 || rain>=2;
  return { status:rough?'possible_stirring':'not_determined', measured:false, note:rough?'Wind, waves or rain may reduce visibility; actual clarity unknown':'Conditions do not establish actual underwater visibility' };
}
function confidence(p, ageHours, tide, completeness) {
  let score=45;
  if (number(p.wind)!==null && number(p.gust)!==null) score+=12;
  if (number(p.wave_m)!==null) score+=8;
  if (number(p.sea_surface_temp_c)!==null) score+=5;
  if (tide) score+=5;
  if (ageHours>6) score-=12;
  if (ageHours>18) score-=15;
  if (completeness<0.75) score-=15;
  score=clamp(score,0,75); // Unverified official warnings/entrance status cap confidence.
  return { score, level:score>=65?'moderate':score>=45?'low':'very low', label:'Data confidence only; not safety confidence', limitations:['Official marine warnings not automatically verified','Patterson River entrance conditions not verified','No observed water clarity','Coastal model uncertainty'] };
}
export function buildBiteTimeline({weather,marine,checkedAt,tides=[],site='carrum-foreshore',now=new Date().toISOString(),limit=72,launchContext=null}) {
  if(!SITES.includes(site)) throw new Error('Unknown site');
  const weatherItem=Array.isArray(weather)?weather.find(w=>w.site===site):null;
  if (!weatherItem?.data?.hourly || !marine?.hourly) return { site, hours:[], status:'missing_forecast' };
  const wh=weatherItem.data.hourly, mh=marine.hourly;
  const waves=new Map((mh.time||[]).map((t,i)=>[normalizeTime(t),{
    wave_m:number(mh.wave_height?.[i]), wave_period_s:number(mh.wave_period?.[i]),
    sea_surface_temp_c:number(mh.sea_surface_temperature?.[i])
  }]));
  const cutoff=Date.parse(now), ageHours=Math.max(0,(cutoff-Date.parse(checkedAt))/3600000);
  const hours=[];
  for(let i=0;i<(wh.time||[]).length;i++) {
    const time=normalizeTime(wh.time[i]); if (!time) continue;
    const dt=Date.parse(time); if(dt<cutoff-3600000 || dt>cutoff+limit*3600000) continue;
    const marinePoint=waves.get(time)||{};
    const p={ time, wind:number(wh.wind_speed_10m?.[i]),gust:number(wh.wind_gusts_10m?.[i]),
      precipitation:number(wh.precipitation?.[i]), weather_code:wh.weather_code?.[i]??null,
      direction:number(wh.wind_direction_10m?.[i]), is_day:wh.is_day?.[i]===1, ...marinePoint };
    const tide=findTide(time,tides);
    const completeness=[p.wind,p.gust,p.wave_m,p.precipitation,p.sea_surface_temp_c].filter(v=>v!==null&&v!==undefined).length/5;
    const weather={mean_wind_kn:p.wind,peak_gust_kn:p.gust,max_wave_m:p.wave_m,sea_surface_temp_c:p.sea_surface_temp_c};
    const scores=scoreSpecies(time,weather).map(s=>({ id:s.species_id,name:s.name,category:s.category,priority:s.priority,score:s.score,band:s.band,signals:s.signals }));
    const moon=lunarDetails(time);
    const launchAssessment=launchContext?assessLaunch({site,activity:'fishing',official:launchContext.official,notices:launchContext.notices,point:p,forecastCheckedAt:checkedAt,at:time}):null;
    const weatherGate=launchAssessment?.status==='preferred';
    hours.push({time,site,temperature_c:p.sea_surface_temp_c,temperature_source:p.sea_surface_temp_c===null?'unavailable':'Open-Meteo model, not observation',clarity:clarityEstimate(p),
      tide, moon:{phase:moon.phase,illumination_percent:moon.illumination_percent,moonrise:moon.moonrise?.utc||null,moonset:moon.moonset?.utc||null,overhead:moon.overhead?.utc||null,underfoot:moon.underfoot?.utc||null},
      confidence:confidence(p,ageHours,tide,completeness),species:scores,provisional_fishing_weather:weatherGate,
      conditions:{wind_kn:p.wind,gust_kn:p.gust,wave_m:p.wave_m,wind_direction_deg:p.direction,precipitation_mm:p.precipitation,weather_code:p.weather_code,is_day:p.is_day},
      launch_assessment:launchAssessment,
      launch_status:'unverified', warning:'Do not treat a high bite score as launch clearance.' });
  }
  return {site,checked_at:checkedAt,generated_at:now,hours,source:'Stored Open-Meteo weather/marine forecast + approximate SunCalc astronomy + verified BOM Williamstown reference tides if imported',
    status:hours.length?'ok':'no_hours',safety_verified:false,clarity_measured:false,tide_station_is_entrance:false};
}
