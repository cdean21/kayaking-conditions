import * as SunCalc from 'suncalc';
const LAT=-38.077, LON=145.121;
const zone='Australia/Melbourne';
const format = d => d instanceof Date && Number.isFinite(d.getTime()) ? { utc:d.toISOString(), melbourne:new Intl.DateTimeFormat('en-AU',{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(d) } : null;
const localDate = iso => { const p=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso)); const get=t=>p.find(x=>x.type===t).value; return `${get('year')}-${get('month')}-${get('day')}`; };
export function lunarDetails(iso) {
  const date=new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp');
  // Anchor to Melbourne local midday; use UTC search days and retain only Melbourne-local events.
  const day=localDate(iso);
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,timeZoneName:'shortOffset'}).formatToParts(date);
  const tz=parts.find(p=>p.type==='timeZoneName')?.value || 'GMT+11';
  const m=tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  const offset=m ? (m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3]||0)) : 660;
  const noon=new Date(`${day}T12:00:00Z`);
  const localNoon=new Date(noon.getTime()-offset*60000);
  const moon=SunCalc.getMoonIllumination(date);
  const times=SunCalc.getMoonTimes(localNoon,LAT,LON,offset);
  const sun=SunCalc.getTimes(localNoon,LAT,LON,0,offset);
  const names=['New moon','Waxing crescent','First quarter','Waxing gibbous','Full moon','Waning gibbous','Last quarter','Waning crescent'];
  return { phase:names[Math.round(moon.phase*8)%8], illumination_percent:Math.round(moon.fraction*100), local_day:day, location:'Carrum, Victoria', timezone:zone, moonrise:format(times.rise), moonset:format(times.set), overhead:format(times.transit), underfoot:format(times.lowerTransit), sunrise:format(sun.sunrise), sunset:format(sun.sunset), calculation:'SunCalc astronomical approximation; not a fishing success guarantee' };
}
