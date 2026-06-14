/**
 * Reusable Airtable Bookings table field schema fragments for generated update nodes.
 * Copied from a known-good node in the hosted Main export so n8n import does not flag stale option fields.
 */

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function pickSchemaFields(schema, fieldIds) {
  const byId = new Map((schema || []).map((field) => [field.id, clone(field)]));
  return fieldIds.map((id) => {
    const field = byId.get(id);
    if (!field) {
      throw new Error(`Airtable schema missing field: ${id}`);
    }
    return field;
  });
}

/**
 * @param {object} workflow - parsed Main workflow JSON
 * @param {string} sourceNodeName - node to copy field definitions from
 * @param {string[]} fieldIds - Airtable field ids to include
 */
function bookingsUpdateSchemaFromNode(workflow, sourceNodeName, fieldIds) {
  const source = workflow.nodes.find((n) => n.name === sourceNodeName);
  const schema = source?.parameters?.columns?.schema;
  if (!schema?.length) {
    throw new Error(`Cannot copy Airtable schema from ${sourceNodeName}`);
  }
  return pickSchemaFields(schema, fieldIds);
}

/** Payment Link only — Payment Status is set earlier on the hold (Apply Staged Contact / Create Hold). */
function stripePaymentLinkUpdateSchema(workflow) {
  return bookingsUpdateSchemaFromNode(workflow, 'Update Hold With Guest Details', [
    'id',
    'Payment Link',
  ]);
}

module.exports = {
  bookingsUpdateSchemaFromNode,
  stripePaymentLinkUpdateSchema,
};
