import test from 'node:test';
import assert from 'node:assert/strict';
import { readRides, writeRide } from './folder-store.js';

function memoryFolder() {
  const files = new Map();
  const folder = {
    files,
    async getDirectoryHandle() { return folder; },
    async getFileHandle(name, options = {}) {
      if (!files.has(name)) {
        if (!options.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
        files.set(name, '');
      }
      return {
        async getFile() { return { text: async () => files.get(name) }; },
        async createWritable() {
          let next = files.get(name);
          return {
            async write(value) { next = value; },
            async close() { files.set(name, next); },
            async abort() {}
          };
        }
      };
    }
  };
  return folder;
}

test('chosen folder stores GPX and index without a server', async () => {
  const folder = memoryFolder();
  assert.deepEqual(await readRides(folder), []);
  const ride = { id: 'igps:123', source: 'igps', date: '2026-10-15', distance: 20000, duration: 0, polyline: 'abc' };
  const rides = await writeRide(folder, [], ride, '<gpx><trk/></gpx>');
  assert.equal(folder.files.get('123.gpx'), '<gpx><trk/></gpx>');
  assert.deepEqual(rides, [ride]);
  assert.deepEqual(await readRides(folder), [ride]);
  const updated = { ...ride, distance: 21000 };
  await writeRide(folder, rides, updated, '');
  assert.deepEqual(await readRides(folder), [updated]);
  assert.equal(folder.files.get('123.gpx'), '<gpx><trk/></gpx>');
});
