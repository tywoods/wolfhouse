'use strict';

/**
 * Unisex first-name guardrail only — server must NOT infer male/female from a static list.
 * Luna (gpt-5.5) infers solo gender from the name and passes room_preference on create;
 * groups use group_gender from the composition question.
 */

const UNISEX_NAMES = new Set([
  'alex', 'alexis', 'andrea', 'andy', 'ash', 'avery', 'cameron', 'casey', 'charlie',
  'chris', 'drew', 'eden', 'elliot', 'elliott', 'emerson', 'francis', 'frankie',
  'harper', 'jamie', 'jesse', 'jordan', 'jules', 'kai', 'kelly', 'kim', 'leslie',
  'logan', 'luca', 'lorenzo', 'morgan', 'nico', 'nicola', 'noel', 'pat', 'quinn',
  'renee', 'riley', 'robin', 'rowan', 'sam', 'sasha', 'shannon', 'sidney',
  'skyler', 'stevie', 'sydney', 'taylor', 'terry', 'toby', 'tony', 'tracy', 'val',
]);

module.exports = {
  UNISEX_NAMES,
};
