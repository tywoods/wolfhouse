'use strict';

// Server-internal capability registry. Authority is object identity in this
// module's WeakMap, never properties a caller can reconstruct or observe.
const bindings = new WeakMap();

function mintStartCapability(gate, req, user) {
  const capability = Object.freeze(Object.create(null));
  bindings.set(capability, { gate, req, user, consumed:false });
  return capability;
}

function consumeStartCapability(capability, gate, req, user) {
  const binding = bindings.get(capability);
  if (!binding || binding.consumed || binding.gate !== gate || binding.req !== req || binding.user !== user) return false;
  binding.consumed = true;
  return true;
}

module.exports = Object.freeze({ mintStartCapability, consumeStartCapability });
