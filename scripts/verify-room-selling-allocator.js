'use strict';
const assert=require('node:assert/strict');
const {runAvailabilityBedSelection,validateExplicitBedSelection}=require('./lib/luna-bed-allocator');
const beds=(mode='private',room='R1')=>[1,2,3].map(i=>({bed_code:`${room}-B${i}`,room_code:room,room_type:'female_only',gender_strategy:'Female preferred',capacity:3,can_be_matrimonial:false,often_used_by_operator:false,bed_active:true,bed_sellable:true,selling_mode:mode}));
const rows=beds();
for(const capacityOnly of [false,true])for(const useRules of [true,false]){
 const pick=runAvailabilityBedSelection({bedRows:rows,blockRows:[],guestCount:1,roomPreference:'private',groupGender:'unknown',capacityOnly,useRules});
 assert.deepEqual(pick.selected_bed_codes,['R1-B1'],'new private whole-room choice ignores gender without requesting it');
 assert.equal(pick.private_room,true,'selection carries exclusive-room semantics, not a shared bed');
 const shared=runAvailabilityBedSelection({bedRows:rows,blockRows:[],guestCount:1,roomPreference:'shared',groupGender:'female',capacityOnly,useRules});
 assert.deepEqual(shared.selected_bed_codes,[],'private rooms never enter bed-by-bed shared selection even with ranking rollback');
}
const explicit=validateExplicitBedSelection({selectedBedCodes:['R1-B2'],bedRows:rows,blockRows:[],guestCount:1,body:{room_preference:'private'}});
assert.equal(explicit.ok,true,'accepted private bed identity is retained without gender intake');
assert.equal(explicit.private_room,true);
console.log('PASS private automatic/rules-off/capacity-only/accepted selection uses whole room, no shared fallback');
for(const capacityOnly of [false,true]){
 const optional=beds('private_optional');
 const pick=runAvailabilityBedSelection({bedRows:optional,blockRows:[],guestCount:1,roomPreference:'private',capacityOnly});
 assert.deepEqual(pick.selected_bed_codes,['R1-B1'],'empty optional is privately offerable on explicit request');
 assert.equal(pick.private_room,true);
 for(const allowedBedCodes of [undefined,new Set(['R1-B1'])]){
  const busy=runAvailabilityBedSelection({bedRows:optional,blockRows:[{bed_code:'R1-B3',room_code:'R1'}],occupiedBedCodes:new Set(['R1-B3']),allowedBedCodes,guestCount:1,roomPreference:'private',capacityOnly});
  assert.deepEqual(busy.selected_bed_codes,[],'occupied sibling, including filtered-out sibling, forbids optional conversion and shared fallback');
 }
 const shared=runAvailabilityBedSelection({bedRows:optional,blockRows:[],guestCount:1,roomPreference:'shared',groupGender:'female',capacityOnly});
 assert.equal(shared.private_room,undefined);assert.equal(shared.selected_bed_codes.length,1);
 const exact=validateExplicitBedSelection({selectedBedCodes:['R1-B2'],bedRows:optional,blockRows:[],guestCount:1,body:{room_preference:'private'}});
 assert.equal(exact.ok,true);assert.equal(exact.private_room,true);
 assert.equal(validateExplicitBedSelection({selectedBedCodes:['R1-B2'],bedRows:optional,blockRows:[{bed_code:'R1-B3',room_code:'R1'}],guestCount:1,body:{room_preference:'private'}}).ok,false);
}
console.log('PASS optional explicit-only/private no fallback/all sibling occupancy/accepted selection');
module.exports={beds};
