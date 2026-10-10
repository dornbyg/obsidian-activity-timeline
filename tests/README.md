# Tests

`bigvault.test.js` builds a 10,000-note vault (with tasks, tags, `created` properties,
a "copied vault" day and a mass-sync day) plus two years of logs from two devices, then
runs the real plugin against small stand-ins for the Obsidian API and moment.js.

```
mkdir -p /tmp/atl/node_modules && cp -r tests/mocks/* /tmp/atl/node_modules/ && cp main.js tests/bigvault.test.js /tmp/atl/
cd /tmp/atl && TZ=America/New_York node bigvault.test.js ./main.js
```
