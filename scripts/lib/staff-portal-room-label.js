'use strict';

/**
 * Staff portal — clean translated room gender labels (same category resolution as bed allocator).
 * @module staff-portal-room-label
 */

const { resolveRoomCategory } = require('./luna-bed-allocator');

const GENDER_I18N_KEY_BY_CATEGORY = Object.freeze({
  male_only: 'room.gender.male',
  female_only: 'room.gender.female',
  mixed: 'room.gender.flexible',
  matrimonial_or_mixed: 'room.gender.flexible',
  matrimonial_private_couple: 'room.gender.private',
  operator_surfweek: 'room.gender.flexible',
});

function portalRoomGenderI18nKey(room) {
  const cat = resolveRoomCategory(room || {});
  return GENDER_I18N_KEY_BY_CATEGORY[cat] || 'room.gender.flexible';
}

function isPortalOperatorRoom(room) {
  const r = room || {};
  const cat = resolveRoomCategory(r);
  if (cat === 'operator_surfweek') return true;
  return r.often_used_by_operator === true || r.often_used_by_operator === 'true';
}

/** @param {object} room @param {(key: string, vars?: object) => string} t */
function formatPortalRoomMetaLabel(room, t) {
  const parts = [t(portalRoomGenderI18nKey(room))];
  if (isPortalOperatorRoom(room)) parts.push(t('room.operator'));
  const cap = Number(room && room.capacity) || 0;
  if (cap > 0) parts.push(t('room.beds', { count: cap }));
  return parts.join(' · ');
}

function enrichPortalRoomRow(row) {
  const room = row || {};
  return {
    ...room,
    room_category: resolveRoomCategory(room),
    often_used_by_operator: room.often_used_by_operator === true
      || room.often_used_by_operator === 'true',
  };
}

module.exports = {
  GENDER_I18N_KEY_BY_CATEGORY,
  portalRoomGenderI18nKey,
  isPortalOperatorRoom,
  formatPortalRoomMetaLabel,
  enrichPortalRoomRow,
  resolveRoomCategory,
};
