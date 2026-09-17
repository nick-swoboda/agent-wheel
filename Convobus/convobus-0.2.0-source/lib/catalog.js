'use strict';

const raw = require('./provider-catalog.json');

function validateCatalog(value) {
  if (!value || value.catalogVersion !== 2) throw new Error('provider catalog version mismatch');
  if (!Array.isArray(value.seats) || !Array.isArray(value.providers)) {
    throw new Error('provider catalog is incomplete');
  }
  const seatIds = new Set();
  for (const seat of value.seats) {
    if (!seat || !seat.handle || seatIds.has(seat.handle)) throw new Error('provider catalog has duplicate seat');
    seatIds.add(seat.handle);
  }
  const routeIds = new Set();
  for (const provider of value.providers) {
    if (!provider || !provider.id || !provider.name || !Array.isArray(provider.routes)) {
      throw new Error('provider catalog has invalid provider');
    }
    for (const route of provider.routes) {
      const id = `${provider.id}/${route.surface}/${route.type}`;
      if (routeIds.has(id) || !seatIds.has(route.seat)) throw new Error(`provider catalog has invalid route ${id}`);
      routeIds.add(id);
    }
  }
  if (value.providers.length !== 4 || routeIds.size !== 11) throw new Error('provider catalog parity mismatch');
  return value;
}

const CATALOG = validateCatalog(raw);
const SEATS = CATALOG.seats.map((seat) => ({ ...seat }));
const PROVIDERS = CATALOG.providers.map((provider) => ({
  id: provider.id,
  name: provider.name,
  routes: provider.routes.map((route) => ({ ...route })),
}));
const LEGACY_SURFACES = CATALOG.legacySurfaces.map((surface) => ({ ...surface }));

module.exports = {
  CATALOG,
  SEATS,
  PROVIDERS,
  LEGACY_SURFACES,
  validateCatalog,
};
