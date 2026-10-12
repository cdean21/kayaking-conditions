import { temperatureSignal } from './fishing-enrichment.js';
// Provisional species suitability model, NOT a prediction of catch probability.
// Lunar phase uses a known reference new moon and mean synodic month; transit,
// moonrise and moonset require a separate ephemeris and are not fabricated here.
const SYNODIC_DAYS = 29.530588853;
const NEW_MOON_REFERENCE = Date.parse('2000-01-06T18:14:00Z');
export const SPECIES = [
  { id:'flathead', name:'Flathead', rank:1, type:'table', peakMonths:[11,12,1,2,3], methods:['drifting','soft plastics','bait fishing'], habitat:'Sandy bottom, channels and drop-offs' },
  { id:'calamari', name:'Southern calamari', rank:2, type:'table', peakMonths:[4,5,6,7,8,9,10], methods:['squid jigs'], habitat:'Seagrass edges and clear water' },
  { id:'snapper', name:'Snapper / pinkies', rank:3, type:'table', peakMonths:[10,11,12,1,2], methods:['bait fishing','soft plastics'], habitat:'Reef, rubble and deeper structure' },
  { id:'whiting', name:'King George whiting', rank:4, type:'table', peakMonths:[11,12,1,2,3,4], methods:['bait fishing'], habitat:'Sand and seagrass boundaries' },
  { id:'salmon', name:'Australian salmon', rank:1, type:'sport', peakMonths:[4,5,6,7,8,9], methods:['soft plastics','surface lures','trolling'], habitat:'Moving bait schools and current edges' }
];
export function moonPhase(iso) {
  const elapsed = (Date.parse(iso) - NEW_MOON_REFERENCE) / 86400000;
  const ageDays = ((elapsed % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;
  const illumination = (1 - Math.cos(2*Math.PI*ageDays/SYNODIC_DAYS))/2;
  const names = ['New moon','Waxing crescent','First quarter','Waxing gibbous','Full moon','Waning gibbous','Last quarter','Waning crescent'];
  const phase = names[Math.floor((ageDays/SYNODIC_DAYS*8)+0.5)%8];
  return { phase, age_days:+ageDays.toFixed(1), illumination_percent:Math.round(illumination*100), calculation:'approximate mean lunar cycle; not a local ephemeris' };
}
const clamp = n => Math.max(0,Math.min(100,Math.round(n)));
function melbourneMonth(iso) {
  return Number(new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Melbourne',month:'numeric'}).format(new Date(iso)));
}
function melbourneHour(iso) {
  return Number(new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Melbourne',hour:'numeric',hourCycle:'h23'}).format(new Date(iso)));
}
export function scoreSpecies(iso, weather, methods=[]) {
  const moon = moonPhase(iso), month = melbourneMonth(iso), hour = melbourneHour(iso);
  const wind = Number(weather?.mean_wind_kn);
  const gust = Number(weather?.peak_gust_kn);
  const wave = Number(weather?.max_wave_m);
  const usableWeather = Number.isFinite(wind)&&Number.isFinite(gust)&&Number.isFinite(wave);
  // The lunar contribution is intentionally small: generic solunar effects are uncertain.
  const lunar = Math.round(5*Math.cos(4*Math.PI*moon.age_days/SYNODIC_DAYS));
  return SPECIES.map(species=>{
    const season = species.peakMonths.includes(month) ? 16 : -7;
    const dawnDusk = (hour>=5 && hour<=8)||(hour>=17 && hour<=20) ? 9 : 0;
    const fishability = usableWeather ? Math.max(-28, 12 - wind*0.8 - Math.max(0,gust-12)*0.9 - wave*14) : 0;
    const temperature = temperatureSignal(species.id, weather?.sea_surface_temp_c);
    const methodMatch = methods.length && species.methods.some(m=>methods.includes(m)) ? 5 : 0;
    const score = clamp(52+season+dawnDusk+fishability+lunar+methodMatch+temperature.adjustment);
    return { species_id:species.id, name:species.name, category:species.type, priority:species.rank,
      score, band:score>=75?'promising':score>=55?'moderate':'low',
      signals:{seasonal_adjustment:season,light_adjustment:dawnDusk,lunar_adjustment:lunar,weather_adjustment:+fishability.toFixed(1),method_adjustment:methodMatch,temperature_adjustment:temperature.adjustment,sea_surface_temp_c:weather?.sea_surface_temp_c ?? null},
      habitat:species.habitat, methods:species.methods,
      caveats:['Heuristic suitability, not catch probability','No verified local tides, water clarity or baitfish observations','Sea surface temperature is modelled, not observed',...(usableWeather?[]:['Missing weather data'])] };
  }).sort((a,b)=>a.category===b.category ? b.score-a.score || a.priority-b.priority : a.category==='table'?-1:1);
}
export function fishingOutlook(opportunities, methods=[]) {
  return opportunities.filter(o=>o.activity==='fishing').map(o=>{
    const species = scoreSpecies(o.starts_at,o.details,methods);
    return { opportunity_key:o.key,site_id:o.site_id,starts_at:o.starts_at,ends_at:o.ends_at,
      moon:moonPhase(o.starts_at), table_targets:species.filter(s=>s.category==='table'), sport_targets:species.filter(s=>s.category==='sport'),
      safety_verified:false, suitability_only:true, note:'Modelled conditions only. Official marine warnings, tides and entrance status are not verified.' };
  });
}
