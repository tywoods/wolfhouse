'use strict';

/**
 * Carry the quote the guest agreed to onto the Wolfhouse save.
 *
 * The create body can arrive as package_none / shared after a private-room
 * quote (rooms 7 and 9 are private-optional, so inventory room type stays
 * shared while the quote still has the package and the private surcharge).
 * Only the accepted quote is the commercial record, and only when that quote
 * itself is a real package or a private room. An earlier offer must not
 * overwrite a shared package_none quote. €299 is the Malibu summer catalog
 * rate, so a package_none total or an accommodation-only label is not a
 * package. A mismatch is a staff warning. It never refuses the save.
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

function packageOnQuote(quote) {
  if (!quote || typeof quote !== 'object') return null;
  // An explicit package_none stays accommodation-only. Do not infer Malibu
  // from a catalog-rate total, an accommodation-only label, or a leftover offer.
  const explicit = String(quote.package_code || '').trim().toLowerCase();
  if (explicit && NO_PACKAGE.has(explicit)) return 'package_none';
  return commercialPackageCode(quote.package_code)
    || packageFromPeople(quote)
    || packageFromLines(quote);
}

function readAgreedCommercialTerms(body) {
  const quote = body && body.accepted_quote && typeof body.accepted_quote === 'object'
    ? body.accepted_quote : null;
  const empty = {
    packagePresent: false,
    packageCode: null,
    roomPresent: false,
    roomType: null,
    privateSale: false,
    quotePrivate: false,
    quote,
    carrier: null,
    money: null,
    supplementCents: 0,
  };
  if (!quote) return empty;
  const packageCode = packageOnQuote(quote);
  const packagePresent = packageCode != null;
  // Room type on the accepted quote is the only private signal. A supplement
  // line, selected_selling_mode, or the earlier offer must not flip the save.
  const quotePrivate = isPrivateText(quote.room_type) || isPrivateText(quote.room_preference);
  const explicitRoom = String(quote.room_type || quote.room_preference || '').trim().toLowerCase();
  const roomType = quotePrivate ? 'private' : (explicitRoom === 'shared' ? 'shared' : null);
  const roomPresent = roomType != null;
  if (!packagePresent && !roomPresent) return empty;
  const supplement = supplementCents(quote);
  return {
    packagePresent,
    packageCode,
    roomPresent,
    roomType,
    privateSale: quotePrivate || supplement > 0,
    quotePrivate,
    quote,
    carrier: quote,
    money: sourceMoney(quote),
    supplementCents: supplement,
  };
}

function projectGuestPackages(rows, packageCode) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => (row && typeof row === 'object'
    ? { ...row, package_code: packageCode }
    : row));
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
  if (!agreed.packagePresent && !agreed.roomPresent) return command;

  const notes = [];
  const currentPackage = commercialPackageCode(command.effectivePackageCode)
    || commercialPackageCode(command.storagePackageCode)
    || 'package_none';
  if (agreed.packagePresent && currentPackage !== agreed.packageCode) {
    notes.push(`Agreed package kept: ${agreed.packageCode} (save request had ${currentPackage}).`);
    addWarning(command, 'agreed_quote_package_kept');
  }
  if (agreed.packagePresent) {
    command.effectivePackageCode = agreed.packageCode;
    command.storagePackageCode = agreed.packageCode === 'package_none' ? null : agreed.packageCode;
    command.guestPackages = projectGuestPackages(command.guestPackages, agreed.packageCode);
    command.guestPackagesForQuote = projectGuestPackages(command.guestPackagesForQuote, agreed.packageCode);
    if (command.pkgCtx && typeof command.pkgCtx === 'object') {
      command.pkgCtx.isNoPackage = agreed.packageCode === 'package_none';
      command.pkgCtx.quotePackageCode = agreed.packageCode;
      command.pkgCtx.storagePackageCode = command.storagePackageCode;
      command.pkgCtx.guestPackagesForQuote = command.guestPackagesForQuote;
    }
  }

  const currentRoom = `${command.roomType || ''} ${command.roomPreference || ''}`;
  const currentRoomType = isPrivateText(currentRoom) ? 'private' : 'shared';
  if (agreed.roomPresent && currentRoomType !== agreed.roomType) {
    notes.push(`Agreed ${agreed.roomType} room kept (save request had ${currentRoomType}).`);
    addWarning(command, agreed.roomType === 'private'
      ? 'agreed_private_surcharge_kept' : 'agreed_shared_room_kept');
    command.roomType = agreed.roomType;
    command.roomPreference = agreed.roomType;
    command.agreedPrivateRestored = agreed.roomType === 'private';
  }

  const quote = ensureQuote(command, agreed.carrier);
  if (agreed.packagePresent) {
    quote.package_code = agreed.packageCode;
    quote.per_person = projectGuestPackages(quote.per_person, agreed.packageCode);
    quote.guest_packages = projectGuestPackages(quote.guest_packages, agreed.packageCode);
  }
  if (agreed.roomPresent) quote.room_type = agreed.roomType;
  const copiedPackage = agreed.packageCode !== 'package_none'
    && copyPackageLines(quote, agreed.carrier, agreed.packageCode);
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
