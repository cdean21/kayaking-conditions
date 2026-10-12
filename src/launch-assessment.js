// Conservative automated launch checks. These are screening gates, never a declaration that it is safe to launch.
const FORECAST_MAX_AGE_MS = 6 * 3600000;
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const angular = d => ((d % 360) + 360) % 360;
const offshoreSector = deg => {
  if (num(deg) === null) return false;
  const d = angular(deg);
  // Carrum/Patterson River sit on Port Phillip's eastern shore. Winds FROM E/NE/SE have an offshore component.
  return d >= 45 && d <= 135;
};

export function assessLaunch({site='carrum-foreshore', activity='fishing', official, notices, point, forecastCheckedAt, at}) {
  const blockers=[];
  const cautions=[];
  const passed=[];
  const missing=[];

  if (!official || official.stale || official.status === 'missing' || official.status === 'invalid') missing.push('Fresh validated BOM marine status');
  else if (official.status === 'warning_active' || official.positive_alert_gate === 'blocked') blockers.push('BOM marine warning gate is blocked');
  else if (official.status === 'verified_no_port_phillip_warning') passed.push('No current Port Phillip warning in validated BOM snapshot');
  else missing.push('Verified Port Phillip warning state');

  if (!notices || ['unavailable','stale'].includes(notices.status)) missing.push('Fresh Parks Victoria local notice check');
  else if (notices.status === 'review_required' || (notices.unresolved_count || 0) > 0) blockers.push('Local navigation notice requires review');
  else if (notices.status === 'no_unresolved_in_recent_listing') passed.push('No unresolved local notice found in recent Parks Victoria listing');
  else missing.push('Resolved local notice state');

  const forecastAge = Number.isFinite(Date.parse(forecastCheckedAt)) ? Date.now()-Date.parse(forecastCheckedAt) : Infinity;
  if (forecastAge > FORECAST_MAX_AGE_MS) missing.push('Fresh local forecast');
  if (!point) missing.push('Forecast hour');
  else {
    const wind=num(point.wind), gust=num(point.gust), wave=num(point.wave_m), direction=num(point.direction);
    if (wind===null || gust===null || wave===null) missing.push('Wind, gust and wave forecast values');
    else {
      const limits = activity==='sailing' ? {windMin:8,windMax:20,gust:24,wave:.7} : activity==='kayaking' ? {windMin:0,windMax:12,gust:16,wave:.4} : {windMin:0,windMax:10,gust:16,wave:.4};
      if (wind > limits.windMax) blockers.push(`Sustained wind ${wind.toFixed(1)} kn exceeds ${limits.windMax} kn ${activity} preference`);
      else if (wind < limits.windMin) cautions.push(`Sustained wind ${wind.toFixed(1)} kn is below ${limits.windMin} kn sailing preference`);
      else passed.push(`Sustained wind ${wind.toFixed(1)} kn within ${activity} preference`);
      if (gust > limits.gust) blockers.push(`Gusts ${gust.toFixed(1)} kn exceed provisional ${limits.gust} kn limit`); else passed.push(`Gusts ${gust.toFixed(1)} kn within provisional limit`);
      if (wave > limits.wave) blockers.push(`Modelled waves ${wave.toFixed(2)} m exceed provisional ${limits.wave.toFixed(1)} m limit`); else passed.push(`Modelled waves ${wave.toFixed(2)} m within provisional limit`);
      if (offshoreSector(direction) && wind >= 12) blockers.push(`Strong offshore-component wind (${Math.round(direction)}° at ${wind.toFixed(1)} kn)`);
      else if (offshoreSector(direction) && wind >= 8) cautions.push(`Offshore-component wind (${Math.round(direction)}° at ${wind.toFixed(1)} kn)`);
    }
    if ([95,96,99].includes(point.weather_code)) blockers.push('Thunderstorm weather code forecast');
    if ((num(point.precipitation) ?? 0) >= 2) cautions.push('Heavy precipitation forecast');
    if (point.is_day === false) blockers.push('Outside daylight');
  }

  const physicalCheck = site==='patterson-river'
    ? 'Verify Patterson River entrance, breaking waves, current and actual depth on arrival.'
    : 'Verify Carrum shore break, surf, wind and beach launch conditions on arrival.';
  cautions.push(physicalCheck);

  const status = missing.length ? 'incomplete' : blockers.length ? 'blocked' : cautions.length > 1 ? 'caution' : 'passed';
  const labels = {
    incomplete:'Launch checks incomplete',
    blocked:'Automated launch checks failed',
    caution:'Automated checks pass with cautions',
    passed:'Automated launch checks passed'
  };
  return {
    site, activity, at:at || point?.time || null, status, label:labels[status], automated_checks_passed:status==='passed'||status==='caution',
    launch_verified:false, blockers, cautions, passed, missing,
    note:'Automated screening only — not a declaration that conditions are safe. Verify actual conditions at the launch site and on the water.'
  };
}
