'use strict';

/**
 * Carry the quote the guest agreed to onto the Wolfhouse save.
 *
 * The create body can arrive as package_none / shared after a private-room
 * quote (rooms 7 and 9 are private-optional, so inventory room type stays
 * shared while the quote still has the package and the private surcharge).
 * The accepted quote and accepted offer are the commercial record. A mismatch
 * is a staff warning. It never refuses the save.
 */

const { loadConfig } = require('./wolfhouse-quote-calculator');

const LUNA_CHANNEL = 'luna_whatsapp';
const WOLFHOUSE_SLUG = 'wolfhouse-somo';
const NO_PACKAGE = new Set([
  '', 'package_none', 'no_package', 'accommodation_only', 'accommodation-only', 'none',
]);
const PRIVATE_WORD = /\b(?:private|double|couple_private|private_room|matrimonial)\b/i;

let packageCatalog;

function catalog() {
  if (packageCatalog) return packageCatalog;
  try {
    const config = loadConfig();
    packageCatalog = (Array.isArray(config.packages) ? config.packages : [])
      .map((row) => ({
        code: String(row && row.code || '').trim().toLowerCase(),
        name: String(row && row.name || '').trim().toLowerCase(),
      }))
      .filter((row) => row.code && !row.code.startsWith('_'));
  } catch (_err) {
    packageCatalog = [];
  }
  return packageCatalog;
}

function commercialPackageCode(code) {
  const normalized = String(code || '').trim().toLowerCase();
  if (!normalized || NO_PACKAGE.has(normalized)) return null;
  return normalized.slice(0, 50);
}

function moneyCents(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function isPrivateText(value) {
  return PRIVATE_WORD.test(String(value || ''));
}

function lineItemsOf(source) {
  if (!source || typeof source !== 'object') return [];
  return []
    .concat(Array.isArray(source.line_items) ? source.line_items : [])
    .concat(Array.isArray(source.included_items) ? source.included_items : []);
}

function supplementCents(source) {
  return lineItemsOf(source).reduce((sum, line) => {
    if (!line || String(line.code || '') !== 'room_supplement') return sum;
    const cents = Number(line.total_cents);
    return sum + (Number.isFinite(cents) && cents > 0 ? cents : 0);
  }, 0);
}

function packageFromLines(source) {
  for (const line of lineItemsOf(source)) {
    if (!line || (line.code !== 'package' && line.code !== 'package_proration')) continue;
    const explicit = commercialPackageCode(line.package_code);
    if (explicit) return explicit;
    const label = String(line.label || '').trim().toLowerCase();
    const ranked = catalog().slice().sort((a, b) => b.name.length - a.name.length);
    for (const item of ranked) {
      if (item.name && (label === item.name || label.startsWith(`${item.name} `) || label.startsWith(`${item.name}(`))) {
        return item.code;
      }
    }
  }
  return null;
}

function packageFromPeople(source) {
  const rows = []
    .concat(Array.isArray(source && source.per_person) ? source.per_person : [])
    .concat(Array.isArray(source && source.guest_packages) ? source.guest_packages : []);
  const codes = [];
  for (const row of rows) {
    const code = commercialPackageCode(row && row.package_code);
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes.length === 1 ? codes[0] : null;
}

function sourceMoney(source) {
  if (!source || typeof source !== 'object') return null;
  const total = moneyCents(source.total_cents);
  if (total == null) return null;
  return {
    total_cents: total,
    deposit_required_cents: moneyCents(source.deposit_required_cents),
    payment_link_amount_cents: moneyCents(source.payment_link_amount_cents),
    balance_due_cents: moneyCents(source.balance_due_cents),
  };
}

function carriesAgreement(source, agreed) {
  if (!source || typeof source !== 'object') return false;
  const packageOk = !agreed.packageCode
    || commercialPackageCode(source.package_code) === agreed.packageCode
    || packageFromPeople(source) === agreed.packageCode
    || packageFromLines(source) === agreed.packageCode;
  const privateOk = !agreed.privateSale
    || supplementCents(source) > 0
    || isPrivateText(source.room_type)
    || isPrivateText(source.room_preference);
  return packageOk && privateOk;
}

function readAgreedCommercialTerms(body) {
  const quote = body && body.accepted_quote && typeof body.accepted_quote === 'object'
    ? body.accepted_quote : null;
  const offer = body && body.accepted_offer && typeof body.accepted_offer === 'object'
    ? body.accepted_offer : null;
  const sources = [quote, offer].filter(Boolean);
  let packageCode = null;
  for (const source of sources) {
    packageCode = commercialPackageCode(source.package_code)
      || packageFromPeople(source)
      || packageFromLines(source);
    if (packageCode) break;
  }
  const privateSale = sources.some((source) => supplementCents(source) > 0
    || isPrivateText(source.room_type)
    || isPrivateText(source.room_preference)
    || isPrivateText(source.selected_selling_mode));
  const carrier = sources.find((source) => carriesAgreement(source, { packageCode, privateSale }) && sourceMoney(source))
    || sources.find((source) => sourceMoney(source))
    || null;
  return {
    packageCode,
    privateSale,
    quote,
    offer,
    carrier,
    money: sourceMoney(carrier),
    supplementCents: sources.reduce((max, source) => Math.max(max, supplementCents(source)), 0),
  };
}

function appendNote(command, text) {
  const prev = String(command.notes || '').trim();
  if (prev.includes(text)) return;
  command.notes = prev ? `${prev}\n${text}` : text;
}

function addWarning(command, code) {
  if (!Array.isArray(command.bookingCheckWarnings)) command.bookingCheckWarnings = [];
  if (!command.bookingCheckWarnings.includes(code)) command.bookingCheckWarnings.push(code);
}

function ensureQuote(command, source) {
  if (!command.quote || typeof command.quote !== 'object') {
    command.quote = source ? { ...source } : {};
  }
  return command.quote;
}

function copyPackageLines(quote, source, packageCode) {
  if (!packageCode) return false;
  const incoming = lineItemsOf(source).filter((line) => (
    line && (line.code === 'package' || line.code === 'package_proration')
  ));
  if (!incoming.length) return false;
  const current = Array.isArray(quote.line_items) ? quote.line_items : [];
  const already = current.some((line) => line && (line.code === 'package' || line.code === 'package_proration'));
  if (already) return false;
  const rest = current.filter((line) => !line || !['accommodation_only', 'package', 'package_proration'].includes(line.code));
  quote.line_items = incoming.map((line) => ({ ...line })).concat(rest);
  return true;
}

function copySupplementLines(quote, source) {
  const incoming = lineItemsOf(source).filter((line) => line && line.code === 'room_supplement' && Number(line.total_cents) > 0);
  if (!incoming.length) return false;
  if (supplementCents(quote) > 0) return false;
  const kept = Array.isArray(quote.line_items)
    ? quote.line_items.filter((line) => !line || line.code !== 'room_supplement')
    : [];
  quote.line_items = kept.concat(incoming.map((line) => ({ ...line })));
  return true;
}

function patchPeople(quote, source, packageCode) {
  const sourcePeople = Array.isArray(source && source.per_person) ? source.per_person : null;
  const sourceHasSale = sourcePeople && sourcePeople.some((row) => (
    commercialPackageCode(row && row.package_code) || Number(row && row.supplement_cents) > 0
  ));
  if (sourceHasSale) {
    const current = Array.isArray(quote.per_person) ? quote.per_person : [];
    const already = current.some((row) => (
      (!packageCode || commercialPackageCode(row && row.package_code) === packageCode)
      && Number(row && row.supplement_cents) > 0
    ));
    if (!already) quote.per_person = sourcePeople.map((row) => ({ ...row }));
    return;
  }
  if (packageCode && Array.isArray(quote.per_person)) {
    for (const row of quote.per_person) {
      if (row && !commercialPackageCode(row.package_code)) row.package_code = packageCode;
    }
  }
}

/**
 * Mutates the create command so the saved package, room type, surcharge and
 * totals follow the accepted quote. Returns the same command. Never throws
 * and never signals a failed save.
 */
function applyAgreedQuoteIdentity(command) {
  if (!command || command.channel !== LUNA_CHANNEL || command.clientSlug !== WOLFHOUSE_SLUG) {
    return command;
  }
  const agreed = readAgreedCommercialTerms(command.transportBody || {});
  if (!agreed.packageCode && !agreed.privateSale) return command;

  const notes = [];
  const currentPackage = commercialPackageCode(command.effectivePackageCode)
    || commercialPackageCode(command.storagePackageCode);
  if (agreed.packageCode && currentPackage !== agreed.packageCode) {
    notes.push(`Agreed package kept: ${agreed.packageCode} (save request had ${currentPackage || 'package_none'}).`);
    addWarning(command, 'agreed_quote_package_kept');
    command.effectivePackageCode = agreed.packageCode;
    command.storagePackageCode = agreed.packageCode;
    if (command.pkgCtx && typeof command.pkgCtx === 'object') {
      command.pkgCtx.isNoPackage = false;
      command.pkgCtx.quotePackageCode = agreed.packageCode;
      command.pkgCtx.storagePackageCode = agreed.packageCode;
    }
  }

  const currentRoom = `${command.roomType || ''} ${command.roomPreference || ''}`;
  if (agreed.privateSale && !isPrivateText(currentRoom)) {
    notes.push('Agreed private room kept, including private-optional rooms 7 and 9.');
    addWarning(command, 'agreed_private_surcharge_kept');
    command.roomType = 'private';
    command.roomPreference = 'private';
    command.agreedPrivateRestored = true;
  }

  const quote = ensureQuote(command, agreed.carrier);
  if (agreed.packageCode) quote.package_code = agreed.packageCode;
  if (agreed.privateSale) quote.room_type = quote.room_type && isPrivateText(quote.room_type) ? quote.room_type : 'private';
  const copiedPackage = copyPackageLines(quote, agreed.carrier, agreed.packageCode);
  if (copiedPackage) addWarning(command, 'agreed_quote_package_kept');
  const copiedSupplement = copySupplementLines(quote, agreed.carrier);
  if (copiedSupplement) {
    notes.push(`Agreed private surcharge kept: ${supplementCents(quote)} cents.`);
    addWarning(command, 'agreed_private_surcharge_kept');
  }
  patchPeople(quote, agreed.carrier, agreed.packageCode);

  const money = agreed.money;
  if (money && moneyCents(command.totalCents) !== money.total_cents) {
    const previous = moneyCents(command.totalCents);
    if (previous != null && previous !== money.total_cents) {
      notes.push(`Agreed quote total kept: ${money.total_cents} cents (re-check had ${previous}).`);
      addWarning(command, 'agreed_quote_price_kept');
    }
    command.totalCents = money.total_cents;
    quote.total_cents = money.total_cents;
    if (money.deposit_required_cents != null) {
      command.depositCents = money.deposit_required_cents;
      command.sqlDepositCents = money.deposit_required_cents;
      quote.deposit_required_cents = money.deposit_required_cents;
    }
    if (money.payment_link_amount_cents != null) {
      command.paymentLinkAmountCents = money.payment_link_amount_cents;
      quote.payment_link_amount_cents = money.payment_link_amount_cents;
    }
    if (money.balance_due_cents != null) quote.balance_due_cents = money.balance_due_cents;
  }

  if (notes.length) appendNote(command, notes.join(' '));
  return command;
}

module.exports = {
  applyAgreedQuoteIdentity,
  readAgreedCommercialTerms,
  commercialPackageCode,
  supplementCents,
};
