// Automated launch screening. Preference bands help rank outings; hard gates remain conservative.
// This module never declares a launch or on-water conditions safe.
const FORECAST_MAX_AGE_MS = 6 * 3600000;
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const angular = d => ((d % 360) + 360) % 360;
const offshoreSector = deg => {
  if (num(deg) === null) return false;
  const d = angular(deg);
  // Carrum/Patterson River sit on Port Phillip's eastern shore. Winds FROM E/NE/SE have an offshore component.
  return d >= 45 && d <= 135;
};

// These are user preference / automated-screening bands, not universal safety limits.
const PROFILES = {
  fishing: {
    wind:{preferredMax:10, hardMax:15},
    gust:{preferredMax:15, hardMax:20},
    wave:{preferredMax:0.4, hardMax:0.7}
  },
  kayaking: {
    wind:{preferredMax:12, hardMax:15},
    gust:{preferredMax:16, hardMax:20},
    wave:{preferredMax:0.4, hardMax:0.7}
  },
  sailing: {
    wind:{preferredMin:8, preferredMax:20, marginalMin:5, hardMax:24},
    gust:{preferredMax:24, hardMax:28},
    wave:{preferredMax:0.7, hardMax:1.0}
  }
};

const describeBand = (label, value, unit, band, activity) => {
  if (band === 'preferred') return `${label} ${value} ${unit} within preferred ${activity} range`;
  if (band === 'marginal-low') return `${label} ${value} ${unit} below preferred ${activity} range`;
  if (band === 'marginal') return `${label} ${value} ${unit} outside preferred ${activity} range`;
  return `${label} ${value} ${unit} exceeds provisional ${activity} hard-block threshold`;
};

function upperBand(value, preferredMax, hardMax) {
  if (value <= preferredMax) return 'preferred';
  if (value <= hardMax) return 'marginal';
  return 'blocked';
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
  }
  else if (notices.status === 'review_required') {
    const ids=(notices.notices || []).filter(n=>n.assessment==='review' || !n.detail_verified).map(n=>n.number);
    blockers.push(`Local navigation notice requires review${ids.length ? ': ' + ids.join(', ') : ''} (classification not confirmed)`);
  }
  else if (notices.status === 'caution_notice') {
    const ids=(notices.notices || []).filter(n=>n.assessment==='caution').map(n=>n.number);
    cautions.push(`Local navigation advisory${ids.length ? ': ' + ids.join(', ') : ''}`);
    passed.push('No blocking local notice found in recent Parks Victoria listing');
  }
  else if (notices.status === 'no_unresolved_in_recent_listing') passed.push('No unresolved local notice found in recent Parks Victoria listing');
  else missing.push('Resolved local notice state');

  const forecastAge = Number.isFinite(Date.parse(forecastCheckedAt)) ? Date.now()-Date.parse(forecastCheckedAt) : Infinity;
  if (forecastAge > FORECAST_MAX_AGE_MS) missing.push('Fresh local forecast');
  if (!point) missing.push('Forecast hour');
  else {
    const wind=num(point.wind), gust=num(point.gust), wave=num(point.wave_m), direction=num(point.direction);
    if (wind===null || gust===null || wave===null) missing.push('Wind, gust and wave forecast values');
    else {
      let windBand;
      if (activity==='sailing' && wind < profile.wind.preferredMin) {
        windBand=wind < profile.wind.marginalMin ? 'blocked' : 'marginal-low';
      } else windBand=upperBand(wind,profile.wind.preferredMax,profile.wind.hardMax);
      const gustBand=upperBand(gust,profile.gust.preferredMax,profile.gust.hardMax);
      const waveBand=upperBand(wave,profile.wave.preferredMax,profile.wave.hardMax);

      const windText=describeBand('Sustained wind',wind.toFixed(1),'kn',windBand,activity);
      const gustText=describeBand('Gusts',gust.toFixed(1),'kn',gustBand,activity);
      const waveText=describeBand('Modelled waves',wave.toFixed(2),'m',waveBand,activity);
      (windBand==='blocked'?blockers:windBand==='preferred'?passed:cautions).push(windText);
      (gustBand==='blocked'?blockers:gustBand==='preferred'?passed:cautions).push(gustText);
      (waveBand==='blocked'?blockers:waveBand==='preferred'?passed:cautions).push(waveText);

      // Offshore wind increases return-to-shore consequences. Treat strong offshore flow as a hard gate.
      if (offshoreSector(direction) && wind >= 15) blockers.push(`Strong offshore-component wind (${Math.round(direction)}° at ${wind.toFixed(1)} kn)`);
      else if (offshoreSector(direction) && wind >= 8) cautions.push(`Offshore-component wind (${Math.round(direction)}° at ${wind.toFixed(1)} kn)`);
    }
    if ([95,96,99].includes(point.weather_code)) blockers.push('Thunderstorm weather code forecast');
    if ((num(point.precipitation) ?? 0) >= 2) cautions.push('Heavy precipitation forecast');
    if (point.is_day === false) blockers.push('Outside daylight');
  }

  arrival_checks.push(site==='patterson-river'
    ? 'Verify Patterson River entrance, breaking waves, current and actual depth on arrival.'
    : 'Verify Carrum shore break, surf, wind and beach launch conditions on arrival.');

  // A known hard blocker wins. Otherwise missing safety inputs fail closed as incomplete.
  const status = blockers.length ? 'blocked' : missing.length ? 'incomplete' : cautions.length ? 'marginal' : 'preferred';
  const labels = {
    incomplete:'Launch checks incomplete',
    blocked:'Automated launch checks failed',
    marginal:'Marginal / caution conditions',
    preferred:'Preferred conditions'
  };
  return {
    site, activity, at:at || point?.time || null, status, label:labels[status],
    automated_checks_passed:status==='preferred'||status==='marginal', launch_verified:false,
    blockers, cautions, passed, missing, arrival_checks,
    thresholds:profile,
    note:'Automated screening only — preference bands and provisional hard-block thresholds are not declarations that conditions are safe. Verify actual conditions at the launch site and on the water.'
  };
}
