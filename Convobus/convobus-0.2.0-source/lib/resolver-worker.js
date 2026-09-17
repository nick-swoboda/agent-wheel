'use strict';

const { parentPort } = require('worker_threads');
const { resolveVendorSession } = require('./methods/filewins');

parentPort.on('message', (message) => {
  try {
    const value = resolveVendorSession(
      message.seat,
      message.project,
      message.home,
      { variant: message.variant || undefined },
    );
    parentPort.postMessage({ id: message.id, value });
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: String(error && error.message ? error.message : error) });
  }
});
