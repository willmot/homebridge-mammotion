#!/usr/bin/env node
'use strict';

// Uses the production client for a read-only list/status check. It never calls
// command(), changes subscriptions, opens SSE or touches Homebridge state.
const { MammotionClient } = require('../dist/mammotion-client');

async function probeOfficialApi(credentialsPath) {
  if (!credentialsPath) {
    throw new Error('Usage: node scripts/probe-official-api.js /absolute/path/to/credentials.env');
  }
  const client = new MammotionClient({ info() {}, warn() {} }, { platform: 'Mammotion', apiCredentialsPath: credentialsPath });
  try {
    await client.start();
    const devices = await client.discoverDevices();
    const states = await client.pollStates();
    return {
      readOnly: true,
      mowerCount: devices.length,
      mowers: devices.map(device => {
        const state = states.find(item => item.name === device.name);
        return { model: device.model, firmware: state?.firmwareVersion, online: state?.online,
          status: state?.modeName, battery: state?.battery, chargeState: state?.chargeState };
      }),
    };
  } finally {
    await client.stop();
  }
}

if (require.main === module) {
  probeOfficialApi(process.argv[2])
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { probeOfficialApi };
