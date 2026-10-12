// Automated launch screening. Preference bands and provisional hard blocks are planning aids, not certified safety limits.
const FORECAST_MAX_AGE_MS=3*3600000;
const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const offshoreSector=deg=>{if(num(deg)===null)return false;const d=((deg%360)+360)%360;return d>=45&&d<=135;};
const PROFILES={
 fishing:{wind:{preferredMax:10,hardMax:15},gust:{preferredMax:15,hardMax:20},wave:{preferredMax:.4,hardMax:.8}},
 kayaking:{wind:{preferredMax:12,hardMax:18},gust:{preferredMax:16,hardMax:22},wave:{preferredMax:.4,hardMax:.8}},
 sailing:{wind:{preferredMin:8,preferredMax:20,hardMax:25},gust:{preferredMax:24,hardMax:30},wave:{preferredMax:.7,hardMax:1.0}}
};
export function assessLaunch({site='carrum-foreshore',activity='fishing',official,notices,point,forecastCheckedAt,at,tide}){
 const blockers=[],cautions=[],passed=[],missing=[],arrival_checks=[];const limits=PROFILES[activity]||PROFILES.fishing;
 if(!official||official.stale||['missing','invalid'].includes(official.status))missing.push('Fresh validated BOM marine status');
 else if(official.status==='warning_active'||official.positive_alert_gate==='blocked')blockers.push('BOM marine warning gate is blocked');
 else if(official.status==='verified_no_port_phillip_warning')passed.push('No current Port Phillip warning in validated BOM snapshot');else missing.push('Verified Port Phillip warning state');
 if(!notices||['unavailable','stale'].includes(notices.status))missing.push('Fresh Parks Victoria local notice check');
 else if(notices.status==='blocking_notice'){const ids=(notices.notices||[]).filter(n=>n.assessment==='blocking').map(n=>n.number);blockers.push(`Local navigation restriction/hazard requires review${ids.length?': '+ids.join(', '):''}`);}
 else if(notices.status==='review_required'){const ids=(notices.notices||[]).filter(n=>n.assessment==='review'||!n.detail_verified).map(n=>n.number);blockers.push(`Local navigation notice requires review${ids.length?': '+ids.join(', '):''} (classification not confirmed)`);}
 else if(notices.status==='caution_notice'){const ids=(notices.notices||[]).filter(n=>n.assessment==='caution').map(n=>n.number);cautions.push(`Local navigation advisory${ids.length?': '+ids.join(', '):''}`);passed.push('No blocking local notice found in recent Parks Victoria listing');}
 else if(notices.status==='no_unresolved_in_recent_listing')passed.push('No unresolved local notice found in recent Parks Victoria listing');else missing.push('Resolved local notice state');
 const age=Number.isFinite(Date.parse(forecastCheckedAt))?Date.now()-Date.parse(forecastCheckedAt):Infinity;if(age>FORECAST_MAX_AGE_MS)missing.push('Fresh local forecast');
 if(!tide||tide.status!=='verified_reference')missing.push('Verified BOM Williamstown tide reference covering this hour');
 else{
  const height=num(tide.estimated_height_m);
  const nextHeight=num(tide.next_height_m);
  const heightText=height===null?'height unavailable':`~${height.toFixed(2)} m LAT`;
  const nextText=tide.next_type&&tide.next_at?`; next ${tide.next_type} ${nextHeight===null?'':`${nextHeight.toFixed(2)} m LAT `}at ${tide.next_at}`:'';
  passed.push(`BOM Williamstown tide reference ${tide.direction||'state unknown'}, ${heightText}${nextText}`);
 }
 if(!point)missing.push('Forecast hour');else{
  const wind=num(point.wind),gust=num(point.gust),wave=num(point.wave_m),direction=num(point.direction);
  if(wind===null||gust===null||wave===null)missing.push('Wind, gust and wave forecast values');else{
   if(activity==='sailing'&&wind<(limits.wind.preferredMin||0))cautions.push(`Sustained wind ${wind.toFixed(1)} kn below preferred sailing range`);
   else if(wind>limits.wind.hardMax)blockers.push(`Sustained wind ${wind.toFixed(1)} kn exceeds provisional ${activity} hard-block threshold`);
   else if(wind>limits.wind.preferredMax)cautions.push(`Sustained wind ${wind.toFixed(1)} kn outside preferred ${activity} range`);else passed.push(`Sustained wind ${wind.toFixed(1)} kn within preferred ${activity} range`);
   if(gust>limits.gust.hardMax)blockers.push(`Gusts ${gust.toFixed(1)} kn exceed provisional ${activity} hard-block threshold`);else if(gust>limits.gust.preferredMax)cautions.push(`Gusts ${gust.toFixed(1)} kn outside preferred ${activity} range`);else passed.push(`Gusts ${gust.toFixed(1)} kn within preferred ${activity} range`);
   if(wave>limits.wave.hardMax)blockers.push(`Modelled waves ${wave.toFixed(2)} m exceed provisional ${activity} hard-block threshold`);else if(wave>limits.wave.preferredMax)cautions.push(`Modelled waves ${wave.toFixed(2)} m outside preferred ${activity} range`);else passed.push(`Modelled waves ${wave.toFixed(2)} m within preferred ${activity} range`);
   if(activity==='fishing'&&wave>=.7&&wave<=.8&&(wind>14||gust>19||(offshoreSector(direction)&&wind>=12)))blockers.push('Compound wind/wave conditions exceed provisional fishing screening threshold');
   if(offshoreSector(direction)&&wind>=15)blockers.push(`Strong offshore-component wind (${Math.round(direction)}° at ${wind.toFixed(1)} kn)`);else if(offshoreSector(direction)&&wind>=8)cautions.push(`Offshore-component wind (${Math.round(direction)}° at ${wind.toFixed(1)} kn)`);
  }
  if([95,96,99].includes(point.weather_code))blockers.push('Thunderstorm weather code forecast');if((num(point.precipitation)??0)>=2)cautions.push('Heavy precipitation forecast');if(point.is_day===false)blockers.push('Outside daylight');
 }
 arrival_checks.push(site==='patterson-river'?'Verify Patterson River entrance, breaking waves, current and actual depth on arrival.':'Verify Carrum shore break, surf, wind and beach launch conditions on arrival.');
 const status=missing.length?'incomplete':blockers.length?'blocked':cautions.length?'marginal':'preferred';
 return {site,activity,at:at||point?.time||null,tide:tide||null,status,label:{incomplete:'Launch checks incomplete',blocked:'Automated launch checks failed',marginal:'Automated checks pass with cautions',preferred:'Automated checks pass in preferred band'}[status],automated_checks_passed:['preferred','marginal'].includes(status),launch_verified:false,blockers,cautions,passed,missing,arrival_checks,thresholds:limits,note:'Automated screening only — preference bands and provisional hard-block thresholds are not declarations that conditions are safe. Verify actual conditions at the launch site and on the water.'};
}
