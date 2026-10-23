'use strict';

const { A11yCoreBuilder } = require('./A11yCoreBuilder');
const { formatFailures } = require('./formatFailures');
const {
  EngineError,
  ENGINE_ERROR_CODES,
  getScanGaps,
  getScanNotes,
  formatOccurrenceLocation,
  getGatingFailures,
  SEVERITIES
} = require('@surea11y/binding-base');

module.exports = {
  A11yCoreBuilder,
  formatFailures,
  EngineError,
  ENGINE_ERROR_CODES,
  getScanGaps,
  getScanNotes,
  formatOccurrenceLocation,
  getGatingFailures,
  SEVERITIES
};
