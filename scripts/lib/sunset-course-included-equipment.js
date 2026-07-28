'use strict';

/** Pure domain helpers for course-included gear. Server code owns the flag. */
function deriveIncludedEquipment(course, serviceDates, participantCount) {
  if (!course || course.equipment_included !== true) return [];
  const quantity = Number(participantCount);
  if (!Number.isInteger(quantity) || quantity < 1) return [];
  const dates = [...new Set((serviceDates || []).map(String).filter(Boolean))];
  const out = [];
  for (const service_date of dates) {
    for (const component of ['surfboard', 'wetsuit']) {
      out.push({
        component,
        service_date,
        quantity,
        amount_cents: 0,
        metadata: { component, included_equipment: true, price_basis: 'included_in_course' },
      });
    }
  }
  return out;
}

/** Inventory is physical demand, not additive line-item demand. */
function combineEquipmentDemand({ included = 0, paidUpgrade = 0 } = {}) {
  return Math.max(0, Number(included) || 0, Number(paidUpgrade) || 0);
}

function includedEquipmentInvoiceLabel() {
  return 'Included equipment — surfboard + wetsuit (€0; included in course price)';
}

module.exports = { deriveIncludedEquipment, combineEquipmentDemand, includedEquipmentInvoiceLabel };
