// Official notice intelligence is distinct from live entrance/launch verification.
export const NOTICES_SOURCE = 'https://www.parks.vic.gov.au/mariners-notices';
const MAX_AGE_MS = 6 * 3600000;
export function validateNoticePayload(body) {
  if (!body || body.source !== NOTICES_SOURCE || body.coverage !== 'recent_listing' || !Array.isArray(body.notices) || body.notices.length > 150) throw Error('Invalid Parks Victoria notice payload');
  if (!Number.isFinite(Date.parse(body.fetched_at)) || Math.abs(Date.now()-Date.parse(body.fetched_at))>15*60000) throw Error('Invalid notice fetch timestamp');
  const notices=body.notices.map(n=>{
    if(!n || !/^\d{1,4}(?:\(T\))?-20\d\d$/.test(n.number) || typeof n.title!=='string' || !n.title.trim() || n.title.length>300 || typeof n.url!=='string' || !n.url.startsWith('https://www.parks.vic.gov.au/mariners-notices/') || !Array.isArray(n.cancels) || n.cancels.length>30 || n.cancels.some(c=>!/^\d{1,4}(?:\(T\))?-20\d\d$/.test(c))) throw Error('Invalid notice item');
    return {number:n.number,title:n.title.trim(),url:n.url,cancels:n.cancels,category:['patterson','carrum','mordialloc','nearby'].includes(n.category)?n.category:'nearby',temporary:n.number.includes('(T)'),detail_verified:n.detail_verified===true,assessment:['blocking','caution','review','resolved'].includes(n.assessment)?n.assessment:'review'};
  });
  if(new Set(notices.map(n=>n.number)).size!==notices.length) throw Error('Duplicate notices');
  return {source:NOTICES_SOURCE,coverage:'recent_listing',fetched_at:new Date(body.fetched_at).toISOString(),notices};
}
export function assessNotices(snapshot,site='patterson-river') {
  if(!snapshot) return {status:'unavailable',label:'Local notices unavailable',launch_verified:false};
  if(Date.now()-Date.parse(snapshot.fetched_at)>MAX_AGE_MS) return {status:'stale',label:'Local notices out of date',launch_verified:false,checked_at:snapshot.fetched_at};
  const notices=snapshot.notices||[];
  const cancelled=new Set(notices.flatMap(n=>n.cancels));
  const relevant=notices.filter(n=>!cancelled.has(n.number) && (site==='patterson-river'?n.category==='patterson':['carrum','nearby'].includes(n.category)));
  const blocking=relevant.filter(n=>n.assessment==='blocking');
  const caution=relevant.filter(n=>n.assessment==='caution');
  const review=relevant.filter(n=>n.assessment==='review' || !n.detail_verified);
  const status=blocking.length?'blocking_notice':review.length?'review_required':caution.length?'caution_notice':'no_unresolved_in_recent_listing';
  const label=blocking.length?'Local navigation restriction/hazard requires review':review.length?'Review local navigation notices':caution.length?'Local navigation advisory':'No unresolved notices in recent listing';
  return {status,label,launch_verified:false,checked_at:snapshot.fetched_at,coverage:snapshot.coverage,notices:relevant,unresolved_count:blocking.length+review.length,caution_count:caution.length,blocking_count:blocking.length,note:'A recent notice listing cannot verify all extant notices, physical entrance depth, wave breaking, currents or on-water launch conditions.'};
}
export async function readLocalNotices(env,site='patterson-river') {
  const row=await env.DB.prepare('SELECT payload_json FROM tbl_local_notice_snapshots ORDER BY id DESC LIMIT 1').first();
  return assessNotices(row?JSON.parse(row.payload_json):null,site);
}
