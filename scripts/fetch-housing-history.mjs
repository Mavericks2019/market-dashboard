import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHousingClient, makeHousingSnapshot } from '../housing-market.mjs'

// Regenerate the checked-in fallback only from a complete live provider response.
const fetchHistory = createHousingClient({ cacheFile: null, snapshotFile: null })
const result = await fetchHistory()
const directory = fileURLToPath(new URL('../data/', import.meta.url))
await mkdir(directory, { recursive: true })
await writeFile(new URL('../data/housing-history.json', import.meta.url), JSON.stringify(makeHousingSnapshot(result.cities, result.asOf * 1000)), 'utf8')
console.log(`Saved ${result.cities.length} cities, ${result.historyStart}–${result.latestMonth}, ${result.cities.reduce((total, city) => total + city.records.length, 0)} observations.`)
