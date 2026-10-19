'use strict';
const fs=require('node:fs'); const {verifyRestore}=require('./caddy-import-inventory.cjs');
const [beforeFile,afterFile,...written]=process.argv.slice(2);
verifyRestore(JSON.parse(fs.readFileSync(beforeFile,'utf8')),JSON.parse(fs.readFileSync(afterFile,'utf8')),new Set(written));
console.log('PASS restored Caddy inventory');
