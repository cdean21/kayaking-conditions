// Automated launch screening. Preference bands and provisional hard-block thresholds
// are planning aids, not certified safety limits or a declaration that it is safe to launch.
const FORECAST_MAX_AGE_MS = 6 * 3600000;
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const angular = d => ((d % 360) + 360) % 360;
const offshoreSector = deg => {
  if (num(deg) === null) return false;
  const d = angular(deg);
  // Carrum/Patterson River sit on Port Phillip's eastern shore. Winds FROM E/NE/SE have an offshore component.
  return d >= 45 && d <= 135;
};

const PROFILES = {
  fishing: {
    wind: { preferredMax: 10, hardMax: 15 },
    gust: { preferredMax: 15, hardMax: 20 },
    wave: { preferredMax: 0.4, hardMax: 0.8 }
  },
  kayaking: {
    wind: { preferredMax: 12, hardMax: 18 },
    gust: { preferredMax: 16, hardMax: 22 },
    wave: { preferredMax: 0.4, hardMax: 0.7 }
  },
  sailing: {
    wind: { preferredMin: 8, preferredMax: 20, hardMax: 25 },
    gust: { preferredMax: 24, hardMax: 30 },
    wave: { preferredMax: 0.7, hardMax: 1.0 }
  }
};

function assessMetric(value, metric, label, unit, activity, blockers, cautions, passed) {
  const digits = unit === 'm' ? 2 : 1;
  if (value > metric.hardMax) {
    blockers.push(`${label} ${value.toFixed(digits)} ${unit} exceeds provisional ${activity} hard-block threshold`);
  } else if (value > metric.preferredMax) {
    cautions.push(`${label} ${value.toFixed(digits)} ${unit} outside preferred ${activity} range`);
  } else {
    passed.push(`${label} ${value.toFixed(digits)} ${unit} within preferred ${activity} range`);
  }
}

export function assessLaunch({site='carrum-foreshore', activity='fishing', official, notices, point, forecastCheckedAt, at}) {
  const blockers=[];
  const cautions=[];
  const passed=[];
  const missing=[];
  const arrival_checks=[];
  const profile=PROFILES[activity] || PROFILES.fishing;

  if (!official || official.stale || official.status === 'missing' || official.status === 'invalid') missing.push('Fresh validated BOM marine status');
  else if (official.status === 'warning_active' || official.positive_alert_gate === 'blocked') blockers.push('BOM marine warning gate is blocked');
  else if (official.status === 'verified_no_port_phillip_warning') passed.push('No current Port Phillip warning in validated BOM snapshot');
  else missing.push('Verified Port Phillip warning state');

  if (!notices || ['unavailable','stale'].includes(notices.status)) missing.push('Fresh Parks Victoria local notice check');
  else if (notices.status === 'blocking_notice') {
    const ids=(notices.notices || []).filter(n=>n.assessment==='blocking').map(n=>n.number);
    blockers.push(`Local navigation restriction/hazard requires review${ids.length ? ': ' + ids.join(', ') : ''}`);
  } else if (notices.status === 'review_required') {
    const ids=(notices.notices || []).filter(n=>n.assessment==='review' || !n.detail_verified).map(n=>n.number);
    blockers.push(`Local navigation notice requires review${ids.length ? ': ' + ids.join(', ') : ''} (classification not confirmed)`);
  } else if (notices.status === 'caution_notice') {
    const ids=(notices.notices || []).filter(n=>n.assessment==='caution').map(n=>n.number);
    cautions.push(`Local navigation advisory${ids.length ? ': ' + ids.join(', ') : ''}`);
    passed.push('No blocking local notice found in recent Parks Victoria listing');
  } else if (notices.status === 'no_unresolved_in_recent_listing') {
    passed.push('No unresolved local notice found in recent Parks Victoria listing');
  } else missing.push('Resolved local notice state');

  const forecastAge = Number.isFinite(Date.parse(forecastCheckedAt)) ? Date.now()-Date.parse(forecastCheckedAt) : Infinity;
  if (forecastAge > FORECAST_MAX_AGE_MS) missing.push('Fresh local forecast');

  if (!point) missing.push('Forecast hour');
  else {
    const wind=num(point.wind), gust=num(point.gust), wave=num(point.wave_m), direction=num(point.direction);
    if (wind===null || gust===null || wave===null) missing.push('Wind, gust and wave forecast values');
    else {
      if (activity==='sailing' && wind < profile.wind.preferredMin) cautions.push(`Sustained wind ${wind.toFixed(1)} kn below preferred sailing range`);
      else assessMetric(wind, profile.wind, 'Sustained wind', 'kn', activity, blockers, cautions, passed);
      assessMetric(gust, profile.gust, 'Gusts', 'kn', activity, blockers, cautions, passed);
      assessMetric(wave, profile.wave, 'Modelled waves', 'm', activity, blockers, cautions, passed);

      const offshore = offshoreSector(direction);
      if (offshore && wind >= 15) blockers.push(`Strong offshore-component wind (${Math.round(direction)}° at ${wind.toFixed(1)} kn)`);
      else if (offshore && wind >= 8) cautions.push(`Offshore-component wind (${Math.round(direction)}° at ${wind.toFixed(1)} kn)`);

      // Compound-risk rule for fishing: modelled waves just below the standalone
      // hard threshold can still block when paired with near-hard wind/gusts or
      // meaningful offshore flow. This avoids a brittle 0.70/0.71 m cliff while
      // still becoming more conservative when several adverse factors coincide.
      if (activity==='fishing' && wave > 0.7 && wave <= profile.wave.hardMax) {
        const nearHardWind = wind > 14;
        const nearHardGust = gust > 19;
        const adverseOffshore = offshore && wind >= 12;
        if (nearHardWind || nearHardGust || adverseOffshore) {
          const factors=[];
          if (nearHardWind) factors.push(`wind ${wind.toFixed(1)} kn`);
          if (nearHardGust) factors.push(`gusts ${gust.toFixed(1)} kn`);
          if (adverseOffshore) factors.push('offshore-component wind');
          blockers.push(`Compound conditions: ${wave.toFixed(2)} m waves plus ${factors.join(' and ')}`);
        }
      }
    }
    if ([95,96,99].includes(point.weather_code)) blockers.push('Thunderstorm weather code forecast');
    if ((num(point.precipitation) ?? 0) >= 2) cautions.push('Heavy precipitation forecast');
    if (point.is_day === false) blockers.push('Outside daylight');
  }

  arrival_checks.push(site==='patterson-river'
    ? 'Verify Patterson River entrance, breaking waves, current and actual depth on arrival.'
    : 'Verify Carrum shore break, surf, wind and beach launch conditions on arrival.');

  const status = missing.length ? 'incomplete' : blockers.length ? 'blocked' : cautions.length ? 'marginal' : 'preferred';
  const labels = {
    incomplete:'Launch checks incomplete',
    blocked:'Automated launch checks failed',
    marginal:'Automated checks pass with cautions',
    preferred:'Automated launch checks passed'
  };

  return {
    site, activity, at:at || point?.time || null,
    status, label:labels[status],
    automated_checks_passed:status==='preferred'||status==='marginal',
    launch_verified:false,
    blockers, cautions, passed, missing, arrival_checks,
    thresholds:{wind:profile.wind,gust:profile.gust,wave:profile.wave},
    note:'Automated screening only — preference bands and provisional hard-block thresholds are not declarations that conditions are safe. Verify actual conditions at the launch site and on the water.'
  };
}
