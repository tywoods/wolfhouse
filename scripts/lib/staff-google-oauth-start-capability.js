'use strict';

// Pin every intrinsic used by the registry before any caller can run. Authority
// is object identity in this module-private WeakMap, never caller-visible data.
const WeakMapConstructor = WeakMap;
const weakMapPrototype = WeakMapConstructor.prototype;
const weakMapGet = weakMapPrototype.get;
const weakMapSet = weakMapPrototype.set;
const weakMapDelete = weakMapPrototype.delete;
const reflectApply = Reflect.apply;
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const bindings = new WeakMapConstructor();

function mintStartCapability(gate, req, user) {
  const capability = objectFreeze(objectCreate(null));
  reflectApply(weakMapSet, bindings, [capability, { gate, req, user }]);
  return capability;
}

function consumeStartCapability(capability, gate, req, user) {
  const binding = reflectApply(weakMapGet, bindings, [capability]);
  if (!binding || binding.gate !== gate || binding.req !== req || binding.user !== user) return false;
  // One shot: revoke before granting authority. A failed revocation cannot pass.
  return reflectApply(weakMapDelete, bindings, [capability]) === true;
}

module.exports = objectFreeze({ mintStartCapability, consumeStartCapability });
