'use strict';

const { packageIncludesForStay } = require('./wolfhouse-package-stay-price');

function stayNightsPhrase(nights) {
  const n = Number(nights);
  if (n === 1) return '1 night';
  if (Number.isInteger(n) && n > 1) return `${n} nights`;
  return null;
}

function stayDaysPhrase(nights) {
  const n = Number(nights);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n === 1 ? '1 day' : `${n} days`;
}

function accommodationPhrase(roomType, nights) {
  const stay = stayNightsPhrase(nights);
  if (!stay) return null;
  if (roomType === 'shared') return `${stay} in a shared room`;
  if (roomType === 'private') return `${stay} in a private room`;
  if (roomType === 'double') return `${stay} in a double room`;
  return `${stay} of accommodation`;
}

function rewriteDurationForStay(text, nights) {
  const phrase = stayDaysPhrase(nights);
  const raw = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw || !phrase) return raw;
  let out = raw
    .replace(/\bfor six days\b/gi, `for ${phrase}`)
    .replace(/\bfor 6 days\b/gi, `for ${phrase}`)
    .replace(/\b6 full days\b/gi, phrase.replace(/\bday(s)?\b/, 'full day$1'))
    .replace(/\bsix days\b/gi, phrase)
    .replace(/\b6 days\b/gi, phrase);
  if (/\b(surfboard|wetsuit|board|lesson)/i.test(out)
      && !/\b\d+\s+full\s+days?\b/i.test(out)
      && !/\b\d+\s+days?\b/i.test(out)
      && !/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\b/i.test(out)) {
    out = `${out} for ${phrase}`;
  }
  return out;
}

function rewriteDormForGuest(text) {
  let out = String(text == null ? '' : text);
  out = out.replace(/\bshared dorm beds\b/gi, 'shared rooms');
  out = out.replace(/\bshared dorm bed\b/gi, 'shared room');
  out = out.replace(/\bdorm beds\b/gi, 'shared rooms');
  out = out.replace(/\bdorm bed\b/gi, 'shared room');
  out = out.replace(/\bdorms\b/gi, 'shared rooms');
  out = out.replace(/\bdorm\b/gi, 'shared room');
  return out;
}

function guestIncludeText(text, nights) {
  return rewriteDormForGuest(rewriteDurationForStay(text, nights));
}

function codedIncludesLine(inclusions, nights, roomType) {
  if (!Array.isArray(inclusions) || inclusions.length === 0) return null;
  const labels = {
    shared_room: accommodationPhrase(roomType, nights),
    shirt: 'T-shirt',
    surfboard_6_days: 'surfboard',
    wetsuit_6_days: 'wetsuit',
    surf_lesson_each_day_6_days: 'surf lessons',
  };
  if (inclusions.some((code) => !Object.prototype.hasOwnProperty.call(labels, code) || !labels[code])) {
    return null;
  }
  const boardAndSuit = inclusions.includes('surfboard_6_days') && inclusions.includes('wetsuit_6_days');
  const parts = [];
  for (const code of inclusions) {
    if (boardAndSuit && code === 'wetsuit_6_days') continue;
    if (boardAndSuit && code === 'surfboard_6_days') {
      const phrase = stayDaysPhrase(nights);
      parts.push(phrase ? `board + wetsuit for ${phrase}` : 'board + wetsuit');
      continue;
    }
    parts.push(labels[code]);
  }
  return parts.length ? `Includes: ${parts.join(', ')}` : null;
}

function packageQuoteCopy(pkg, nights, roomType) {
  if (Array.isArray(pkg && pkg.includes)) {
    const package_includes = packageIncludesForStay(pkg, nights).map((row) => ({
      text: guestIncludeText(row.text, nights),
      full_stay_only: row.full_stay_only === true,
    }));
    return {
      package_includes,
      includes_line: package_includes.length
        ? `Includes: ${package_includes.map((row) => row.text).join(', ')}`
        : null,
    };
  }
  const inclusions = Array.isArray(pkg && pkg.inclusions) ? pkg.inclusions.slice() : null;
  if (!inclusions) return { includes_line: null };
  return {
    inclusions,
    includes_line: codedIncludesLine(inclusions, nights, roomType),
  };
}

/** Wording only. Never a save check and never a "shall I book?" question. */
function quoteTotalAndDepositLine(totalCents, depositCents) {
  const total = Number(totalCents);
  const deposit = Number(depositCents);
  if (!Number.isFinite(total) || !Number.isFinite(deposit)) return null;
  return `For those dates, the estimated total is €${(total / 100).toFixed(2)}. The deposit is €${(deposit / 100).toFixed(2)}.`;
}

function quoteIncludesShuttle(quote) {
  const rows = quote && quote.package_includes;
  if (!Array.isArray(rows)) return null;
  return rows.some((row) => /shuttle/i.test(String((row && row.text) || row || '')));
}

module.exports = {
  accommodationPhrase,
  rewriteDurationForStay,
  packageQuoteCopy,
  quoteTotalAndDepositLine,
  quoteIncludesShuttle,
};
