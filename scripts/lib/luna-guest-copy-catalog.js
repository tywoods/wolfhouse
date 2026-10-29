'use strict';
const fs=require('fs'),path=require('path');
const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'../../docker/hermes-staging/wolfhouse/guest_copy.json'),'utf8')).locales;
const map={staySummary:'stay_summary',saveConfirmAsk:'save_confirm_solo',saveConfirmAskSolo:'save_confirm_solo',saveConfirmAskGroup:'save_confirm_group',paymentSplitAsk:'payment_split',nameAsk:'name_ask',handoff:'handoff',apology:'apology',fallback:'fallback'};
const COPY=Object.freeze(Object.fromEntries(Object.entries(raw).map(([locale,copy])=>[locale,Object.freeze({...copy,...Object.fromEntries(Object.entries(map).map(([key,value])=>[key,copy[value]]))})])));
function language(value){const key=String(value??'').trim().toLowerCase().replace('_','-').split('-')[0];return Object.prototype.hasOwnProperty.call(COPY,key)?key:'en'}
function guestCopy(value){return COPY[language(value)]}
function formatGuestMoney(cents,locale){if(typeof cents!=='number'||!Number.isFinite(cents)||!Number.isInteger(cents))return '';const value=cents/100,text=Number.isInteger(value)?String(value):value.toFixed(2).replace('.',language(locale)==='en'?'.':',');return language(locale)==='en'?`€${text}`:`${text} €`}
function formatGuestDate(value,locale){const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value||''));if(!match)return '';const date=new Date(Date.UTC(+match[1],+match[2]-1,+match[3]));if(date.getUTCFullYear()!==+match[1]||date.getUTCMonth()!==+match[2]-1||date.getUTCDate()!==+match[3])return '';return new Intl.DateTimeFormat(language(locale)==='es'?'es-ES':language(locale),{day:'numeric',month:'long',timeZone:'UTC'}).format(date)}
module.exports={COPY,guestCopy,formatGuestMoney,formatGuestDate,language};
