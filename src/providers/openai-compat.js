'use strict';
// Generic OpenAI-compatible provider (official APIs, aggregators, local LLM servers)
const makeGeneric = require('./_generic');
module.exports = makeGeneric.openaiCompat;
