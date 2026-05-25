// TEMPORARY — remove after Slack alert confirmed
const { withErrorReporting } = require('./_lib/errorReporter');

module.exports = withErrorReporting(async (req, res) => {
  throw new Error('Test alert from AutoVal backend at ' + new Date().toISOString());
});
