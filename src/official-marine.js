export const BOM_FTP_HOST = 'ftp.bom.gov.au';
export const BOM_FTP_DIR = '/anon/gen/fwo';
export const BOM_WARNING_PRODUCT = 'IDV20600.xml';
export const BOM_PORT_PHILLIP_PRODUCT = 'IDV10460.xml';
export const BOM_PORT_PHILLIP_AAC = 'VIC_MW005';
export const BOM_MARINE_WARNINGS = 'https://www.bom.gov.au/marine/marine_warnings.shtml';
export const BOM_VIC_TIDES = 'https://www.bom.gov.au/oceanography/projects/ntc/vic_tide_tables.shtml';

const decode = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();
const tag = (xml,name) => decode(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i'))?.[1]);
const attr = (s,name) => decode(s.match(new RegExp(`${name}="([^"]*)"`,'i'))?.[1]);
const iso = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const textByType = (xml,type) => decode(xml.match(new RegExp(`<text\\s+[^>]*type="${type}"[^>]*>([\\s\\S]*?)<\\/text>`,'i'))?.[1]);

function assertBomProduct(xml, expectedId) {
  if (typeof xml !== 'string' || !/<product\b/i.test(xml)) throw new Error(`${expectedId}: invalid BOM XML`);
  if (tag(xml,'identifier') !== expectedId.replace('.xml','')) throw new Error(`${expectedId}: unexpected product identifier`);
  const issue = iso(tag(xml,'issue-time-utc'));
  const expiry = iso(tag(xml,'expiry-time'));
  if (!issue || !expiry) throw new Error(`${expectedId}: missing issue/expiry time`);
  return { issue_at:issue, expiry_at:expiry };
}

export function parseWarningProduct(xml, now = new Date()) {
  const meta = assertBomProduct(xml, 'IDV20600');
  const hazards = [...xml.matchAll(/<hazard\b([^>]*)>([\s\S]*?)<\/hazard>/gi)].map(([,attrs,body]) => {
    const areas = [...body.matchAll(/<area\b([^>]*)\/?\s*>/gi)].map(([,a]) => ({aac:attr(a,'aac'),description:attr(a,'description'),type:attr(a,'type')}));
    return {type:attr(attrs,'type'),severity:attr(attrs,'severity'),phase:attr(attrs,'phase'),phenomena:textByType(body,'warning_phenomena'),warning_areas:textByType(body,'warning_areas'),areas};
  });
  const relevant = hazards.filter(h => h.areas.some(a => a.aac === BOM_PORT_PHILLIP_AAC));
  const stale = now.getTime() > Date.parse(meta.expiry_at);
  return {
    source:'Bureau of Meteorology anonymous FTP — Victorian Marine Wind Warning Summary', product_id:'IDV20600', product_file:BOM_WARNING_PRODUCT,
    ...meta, stale, hazard_count:hazards.length, relevant_hazards:relevant, statewide_hazards:hazards,
    port_phillip_warning_active: relevant.length > 0,
    warning_gate: stale ? 'blocked_stale' : relevant.length ? 'blocked_active_warning' : 'pass_no_port_phillip_warning',
    full_warnings_url:BOM_MARINE_WARNINGS
  };
}

export function parsePortPhillipForecast(xml, now = new Date()) {
  const meta = assertBomProduct(xml, 'IDV10460');
  const areaMatch = xml.match(new RegExp(`<area\\s+[^>]*aac="${BOM_PORT_PHILLIP_AAC}"[^>]*>([\\s\\S]*?)<\\/area>`,'i'));
  if (!areaMatch) throw new Error('IDV10460: Port Phillip VIC_MW005 area missing');
  const periods = [...areaMatch[1].matchAll(/<forecast-period\b([^>]*)>([\s\S]*?)<\/forecast-period>/gi)].map(([,attrs,body]) => ({
    index:attr(attrs,'index'), start_at:iso(attr(attrs,'start-time-utc')), end_at:iso(attr(attrs,'end-time-utc')),
    winds:textByType(body,'forecast_winds'), seas:textByType(body,'forecast_seas'), weather:textByType(body,'forecast_weather')
  }));
  if (!periods.length || periods.some(p => !p.start_at || !p.end_at || !p.winds)) throw new Error('IDV10460: malformed Port Phillip forecast periods');
  return {source:'Bureau of Meteorology anonymous FTP — Port Phillip Local Waters Forecast',product_id:'IDV10460',product_file:BOM_PORT_PHILLIP_PRODUCT,...meta,stale:now.getTime()>Date.parse(meta.expiry_at),area_aac:BOM_PORT_PHILLIP_AAC,area:'Port Phillip',periods};
}

function verifiedNoWarningEvidence(evidence, now = new Date()) {
  if (!evidence || evidence.status !== 'verified_no_current_victorian_marine_warning') throw new Error('IDV20600 absent without verified no-warning evidence');
  if (evidence.state !== 'Victoria' || evidence.source_url !== BOM_MARINE_WARNINGS) throw new Error('Invalid Victorian marine warning evidence provenance');
  const checked = iso(evidence.checked_at);
  if (!checked) throw new Error('Invalid marine warning evidence timestamp');
  const age = now.getTime() - Date.parse(checked);
  if (age < -5 * 60 * 1000 || age > 30 * 60 * 1000) throw new Error('Marine warning evidence is not fresh');
  return {
    source:'Bureau of Meteorology Marine Warnings page',
    product_id:'IDV20600',
    product_file:BOM_WARNING_PRODUCT,
    product_published:false,
    checked_at:checked,
    stale:false,
    hazard_count:0,
    relevant_hazards:[],
    statewide_hazards:[],
    port_phillip_warning_active:false,
    warning_gate:'pass_verified_no_current_victorian_warning',
    full_warnings_url:BOM_MARINE_WARNINGS,
    evidence_status:evidence.status,
    note:'IDV20600 was not published. The official BOM Marine Warnings page independently confirmed no current marine warnings for Victoria.'
  };
}

export function buildOfficialMarineSnapshot(warningXml, forecastXml, now = new Date(), warningEvidence = null) {
  const warning = typeof warningXml === 'string' && warningXml.trim()
    ? parseWarningProduct(warningXml, now)
    : verifiedNoWarningEvidence(warningEvidence, now);
  const forecast = parsePortPhillipForecast(forecastXml, now);
  const stale = warning.stale || forecast.stale;
  return {
    status: stale ? 'stale' : warning.port_phillip_warning_active ? 'warning_active' : 'verified_no_port_phillip_warning',
    fetched_at: now.toISOString(),
    transport: warning.product_published === false ? 'BOM anonymous FTP + official Marine Warnings page via GitHub Actions' : 'BOM anonymous FTP via GitHub Actions',
    warning,
    forecast,
    positive_alert_gate: stale ? 'blocked' : warning.port_phillip_warning_active ? 'blocked' : 'warning_check_passed',
    note: warning.product_published === false
      ? 'The Port Phillip forecast was fetched from BOM FTP; because IDV20600 was not published, the official BOM Marine Warnings page separately confirmed no current Victorian marine warning. This warning gate does not by itself verify Patterson River entrance or live launch conditions.'
      : 'Official BOM products were fetched by the scheduled GitHub ingestion job and validated by kayaking-conditions. This warning gate does not by itself verify Patterson River entrance or live launch conditions.'
  };
}

export function validateTideEvents(events) {
  if (!Array.isArray(events) || events.length>100) throw new Error('Expected up to 100 tide events');
  return events.map(e => {
    if(e.reference_station!=='Melbourne (Williamstown)' || !['high','low'].includes(e.event_type) || typeof e.event_at!=='string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(e.event_at) || !Number.isFinite(Date.parse(e.event_at)) || typeof e.height_m!=='number' || !Number.isFinite(e.height_m) || e.height_m< -5 || e.height_m>10 || typeof e.datum!=='string' || !e.datum.trim() || e.datum.length>80 || e.source_name!=='BOM National Tidal Unit' || e.source_url!==BOM_VIC_TIDES || !Number.isInteger(e.source_year) || e.source_year<2026 || e.source_year>2100 || Number(new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Melbourne',year:'numeric'}).format(new Date(e.event_at)))!==e.source_year) throw new Error('Invalid tide event, timezone or provenance');
    return {...e,event_at:new Date(e.event_at).toISOString(),datum:e.datum.trim()};
  });
}
