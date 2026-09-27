// ─── Temperature unit conversion ───────────────────────────────────────────────
// Triggered by reacting 🌡️ on a message mentioning a temperature. Recognises
// several common ways people actually write one: "75F", "75 F", "75°F",
// "75 degrees F", "75 deg. Fahrenheit", negative numbers, decimals. A number
// with no unit attached (just "75") never matches, the unit is what makes
// this unambiguous enough to trigger off of a reaction alone.
const TEMP_RE = /(-?\d+(?:\.\d+)?)\s*(?:°|deg(?:rees?)?\.?)?\s*(fahrenheit|celsius|f|c)\b/gi;

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Returns [{ original: '75°F', converted: '23.9°C' }, ...], one entry per
// distinct value+unit mentioned (a value repeated twice in the same message
// is only converted once).
export function parseTemperatures(content) {
  if (!content) return [];
  const seen = new Set();
  const results = [];
  TEMP_RE.lastIndex = 0;
  let m;
  while ((m = TEMP_RE.exec(content))) {
    const value = parseFloat(m[1]);
    if (!Number.isFinite(value)) continue;
    const unit = m[2][0].toLowerCase(); // first letter covers both "F"/"Fahrenheit" and "C"/"Celsius"
    const key  = `${value}${unit}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const converted     = unit === 'f' ? (value - 32) * 5 / 9 : (value * 9) / 5 + 32;
    const convertedUnit  = unit === 'f' ? 'C' : 'F';
    results.push({
      original:  `${round1(value)}°${unit.toUpperCase()}`,
      converted: `${round1(converted)}°${convertedUnit}`,
    });
  }
  return results;
}

// Fluxer channel type 5 is a real announcement channel. Name-based check
// covers the common case of a plain text channel just named/used as one
// (rules, server-info, #announcements as a regular channel type), where
// a drive-by temperature conversion reply would be out of place.
export function isTempConversionDisabledChannel(channel) {
  if (!channel) return false;
  if (channel.type === 5) return true;
  return /rule|info|announce/i.test(channel.name ?? '');
}
