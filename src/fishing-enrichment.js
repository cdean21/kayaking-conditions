// Marine enrichment is indicative only. Modelled sea level is NOT a local tide table.
export const MARINE_FIELDS = ['sea_surface_temperature','sea_level_height_msl'];
export function enrichMarine(hourly = {}) {
  const times = hourly.time || [];
  return times.map((time, i) => ({
    time: `${time}Z`,
    sea_surface_temp_c: hourly.sea_surface_temperature?.[i] ?? null,
    model_sea_level_msl_m: hourly.sea_level_height_msl?.[i] ?? null,
    provenance: 'Open-Meteo marine numerical model',
    tide_navigation_grade: false
  }));
}
export function temperatureSignal(speciesId, temp) {
  if (typeof temp !== 'number' || !Number.isFinite(temp)) return { adjustment:0, note:'No modelled sea temperature available' };
  // Deliberately weak, provisional associations; not calibrated to local catches.
  const ranges = {
    flathead:[14,22], calamari:[12,20], snapper:[16,23], whiting:[13,22], salmon:[12,19]
  };
  const range = ranges[speciesId];
  const adjustment = range && temp >= range[0] && temp <= range[1] ? 3 : -2;
  return { adjustment, note:'Weak heuristic based on modelled sea surface temperature; not a catch probability' };
}
export function tideEvidence() {
  return {
    verified_local_tide:false,
    reference:'BOM Victorian tide tables — Melbourne (Williamstown)',
    url:'https://www.bom.gov.au/oceanography/projects/ntc/vic_tide_tables.shtml',
    note:'Official tidal predictions must be checked separately. Do not treat model sea level as a Patterson River tide or entrance-current forecast.'
  };
}
